import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeWebSocket } from "./websocket.ts";

// A small stand-in for Cloudflare Durable Objects on one Node process: named single-instance
// objects with key-value storage on disk, one alarm each, and accepted WebSockets.

export type ObjectClass = new (ctx: any, env: any) => { fetch?(request: Request): Promise<Response> | Response; alarm?(): Promise<void> | void; webSocketMessage?(ws: NodeWebSocket, message: string | ArrayBuffer): Promise<void> | void; webSocketClose?(ws: NodeWebSocket, code: number, reason: string, wasClean: boolean): Promise<void> | void; webSocketError?(ws: NodeWebSocket, error: unknown): Promise<void> | void };

export interface Stub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
export interface Namespace {
  getByName(name: string, options?: unknown): Stub;
}

export class ObjectStorage {
  private values = new Map<string, string>();
  private alarmAt: number | null = null;
  private writing: Promise<void> = Promise.resolve();
  onAlarmChange: (at: number | null) => void = () => {};

  private readonly file: string | null;
  constructor(file: string | null) {
    this.file = file;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { storage: Record<string, string>; alarm: number | null };
      for (const [key, text] of Object.entries(saved.storage)) this.values.set(key, text);
      this.alarmAt = saved.alarm;
    }
  }

  get alarm(): number | null { return this.alarmAt; }

  // Values are kept as JSON text, so every read is a fresh copy and a non-JSON value is refused.
  private encode(value: unknown): string {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("storage values must be JSON");
    return text;
  }

  async get<T = unknown>(key: string | string[]): Promise<any> {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.values.has(k)).map((k) => [k, JSON.parse(this.values.get(k)!) as T]));
    const text = this.values.get(key);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, this.encode(value));
    else for (const [k, v] of Object.entries(key)) this.values.set(k, this.encode(v));
    this.persist();
  }

  async delete(key: string | string[]): Promise<any> {
    const keys = Array.isArray(key) ? key : [key];
    let count = 0;
    for (const k of keys) if (this.values.delete(k)) count++;
    this.persist();
    return Array.isArray(key) ? count : count > 0;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarmAt = null;
    this.onAlarmChange(null);
    this.persist();
  }

  async list(options: { prefix?: string } = {}): Promise<Map<string, unknown>> {
    return new Map([...this.values].filter(([k]) => k.startsWith(options.prefix ?? "")).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, JSON.parse(v)]));
  }

  async getAlarm(): Promise<number | null> { return this.alarmAt; }

  async setAlarm(at: number | Date): Promise<void> {
    this.alarmAt = at instanceof Date ? at.getTime() : at;
    this.onAlarmChange(this.alarmAt);
    this.persist();
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
    this.onAlarmChange(null);
    this.persist();
  }

  // Memory changes at once; the file follows in order, through a temporary file renamed into place.
  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const body = JSON.stringify({ storage: Object.fromEntries(this.values), alarm: this.alarmAt });
    this.writing = this.writing.then(() => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + ".tmp", body);
      renameSync(file + ".tmp", file);
    }).catch((error) => { console.error("storage write failed", error); });
  }

  flush(): Promise<void> { return this.writing; }

  destroy(): void {
    if (this.file) rmSync(this.file, { force: true });
  }
}

class ObjectState {
  readonly storage: ObjectStorage;
  private readonly sockets = new Set<NodeWebSocket>();
  ready: Promise<void> = Promise.resolve();
  private autoResponse: { request: string; response: string } | null = null;
  readonly name: string;
  private readonly owner: LiveObject;
  constructor(name: string, storage: ObjectStorage, owner: LiveObject) {
    this.name = name;
    this.storage = storage;
    this.owner = owner;
  }

  blockConcurrencyWhile(work: () => Promise<void>): Promise<void> {
    this.ready = this.ready.then(work);
    return this.ready;
  }
  abort(reason?: string): never {
    this.owner.evict();
    throw new Error(`Durable Object reset: ${reason ?? "aborted"}`);
  }
  waitUntil(_promise: Promise<unknown>): void {}
  setWebSocketAutoResponse(pair: { request: string; response: string } | null): void {
    this.autoResponse = pair;
    for (const ws of this.sockets) ws.autoResponse = pair;
  }
  getWebSocketAutoResponse(): { request: string; response: string } | null { return this.autoResponse; }
  getWebSocketAutoResponseTimestamp(ws: NodeWebSocket): Date | null { return ws.lastAutoResponse; }
  acceptWebSocket(ws: NodeWebSocket, tags: string[] = []): void {
    ws.tags = [...tags];
    ws.autoResponse = this.autoResponse;
    ws.handlers = this.owner.socketHandlers;
    this.sockets.add(ws);
  }
  getWebSockets(tag?: string): NodeWebSocket[] {
    return [...this.sockets].filter((ws) => ws.readyState <= 1 && (tag === undefined || ws.tags.includes(tag)));
  }
  getTags(ws: NodeWebSocket): string[] { return [...ws.tags]; }
  forget(ws: NodeWebSocket): void { this.sockets.delete(ws); }
  closeAll(code: number, reason: string): void {
    for (const ws of this.sockets) try { ws.close(code, reason); } catch { /* already closed */ }
  }
}

