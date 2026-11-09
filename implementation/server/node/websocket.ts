import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

// Server side of RFC 6455 for the Node adapter: handshake, framing, ping, close.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export const acceptKey = (clientKey: string): string => createHash("sha1").update(clientKey + GUID).digest("base64");

export type Frame = { fin: boolean; opcode: number; payload: Buffer };

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([header, payload]);
}

export class FrameError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// Reads frames from client chunks. Throws FrameError for protocol violations; the caller closes with that code.
export class FrameReader {
  private buffer = Buffer.alloc(0);
  private readonly maxPayload: number;
  constructor(maxPayload: number) {
    this.maxPayload = maxPayload;
  }

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      if ((b[0] & 0x70) !== 0) throw new FrameError(1002, "reserved bits set");
      const opcode = b[0] & 0x0f;
      if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new FrameError(1002, "unknown opcode");
      if ((b[1] & 0x80) === 0) throw new FrameError(1002, "client frame not masked");
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) break;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new FrameError(1009, "message too big");
        length = Number(big);
        offset = 10;
      }
      if (length > this.maxPayload) throw new FrameError(1009, "message too big");
      if (opcode >= 8 && (!fin || length > 125)) throw new FrameError(1002, "bad control frame");
      if (b.length < offset + 4 + length) break;
      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      frames.push({ fin, opcode, payload });
      this.buffer = b.subarray(offset + 4 + length);
    }
    return frames;
  }
}

// Codes an application may send in a close frame (the same rule as the WebSocket API).
export const validCloseCode = (code: number) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

export interface SocketHandlers {
  message(socket: NodeWebSocket, data: string | ArrayBuffer): void | Promise<void>;
  close(socket: NodeWebSocket, code: number, reason: string, clean: boolean): void | Promise<void>;
  error(socket: NodeWebSocket, error: unknown): void | Promise<void>;
}

// One WebSocket. It is created before the network connection exists (the room sends its first
// message before the response is returned) and attached to the connection afterwards.
export class NodeWebSocket {
  readyState = OPEN;
  private attachment: unknown = null;
  private queue: Buffer[] = [];
  private connection: Duplex | null = null;
  private reader: FrameReader;
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closeSent = false;
  handlers: SocketHandlers | null = null;
  // Set by the runtime when the socket is accepted by an object.
  tags: string[] = [];
  lastAutoResponse: Date | null = null;
  autoResponse: { request: string; response: string } | null = null;

  private maxPayload: number;
  constructor(maxPayload = 1 << 20) {
    this.maxPayload = maxPayload;
    this.reader = new FrameReader(maxPayload);
  }

  // The largest message accepted from the client; set before the connection is attached.
  setLimit(maxPayload: number): void {
    this.maxPayload = maxPayload;
    this.reader = new FrameReader(maxPayload);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value === undefined ? null : JSON.parse(JSON.stringify(value));
  }

  deserializeAttachment(): unknown {
    return this.attachment === null ? null : JSON.parse(JSON.stringify(this.attachment));
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== OPEN) throw new TypeError("WebSocket is not open");
    const frame = typeof message === "string" ? encodeFrame(1, Buffer.from(message)) : encodeFrame(2, Buffer.from(ArrayBuffer.isView(message) ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength) : new Uint8Array(message)));
    this.write(frame);
  }

  close(code = 1000, reason = ""): void {
    if (code !== 1005 && !validCloseCode(code)) throw new TypeError("invalid close code");
    if (this.readyState === CLOSED) return;
    this.sendClose(code === 1005 ? 1000 : code, reason);
    this.readyState = CLOSING;
  }

  private write(frame: Buffer): void {
    if (this.connection) this.connection.write(frame);
    else this.queue.push(frame);
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code);
    body.write(reason, 2);
    this.write(encodeFrame(8, body.subarray(0, 125)));
  }

  // Called once the HTTP upgrade has been answered.
  attach(connection: Duplex, leftover: Buffer): void {
    this.connection = connection;
    for (const frame of this.queue) connection.write(frame);
    this.queue = [];
    connection.on("data", (chunk: Buffer) => this.receive(chunk));
    connection.on("error", (error) => this.ended(1006, "", false, error));
    connection.on("close", () => this.ended(1006, "", false));
    if (leftover.length) this.receive(leftover);
    if (this.closeSent) this.finishSoon();
  }

  private receive(chunk: Buffer): void {
    if (this.readyState === CLOSED) return;
    let frames: Frame[];
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      this.fail(error instanceof FrameError ? error.code : 1002, error instanceof Error ? error.message : "protocol error", error);
      return;
    }
    for (const frame of frames) {
      if (this.readyState === CLOSED) return;
      this.frame(frame);
    }
  }

  private fail(code: number, reason: string, error?: unknown): void {
    this.sendClose(code, reason);
    this.ended(code, reason, false, error);
  }

  private frame({ fin, opcode, payload }: Frame): void {
    if (opcode === 9) return this.write(encodeFrame(10, payload));
    if (opcode === 10) return;
    if (opcode === 8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
      if (!this.closeSent) this.sendClose(code === 1005 ? 1000 : validCloseCode(code) ? code : 1002, "");
      this.ended(code, reason, true);
      return;
    }
    if (opcode === 0 && this.fragmentOpcode === 0) return this.fail(1002, "unexpected continuation");
    if (opcode !== 0) {
      if (this.fragmentOpcode !== 0) return this.fail(1002, "interleaved data frames");
      this.fragmentOpcode = opcode;
      this.fragments = [];
    }
    this.fragments.push(payload);
    if (this.fragments.reduce((sum, part) => sum + part.length, 0) > this.maxPayload) return this.fail(1009, "message too big");
    if (!fin) return;
    const data = Buffer.concat(this.fragments);
    const kind = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentOpcode = 0;
    if (kind === 1) {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return this.fail(1007, "invalid text"); }
      if (this.autoResponse && text === this.autoResponse.request) {
        this.lastAutoResponse = new Date();
        this.write(encodeFrame(1, Buffer.from(this.autoResponse.response)));
        return;
      }
      this.dispatch(() => this.handlers?.message(this, text));
    } else {
      this.dispatch(() => this.handlers?.message(this, data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer));
    }
  }

  // Handler failures are reported to the error handler and never stop the connection.
  private dispatch(call: () => void | Promise<void>): void {
    void (async () => {
      try { await call(); } catch (error) { try { await this.handlers?.error(this, error); } catch { /* the handler's own failure is dropped */ } }
    })();
  }

  private finishSoon(): void {
    const connection = this.connection;
    if (!connection) return;
    connection.end();
    setTimeout(() => connection.destroy(), 1000).unref();
  }

  private notified = false;
  // The connection ended (by close frame, protocol error or network): the close handler hears of it once.
  private ended(code: number, reason: string, clean: boolean, error?: unknown): void {
    if (this.notified) return;
    this.notified = true;
    this.readyState = CLOSED;
    this.dispatch(async () => {
      if (error) await this.handlers?.error(this, error);
      await this.handlers?.close(this, code, reason, clean);
    });
    this.finishSoon();
  }
}
