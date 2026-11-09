import { NodeWebSocket } from "./websocket.ts";

// The globals Workers code expects and Node does not provide: WebSocketPair, WebSocketRequestResponsePair,
// a Response that can carry status 101 with a socket, and a Request that streams a body without extra options.

export class WorkersWebSocketPair {
  0: NodeWebSocket;
  1: NodeWebSocket;
  constructor() {
    // One object stands for both ends: the one given to the runtime and the one returned in the response.
    const socket = new NodeWebSocket();
    this[0] = socket;
    this[1] = socket;
  }
}

export class WorkersWebSocketRequestResponsePair {
  readonly request: string;
  readonly response: string;
  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
}

const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;

class WorkersResponse extends NativeResponse {
  webSocket?: NodeWebSocket;
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: NodeWebSocket | null }) {
    if (init?.status === 101) {
      const { status: _status, webSocket, ...rest } = init;
      super(null, { ...rest, status: 200 });
      Object.defineProperty(this, "status", { value: 101, enumerable: true });
      Object.defineProperty(this, "ok", { value: false, enumerable: true });
      if (webSocket) this.webSocket = webSocket;
    } else {
      super(body, init);
    }
  }
}

class WorkersRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit & { duplex?: "half" }) {
    super(input, init && init.body != null && init.duplex === undefined ? { ...init, duplex: "half" } : init);
  }
}

let previous: { Response: typeof Response; Request: typeof Request; pair: unknown; auto: unknown } | null = null;

export function installGlobals(): () => void {
  if (previous) return uninstallGlobals;
  const g = globalThis as Record<string, unknown>;
  previous = { Response: g.Response as typeof Response, Request: g.Request as typeof Request, pair: g.WebSocketPair, auto: g.WebSocketRequestResponsePair };
  g.Response = WorkersResponse;
  g.Request = WorkersRequest;
  g.WebSocketPair = WorkersWebSocketPair;
  g.WebSocketRequestResponsePair = WorkersWebSocketRequestResponsePair;
  return uninstallGlobals;
}

export function uninstallGlobals(): void {
  if (!previous) return;
  const g = globalThis as Record<string, unknown>;
  g.Response = previous.Response;
  g.Request = previous.Request;
  if (previous.pair === undefined) delete g.WebSocketPair; else g.WebSocketPair = previous.pair;
  if (previous.auto === undefined) delete g.WebSocketRequestResponsePair; else g.WebSocketRequestResponsePair = previous.auto;
  previous = null;
}