class LiveObject {
  readonly state: ObjectState;
  readonly instance: InstanceType<ObjectClass>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  evicted = false;
  readonly socketHandlers = {
    message: async (ws: NodeWebSocket, data: string | ArrayBuffer) => { await this.state.ready; await this.instance.webSocketMessage?.(ws, data); },
    close: async (ws: NodeWebSocket, code: number, reason: string, clean: boolean) => {
      try { await this.state.ready; await this.instance.webSocketClose?.(ws, code, reason, clean); } finally { this.state.forget(ws); }
    },
    error: async (ws: NodeWebSocket, error: unknown) => { await this.instance.webSocketError?.(ws, error); },
  };

  readonly runtime: ObjectRuntime;
  readonly name: string;
  constructor(runtime: ObjectRuntime, name: string, Class: ObjectClass, env: unknown, storage: ObjectStorage) {
    this.runtime = runtime;
    this.name = name;
    this.state = new ObjectState(name, storage, this);
    storage.onAlarmChange = (at) => this.arm(at);
    this.instance = new Class(this.state, env);
    this.arm(storage.alarm);
  }

  evict(): void {
    this.evicted = true;
    if (this.timer) clearTimeout(this.timer);
    this.runtime.drop(this);
    queueMicrotask(() => this.state.closeAll(1012, "restart"));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(at: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (at === null) return;
    // setTimeout holds at most about 24 days; a later alarm re-arms when it comes round.
    const wait = Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1);
    this.timer = setTimeout(() => void this.fire(at), wait);
    this.timer.unref?.();
  }

  private async fire(at: number): Promise<void> {
    if (this.evicted || this.state.storage.alarm !== at) return;
    if (Date.now() < at) return this.arm(at);
    await this.state.ready;
    await this.state.storage.deleteAlarm();
    try { await this.instance.alarm?.(); } catch (error) { console.error(`alarm failed in ${this.name}`, error); }
  }
}

export interface RuntimeOptions {
  // Folder for object files; null keeps everything in memory.
  dataDirectory: string | null;
}

// Hosts the namespaces of one process.
export class ObjectRuntime {
  private readonly live = new Map<string, LiveObject>();
  // Storage outlives the running object: an aborted object restarts onto the same storage.
  private readonly stores = new Map<string, ObjectStorage>();
  private readonly namespaces = new Map<string, { Class: ObjectClass; env: unknown }>();
  readonly options: RuntimeOptions;
  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  private file(namespace: string, name: string): string | null {
    return this.options.dataDirectory ? join(this.options.dataDirectory, namespace, Buffer.from(name).toString("base64url") + ".json") : null;
  }

  // The env given to the objects is read when each object is created, so bindings can refer to each other.
  namespace(namespace: string, Class: ObjectClass, env: () => unknown): Namespace {
    this.namespaces.set(namespace, { Class, env: env });
    return {
      getByName: (name: string) => ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (typeof name !== "string" || name === "") throw new TypeError("object name must be a nonempty string");
          const object = this.obtain(namespace, name);
          await object.state.ready;
          const request = input instanceof Request && init === undefined ? input : new Request(input, init);
          return (await object.instance.fetch?.(request)) ?? new Response("Not implemented", { status: 501 });
        },
      }),
    };
  }

  private obtain(namespace: string, name: string): LiveObject {
    const key = `${namespace}/${name}`;
    let object = this.live.get(key);
    if (!object) {
      const registered = this.namespaces.get(namespace)!;
      const env = typeof registered.env === "function" ? (registered.env as () => unknown)() : registered.env;
      let storage = this.stores.get(key);
      if (!storage) { storage = new ObjectStorage(this.file(namespace, name)); this.stores.set(key, storage); }
      object = new LiveObject(this, key, registered.Class, env, storage);
      this.live.set(key, object);
    }
    return object;
  }

  drop(object: LiveObject): void {
    if (this.live.get(object.name) === object) this.live.delete(object.name);
  }

  // Objects that were waiting on an alarm when the process last stopped are brought back so the alarm fires.
  resumeAlarms(): number {
    if (!this.options.dataDirectory) return 0;
    let resumed = 0;
    for (const namespace of this.namespaces.keys()) {
      const folder = join(this.options.dataDirectory, namespace);
      if (!existsSync(folder)) continue;
      for (const entry of readdirSync(folder)) {
        if (!entry.endsWith(".json")) continue;
        const name = Buffer.from(entry.slice(0, -5), "base64url").toString();
        const saved = JSON.parse(readFileSync(join(folder, entry), "utf8")) as { alarm: number | null };
        if (saved.alarm !== null) { this.obtain(namespace, name); resumed++; }
      }
    }
    return resumed;
  }

  async close(): Promise<void> {
    for (const object of this.live.values()) { object.stop(); object.state.closeAll(1001, "going away"); }
    await Promise.all([...this.stores.values()].map((storage) => storage.flush()));
    this.live.clear();
    this.stores.clear();
  }
}
