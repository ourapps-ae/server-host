import { DurableObject } from "cloudflare:workers";

// A tiny room service written only against the Workers API: named objects with storage, hibernating
// WebSockets with auto-replied pings, an alarm, and one object calling another. It stands in for the
// realtime-rooms service so the host can be checked without a game.

export type Env = { ROOM: any; DIRECTORY: any; CODE_VERSION?: string; WEB_ORIGINS?: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class Room extends DurableObject<Env> {
  count = 0;
  constructor(ctx: any, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => { this.count = (await ctx.storage.get("count")) ?? 0; });
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "badRequest" }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["viewer"]);
      pair[1].send(JSON.stringify({ type: "count", count: this.count }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/add" && request.method === "POST") {
      const body = (await request.json()) as { by?: number };
      await this.change(this.count + (body.by ?? 1));
      return json({ count: this.count });
    }
    if (url.pathname === "/echo" && request.method === "POST") return new Response(request.body, { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/later" && request.method === "POST") { await this.ctx.storage.setAlarm(Date.now() + 60); return json({ ok: true }); }
    if (url.pathname === "/reset") this.ctx.abort("reset");
    return json({ count: this.count, lastClose: (await this.ctx.storage.get("lastClose")) ?? null });
  }
  async alarm() { await this.change(this.count + 100); }
  async webSocketMessage(ws: any, message: string | ArrayBuffer) {
    if (message === "add") await this.change(this.count + 1);
    else if (typeof message !== "string") ws.send(message);
    else if (message === "bye") ws.close(1000, "done");
  }
  async webSocketClose(ws: any, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, "closing"); } catch { /* already closed */ }
    await this.ctx.storage.put("lastClose", code);
  }
  private async change(count: number) {
    this.count = count;
    await this.ctx.storage.put("count", count);
    for (const ws of this.ctx.getWebSockets("viewer")) try { ws.send(JSON.stringify({ type: "count", count })); } catch { /* closed */ }
    await this.env.DIRECTORY.getByName("home").fetch("https://directory/", { method: "POST", body: JSON.stringify({ id: "one", count }), headers: { "x-code-version": this.env.CODE_VERSION ?? "" } });
  }
}

export class Directory extends DurableObject<Env> {
  rooms: Record<string, unknown> = {};
  constructor(ctx: any, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.rooms = (await ctx.storage.get("rooms")) ?? {}; });
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const entry = (await request.json()) as { id: string };
      this.rooms[entry.id] = entry;
      await this.ctx.storage.put("rooms", this.rooms);
      return new Response(null, { status: 204 });
    }
    return json(Object.values(this.rooms));
  }
}

export const service = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowed = !!origin && (env.WEB_ORIGINS ?? "").split(",").includes(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: allowed ? { "access-control-allow-origin": origin! } : {} });
    if (url.pathname === "/health") return json({ ok: true, origin: allowed ? origin : null });
    if (url.pathname === "/rooms") return env.DIRECTORY.getByName("home").fetch("https://directory/");
    const match = url.pathname.match(/^\/r\/([a-z-]+)(\/.*)$/);
    if (match) {
      url.pathname = match[2];
      return env.ROOM.getByName(match[1]).fetch(new Request(url, { method: request.method, headers: request.headers, body: request.body }));
    }
    return json({ error: "badRequest" }, 404);
  },
};
