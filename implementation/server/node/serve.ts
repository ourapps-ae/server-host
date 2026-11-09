import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { acceptKey, NodeWebSocket } from "./websocket.ts";
import { ObjectRuntime, type ObjectClass } from "./runtime.ts";

export interface NodeServeOptions {
  // The worker: anything with fetch(request, env), usually the entry from createEntry.
  entry: { fetch(request: Request, env: any): Promise<Response> };
  // Durable Object classes by binding name, for example { ROOM: Room, DIRECTORY: Directory }.
  objects: Record<string, ObjectClass>;
  // Plain variables the worker and objects read, for example CODE_VERSION, WEB_ORIGINS, POLL_MS.
  variables?: Record<string, string>;
  port?: number;
  host?: string;
  // Where object storage is kept; null keeps it in memory only.
  dataDirectory?: string | null;
  maxMessageBytes?: number;
}

export interface RunningNodeServer {
  port: number;
  host: string;
  runtime: ObjectRuntime;
  close(): Promise<void>;
}

const HOST_PATTERN = /^[A-Za-z0-9.\-:[\]]{1,255}$/;

function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host && HOST_PATTERN.test(req.headers.host) ? req.headers.host : "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") { init.body = Readable.toWeb(req) as unknown as ReadableStream; init.duplex = "half"; }
  return new Request(new URL(req.url ?? "/", `http://${host}`), init);
}

function statusLine(status: number, text: string): string {
  return `HTTP/1.1 ${status} ${text.replace(/[\r\n]/g, " ")}\r\n`;
}

async function refuse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  let head = statusLine(response.status, response.statusText || "Error");
  for (const [name, value] of response.headers) if (!["content-length", "connection", "transfer-encoding"].includes(name)) head += `${name}: ${value}\r\n`;
  head += `content-length: ${body.length}\r\nconnection: close\r\n\r\n`;
  socket.end(Buffer.concat([Buffer.from(head), body]));
}

export async function serveNode(options: NodeServeOptions): Promise<RunningNodeServer> {
  const runtime = new ObjectRuntime({ dataDirectory: options.dataDirectory ?? null });
  const env: Record<string, unknown> = { ...(options.variables ?? {}) };
  for (const [binding, Class] of Object.entries(options.objects)) env[binding] = runtime.namespace(binding, Class, () => env);
  runtime.resumeAlarms();

  const server: Server = createServer(async (req, res) => {
    try {
      const response = await options.entry.fetch(toRequest(req), env);
      const headers: [string, string][] = [];
      for (const [name, value] of response.headers) if (name !== "set-cookie") headers.push([name, value]);
      for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
      res.writeHead(response.status, response.statusText, headers.flat() as unknown as string[]);
      if (!response.body || req.method === "HEAD") return void res.end();
      const stream = Readable.fromWeb(response.body as never);
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      console.error("request failed", error);
      if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "badRequest", message: "Server error." })); }
      else res.destroy();
    }
  });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    try {
      const key = req.headers["sec-websocket-key"];
      const ok = req.headers.upgrade?.toLowerCase() === "websocket" && req.headers["sec-websocket-version"] === "13" && typeof key === "string" && Buffer.from(key, "base64").length === 16;
      if (!ok) return void socket.end(statusLine(400, "Bad Request") + "connection: close\r\ncontent-length: 0\r\n\r\n");
      const response = (await options.entry.fetch(toRequest(req), env)) as Response & { webSocket?: NodeWebSocket };
      if (response.status !== 101 || !response.webSocket) return await refuse(socket, response);
      const websocket = response.webSocket;
      websocket.setLimit(options.maxMessageBytes ?? 1 << 20);
      let reply = statusLine(101, "Switching Protocols") + `upgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(key as string)}\r\n`;
      for (const [name, value] of response.headers) if (!["upgrade", "connection", "sec-websocket-accept", "content-length"].includes(name)) reply += `${name}: ${value}\r\n`;
      socket.write(reply + "\r\n");
      websocket.attach(socket, head);
    } catch (error) {
      console.error("upgrade failed", error);
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    host: address.address,
    runtime,
    async close() {
      await runtime.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
