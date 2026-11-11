import "../implementation/server/node/register.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServerHost, createServerHostFromHostSettings, createEntry, deployFiles, originAllowed, parseOrigins, regionEnv, renderNodeStart, renderWrangler, validateSettings, SettingsError, fromHostSettings, NO_ACCOUNT, DEFAULT_ORIGIN, type HostSettings, type ServerSettings } from "../implementation/server/host.ts";
import { configuration, substitute, TemplateError, type Declaration } from "./render-template.ts";
import { serveNode, type RunningNodeServer } from "../implementation/server/node/serve.ts";
import { FrameError, FrameReader, acceptKey, encodeFrame } from "../implementation/server/node/websocket.ts";
import { exportStorage, importStorage, readStorage, verifyStorage, writeStorage, type ObjectRecord } from "../implementation/server/node/storage-export.ts";
// Modules written for Workers load only after the register import above has run.
const { buildWorker } = await import("../examples/worker.ts");

const fixture = JSON.parse(readFileSync(new URL("fixtures/settings.json", import.meta.url), "utf8"));
const [free, paid, own] = fixture.valid as ServerSettings[];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const maskedFrame = (opcode: number, payload: Buffer, fin = true, mask = Buffer.from([1, 2, 3, 4])) => {
  const body = Buffer.from(payload).map((byte, i) => byte ^ mask[i & 3]);
  const length = body.length;
  const head = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length]) : length < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, length >> 8, length & 255]) : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([head, mask, body]);
};

// ---- settings ----

test("valid settings resolve to the right adapter for each provider", () => {
  assert.equal(validateSettings(free).adapter, "cloudflare");
  assert.equal(validateSettings(paid).adapter, "cloudflare");
  assert.equal(validateSettings(own).adapter, "node");
  assert.deepEqual(validateSettings(paid).allowedOrigins, ["https://app.example.com", "http://localhost:5173"]);
  assert.equal(validateSettings(own).region, "any");
  assert.equal(validateSettings(own).accountReference, null);
  assert.equal(validateSettings(free).accountReference, "cloudflare/account");
});

test("invalid settings are refused with a message that names the setting", () => {
  for (const [settings, word] of fixture.invalid) assert.throws(() => validateSettings(settings), (error: Error) => error instanceof SettingsError && error.message.includes(word), JSON.stringify(settings));
});

test("origins are normalised, deduplicated and limited to https or loopback http", () => {
  assert.deepEqual(parseOrigins("https://A.example.com https://a.example.com  http://127.0.0.1:3000"), ["https://a.example.com", "http://127.0.0.1:3000"]);
  assert.deepEqual(parseOrigins(undefined), []);
  assert.throws(() => parseOrigins("https://example.com:99999"), SettingsError);
});

test("the room service settings carry the origins and prefix", () => {
  assert.deepEqual(createServerHost(paid).roomsSettings(), { applicationId: "demo", allowedOrigins: ["https://app.example.com", "http://localhost:5173"], roomPrefix: "demo-" });
});

// ---- entry and region ----

test("origin policy: listed, pattern, loopback and WEB_ORIGINS", () => {
  const settings = validateSettings(free);
  assert.ok(originAllowed("https://app.example.com", settings));
  assert.ok(!originAllowed("https://evil.example.com", settings));
  assert.ok(!originAllowed(null, settings));
  assert.ok(originAllowed("http://localhost:8080", settings));
  assert.ok(!originAllowed("http://localhost:8080", settings, "", { allowLoopback: false }));
  assert.ok(originAllowed("https://abc123.hosted.example", settings, "", { originPatterns: [/^https:\/\/[0-9a-f]{6}\.hosted\.example$/] }));
  assert.ok(originAllowed("https://other.example.com", settings, "https://x.example.com, https://other.example.com"));
});

test("the entry adds an accepted origin to WEB_ORIGINS and leaves other requests alone", async () => {
  const seen: any[] = [];
  const entry = createEntry({ fetch: async (_request, env) => { seen.push(env); return new Response("ok"); } }, validateSettings(free));
  await entry.fetch(new Request("https://s.example/", { headers: { origin: "https://app.example.com" } }), { WEB_ORIGINS: "https://first.example.com" });
  await entry.fetch(new Request("https://s.example/", { headers: { origin: "https://evil.example.com" } }), { WEB_ORIGINS: "https://first.example.com" });
  await entry.fetch(new Request("https://s.example/"), {});
  assert.equal(seen[0].WEB_ORIGINS, "https://first.example.com,https://app.example.com");
  assert.equal(seen[1].WEB_ORIGINS, "https://first.example.com");
  assert.equal(seen[2].WEB_ORIGINS, undefined);
});

test("jurisdiction and location hints place objects; any leaves them alone", () => {
  const calls: unknown[] = [];
  const namespace = { getByName: (name: string, options?: unknown) => { calls.push(["plain", name, options]); return "stub"; }, jurisdiction(region: string) { calls.push(["jurisdiction", region]); return { getByName: (name: string) => `eu:${name}` }; } };
  const env = { ROOM: namespace, DIRECTORY: namespace, OTHER: "x" };
  assert.equal(regionEnv(env, "any"), env);
  const eu = regionEnv(env, "eu");
  assert.equal(eu.ROOM.getByName("a"), "eu:a");
  assert.equal(eu.OTHER, "x");
  const hinted = regionEnv(env, "weur");
  hinted.ROOM.getByName("b");
  hinted.ROOM.getByName("c", { retry: 1 });
  assert.deepEqual(calls.filter((call: any) => call[0] === "plain"), [["plain", "b", { locationHint: "weur" }], ["plain", "c", { locationHint: "weur", retry: 1 }]]);
  assert.throws(() => regionEnv(env, "mars"), /unknown region/);
});

test("objectClass places the env of an object class in the configured region", () => {
  const host = createServerHost(paid);
  let received: any;
  class Base { constructor(_ctx: unknown, env: any) { received = env; } }
  const Placed = host.objectClass(Base);
  new Placed({}, { ROOM: { getByName: () => "stub", jurisdiction: () => ({ getByName: () => "eu-stub" }) } });
  assert.equal(received.ROOM.getByName("x"), "eu-stub");
  assert.equal(createServerHost(free).objectClass(Base), Base);
  assert.equal(createServerHost(own).objectClass(Base), Base);
});

// ---- deployment files ----

const wranglerOf = (settings: ServerSettings, options = {}) => JSON.parse(renderWrangler(validateSettings(settings), options).split("\n").filter((line) => !line.startsWith("//")).join("\n"));

test("wrangler configuration has SQLite-backed objects, the origins and no account value", () => {
  const text = renderWrangler(validateSettings(free));
  const config = wranglerOf(free);
  assert.equal(config.name, "demo-server");
  assert.deepEqual(config.durable_objects.bindings.map((b: any) => b.name), ["ROOM", "DIRECTORY"]);
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["Room", "Directory"] }]);
  assert.equal(config.vars.WEB_ORIGINS, "https://app.example.com");
  assert.ok(!("account_id" in config));
  assert.match(text, /secret reference cloudflare\/account/);
  assert.equal(config.limits, undefined);
});

test("CPU limit only on the paid plan and within range", () => {
  assert.equal(wranglerOf(paid, { cpuMilliseconds: 120000 }).limits.cpu_ms, 120000);
  assert.throws(() => wranglerOf(free, { cpuMilliseconds: 50 }), /only on cloudflare-paid/);
  assert.throws(() => wranglerOf(paid, { cpuMilliseconds: 400000 }), /up to 300000/);
});

test("deployment files differ by adapter and refuse bad options", () => {
  assert.deepEqual(Object.keys(deployFiles(validateSettings(free))).sort(), ["deploy.sh", "package.json", "wrangler.jsonc"]);
  assert.deepEqual(Object.keys(deployFiles(validateSettings(own))).sort(), ["package.json", "start.ts"]);
  assert.throws(() => renderWrangler(validateSettings(own)), SettingsError);
  assert.throws(() => renderNodeStart(validateSettings(free)), SettingsError);
  assert.throws(() => wranglerOf(free, { workerName: "Bad Name" }), SettingsError);
  assert.throws(() => wranglerOf(free, { main: "../../etc/x; rm" }), SettingsError);
  assert.throws(() => wranglerOf(free, { objects: [{ binding: "A B", className: "X" }] }), SettingsError);
  assert.throws(() => wranglerOf(free, { variables: { lower: "x" } }), SettingsError);
});

test("deploy script reads the account from the environment and holds no value", () => {
  const script = deployFiles(validateSettings(free))["deploy.sh"];
  assert.match(script, /CLOUDFLARE_ACCOUNT_ID:\?/);
  assert.match(script, /CLOUDFLARE_API_TOKEN:\?/);
  assert.match(script, /exec npx wrangler deploy/);
  assert.doesNotMatch(script, /[0-9a-f]{32}/);
});

test("start script for own hardware names the objects and the data folder", () => {
  const start = deployFiles(validateSettings(own))["start.ts"];
  assert.match(start, /objects: \{ ROOM: app.Room, DIRECTORY: app.Directory \}/);
  assert.match(start, /process.env.DATA_DIRECTORY \?\? "\.\/data"/);
  assert.match(start, /node\/register.ts/);
});

// ---- WebSocket framing ----

test("accept key follows RFC 6455", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("frames: short, medium and long payloads, split chunks, several frames in one chunk", () => {
  const reader = new FrameReader(1 << 20);
  const long = Buffer.alloc(70000, 7);
  const medium = Buffer.alloc(300, 5);
  const wire = Buffer.concat([maskedFrame(1, Buffer.from("hello")), maskedFrame(2, medium), maskedFrame(2, long)]);
  const frames = [...reader.push(wire.subarray(0, 3)), ...reader.push(wire.subarray(3, 400)), ...reader.push(wire.subarray(400))];
  assert.deepEqual(frames.map((f) => [f.opcode, f.payload.length]), [[1, 5], [2, 300], [2, 70000]]);
  assert.equal(frames[0].payload.toString(), "hello");
  assert.ok(frames[2].payload.equals(long));
});

test("frames: unmasked, reserved bits, unknown opcode, oversize and fragmented control frames are protocol errors", () => {
  const code = (bytes: Buffer, max = 1000) => { try { new FrameReader(max).push(bytes); } catch (error) { return (error as FrameError).code; } return 0; };
  assert.equal(code(Buffer.from([0x81, 0x01, 0x41])), 1002);
  assert.equal(code(Buffer.concat([Buffer.from([0xc1, 0x80]), Buffer.alloc(4)])), 1002);
  assert.equal(code(Buffer.concat([Buffer.from([0x83, 0x80]), Buffer.alloc(4)])), 1002);
  assert.equal(code(maskedFrame(1, Buffer.alloc(2000)), 1000), 1009);
  assert.equal(code(maskedFrame(9, Buffer.from("x"), false)), 1002);
  assert.equal(encodeFrame(1, Buffer.from("hi")).toString("hex"), "810268" + "69");
});

// ---- the Node adapter running a Workers-style service ----

async function start(settings: ServerSettings = own, dataDirectory: string | null = null): Promise<RunningNodeServer & { base: string; url: (path: string) => string }> {
  const { Room, Directory, entry } = buildWorker(settings);
  const server = await serveNode({ entry, objects: { ROOM: Room, DIRECTORY: Directory }, variables: { CODE_VERSION: "t" }, dataDirectory });
  return Object.assign(server, { base: `http://127.0.0.1:${server.port}`, url: (path: string) => `http://127.0.0.1:${server.port}${path}` });
}
const post = (server: { url(path: string): string }, path: string, body: unknown) => fetch(server.url(path), { method: "POST", body: JSON.stringify(body) });

class Client {
  messages: string[] = [];
  closed: Promise<{ code: number }>;
  opened: Promise<void>;
  socket: WebSocket;
  constructor(url: string, headers?: Record<string, string>) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => { this.socket.onopen = () => resolve(); this.socket.onerror = () => reject(new Error("socket error")); });
    this.closed = new Promise((resolve) => { this.socket.onclose = (event) => resolve({ code: event.code }); });
    this.socket.onmessage = (event) => { this.messages.push(typeof event.data === "string" ? event.data : "binary:" + Buffer.from(event.data).toString("hex")); };
    void headers;
  }
  async until(predicate: () => boolean, ms = 2000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error("timed out; messages: " + JSON.stringify(this.messages)); await wait(10); } }
}

test("HTTP requests reach named objects, which keep state and call each other", async () => {
  const server = await start();
  try {
    assert.deepEqual(await (await post(server, "/r/one/add", { by: 2 })).json(), { count: 2 });
    assert.deepEqual(await (await post(server, "/r/one/add", {})).json(), { count: 3 });
    assert.deepEqual(await (await post(server, "/r/two/add", { by: 10 })).json(), { count: 10 });
    assert.equal((await (await fetch(server.url("/r/one/state"))).json()).count, 3);
    assert.deepEqual(await (await fetch(server.url("/rooms"))).json(), [{ id: "one", count: 10 }]);
    assert.equal((await fetch(server.url("/nothing"))).status, 404);
  } finally { await server.close(); }
});

test("request bodies stream through to the object and back", async () => {
  const server = await start();
  try {
    const big = "x".repeat(300000);
    const response = await fetch(server.url("/r/one/echo"), { method: "POST", body: big });
    assert.equal((await response.text()).length, big.length);
  } finally { await server.close(); }
});

test("WebSocket: first message sent before the response, ping answered without the object, changes broadcast", async () => {
  const server = await start();
  try {
    const client = new Client(`ws://127.0.0.1:${server.port}/r/one/ws`);
    await client.opened;
    await client.until(() => client.messages.length === 1);
    assert.equal(client.messages[0], '{"type":"count","count":0}');
    client.socket.send("ping");
    await client.until(() => client.messages.includes("pong"));
    client.socket.send("add");
    await client.until(() => client.messages.includes('{"type":"count","count":1}'));
    await post(server, "/r/one/add", { by: 4 });
    await client.until(() => client.messages.includes('{"type":"count","count":5}'));
    client.socket.send(new Uint8Array([1, 2, 3]));
    await client.until(() => client.messages.includes("binary:010203"));
    client.socket.close(1000);
    assert.equal((await client.closed).code, 1000);
    await wait(50);
    assert.equal((await (await fetch(server.url("/r/one/state"))).json()).lastClose, 1000);
  } finally { await server.close(); }
});

test("WebSocket: the object can close a connection, and a non-WebSocket request to the socket route is refused", async () => {
  const server = await start();
  try {
    const client = new Client(`ws://127.0.0.1:${server.port}/r/one/ws`);
    await client.opened;
    client.socket.send("bye");
    assert.equal((await client.closed).code, 1000);
    assert.equal((await fetch(server.url("/r/one/ws"))).status, 426);
  } finally { await server.close(); }
});

test("WebSocket upgrade: malformed handshakes and refused upgrades get an HTTP answer", async () => {
  const server = await start();
  try {
    const { connect } = await import("node:net");
    const exchange = (request: string) => new Promise<string>((resolve) => {
      const socket = connect(server.port, "127.0.0.1", () => socket.write(request));
      let data = "";
      socket.on("data", (chunk) => { data += chunk; });
      socket.on("close", () => resolve(data));
      setTimeout(() => socket.destroy(), 1500);
    });
    assert.match(await exchange("GET /r/one/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"), /^HTTP\/1.1 400/);
    assert.match(await exchange("GET /nothing HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"), /^HTTP\/1.1 404/);
  } finally { await server.close(); }
});

test("malformed client frames close the connection with a protocol error", async () => {
  const server = await start();
  try {
    const { connect } = await import("node:net");
    const result = await new Promise<Buffer>((resolve) => {
      const socket = connect(server.port, "127.0.0.1", () => socket.write("GET /r/one/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"));
      const chunks: Buffer[] = [];
      let upgraded = false;
      socket.on("data", (chunk) => { chunks.push(chunk); if (!upgraded && chunk.toString().includes("\r\n\r\n")) { upgraded = true; socket.write(Buffer.from([0x81, 0x01, 0x41])); } });
      socket.on("close", () => resolve(Buffer.concat(chunks)));
      setTimeout(() => socket.destroy(), 1500);
    });
    const text = result.toString("latin1");
    assert.match(text, /101 Switching Protocols/);
    assert.ok(result.includes(Buffer.from([0x88])), "a close frame was sent");
    const at = result.indexOf(Buffer.from([0x88]));
    assert.equal(result.readUInt16BE(at + 2), 1002);
  } finally { await server.close(); }
});

test("alarms fire in the object that set them", async () => {
  const server = await start();
  try {
    await post(server, "/r/one/later", {});
    assert.equal((await (await fetch(server.url("/r/one/state"))).json()).count, 0);
    await wait(250);
    assert.equal((await (await fetch(server.url("/r/one/state"))).json()).count, 100);
  } finally { await server.close(); }
});

test("an aborted object restarts from storage and its sockets close with 1012", async () => {
  const server = await start();
  try {
    await post(server, "/r/one/add", { by: 7 });
    const client = new Client(`ws://127.0.0.1:${server.port}/r/one/ws`);
    await client.opened;
    assert.equal((await fetch(server.url("/r/one/reset"))).status, 500);
    assert.equal((await client.closed).code, 1012);
    assert.equal((await (await fetch(server.url("/r/one/state"))).json()).count, 7);
  } finally { await server.close(); }
});

test("object storage survives a restart, including a pending alarm", async () => {
  const directory = mkdtempSync(join(tmpdir(), "server-host-"));
  try {
    let server = await start(own, directory);
    await post(server, "/r/one/add", { by: 5 });
    await post(server, "/r/one/later", {});
    await server.close();
    assert.deepEqual(readdirSync(directory).sort(), ["DIRECTORY", "ROOM"]);
    server = await start(own, directory);
    try {
      await wait(300);
      assert.equal((await (await fetch(server.url("/r/one/state"))).json()).count, 105);
      assert.deepEqual(await (await fetch(server.url("/rooms"))).json(), [{ id: "one", count: 105 }]);
    } finally { await server.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("origin policy applies in front of the service on every provider", async () => {
  const server = await start();
  try {
    const allowed = await (await fetch(server.url("/health"), { headers: { origin: "https://app.example.com" } })).json();
    const refused = await (await fetch(server.url("/health"), { headers: { origin: "https://evil.example.com" } })).json();
    assert.equal(allowed.origin, "https://app.example.com");
    assert.equal(refused.origin, null);
  } finally { await server.close(); }
});

// ---- storage export and import ----

test("storage export is portable ndjson that round-trips through the data folder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "server-host-"));
  const target = mkdtempSync(join(tmpdir(), "server-host-"));
  try {
    const server = await start(own, directory);
    await post(server, "/r/one/add", { by: 3 });
    await post(server, "/r/two/add", { by: 4 });
    await server.close();
    const records = readStorage(directory);
    assert.deepEqual(records.map((r) => `${r.namespace}/${r.name}`), ["DIRECTORY/home", "ROOM/one", "ROOM/two"]);
    const text = exportStorage(records);
    const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.type), ["header", "object", "object", "object"]);
    assert.equal(lines[0].objects, 3);
    const imported = importStorage(text);
    assert.deepEqual(imported, records);
    writeStorage(target, imported);
    assert.deepEqual(verifyStorage(records, readStorage(target)), { counts: true, checksums: true, sample: ["DIRECTORY/home", "ROOM/one", "ROOM/two"] });
    assert.throws(() => writeStorage(target, imported), /already exists/);
    const again = await start(own, target);
    try { assert.equal((await (await fetch(again.url("/r/two/state"))).json()).count, 4); } finally { await again.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("tampered, miscounted, duplicate or foreign exports are rejected", () => {
  const record: ObjectRecord = { namespace: "ROOM", name: "a", storage: { count: 1 }, alarm: null };
  const text = exportStorage([record]);
  assert.throws(() => importStorage(text.replace('"count":1', '"count":2')), /checksum mismatch for ROOM\/a/);
  assert.throws(() => importStorage(text.replace('"objects":1', '"objects":2')), /object count mismatch/);
  assert.throws(() => importStorage(text + text.split("\n")[1] + "\n"), /duplicate object/);
  assert.throws(() => importStorage("{}\n"), /not an ae\/object-storage/);
  assert.throws(() => importStorage(exportStorage([{ ...record, namespace: "../x" }])), /invalid namespace/);
  assert.equal(verifyStorage([record], []).counts, false);
  assert.equal(verifyStorage([record], [{ ...record, storage: { count: 9 } }]).checksums, false);
});

// ---- host-settings.ts (rendered by aepm at install) ----

const settingsFixture = JSON.parse(readFileSync(new URL("fixtures/host-settings-collect.json", import.meta.url), "utf8"));
const declarations = settingsFixture.collect as Declaration[];
const manifestUrl = new URL("../component.json", import.meta.url);
const templateSource = readFileSync(new URL("../implementation/server/host-settings.ts", import.meta.url), "utf8");
const render = (supplied: Record<string, unknown>) => substitute(templateSource, declarations, configuration(declarations, supplied));
async function load(supplied: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "host-settings-"));
  try {
    copyFileSync(new URL("../implementation/server/settings.ts", import.meta.url), join(directory, "settings.ts"));
    writeFileSync(join(directory, "host-settings.ts"), render(supplied));
    return (await import(pathToFileURL(join(directory, "host-settings.ts")).href)) as { hostSettings: HostSettings; serverSettings: () => ServerSettings };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("the manifest renders host-settings.ts as a template into the server folder", { skip: !existsSync(manifestUrl) && "component.json is not in this copy" }, () => {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  assert.deepEqual(manifest.collect, declarations);
  const artefact = manifest.artefacts.find((item: any) => item.source === "implementation/server/host-settings.ts");
  assert.deepEqual(artefact, settingsFixture.artefact);
  assert.deepEqual(artefact, { source: "implementation/server/host-settings.ts", destination: "components/server-host/server/host-settings.ts", template: true, executable: false });
  const tokens = [...templateSource.matchAll(/\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g)].map((match) => match[1]);
  assert.deepEqual(tokens, ["provider", "accountReference", "allowedOrigins", "roomPrefix", "region"]);
  for (const id of tokens) {
    const setting = declarations.find((item) => item.id === id)!;
    assert.equal(setting.secret, false, `${id} is rendered, so it cannot be secret`);
    assert.ok(setting.required || setting.default !== undefined, `${id} needs a value or a default so it always renders`);
  }
});

test("a Cloudflare design renders its own settings", async () => {
  const supplied = { provider: "cloudflare-paid", accountReference: "ourpoker-cloudflare-account", allowedOrigins: "https://app.example.com", roomPrefix: "demo-", region: "eu" };
  const text = render(supplied);
  assert.match(text, /provider: "cloudflare-paid",/);
  assert.ok(!text.includes("{{"));
  const { hostSettings, serverSettings } = await load(supplied);
  assert.deepEqual(hostSettings, supplied);
  assert.deepEqual(serverSettings(), supplied);
  const host = createServerHostFromHostSettings(hostSettings);
  assert.equal(host.adapter, "cloudflare");
  assert.deepEqual(host.roomsSettings(), { applicationId: "demo", allowedOrigins: ["https://app.example.com"], roomPrefix: "demo-" });
  assert.ok(host.deployFiles()["deploy.sh"].includes("ourpoker-cloudflare-account"));
});

test("own hardware needs only a provider and a prefix; the other settings take their defaults", async () => {
  const { hostSettings, serverSettings } = await load({ provider: "own-hardware", roomPrefix: "club-" });
  assert.deepEqual(hostSettings, { provider: "own-hardware", accountReference: NO_ACCOUNT, allowedOrigins: DEFAULT_ORIGIN, roomPrefix: "club-", region: "any" });
  assert.equal("accountReference" in serverSettings(), false);
  const host = createServerHostFromHostSettings(hostSettings);
  assert.equal(host.adapter, "node");
  assert.equal(host.settings.accountReference, null);
  assert.deepEqual(host.settings.allowedOrigins, [DEFAULT_ORIGIN]);
  assert.ok("start.ts" in host.deployFiles());
});

test("a Cloudflare provider without an account name is refused when the host starts", async () => {
  const { hostSettings } = await load({ provider: "cloudflare-free", roomPrefix: "demo-" });
  assert.equal(hostSettings.accountReference, NO_ACCOUNT);
  assert.throws(() => createServerHostFromHostSettings(hostSettings), (error: Error) => error instanceof SettingsError && error.message.includes("accountReference"));
  assert.throws(() => createServerHostFromHostSettings({ ...hostSettings, provider: "own-hardware", accountReference: "some-account" }), /account/);
  assert.deepEqual(fromHostSettings({ ...hostSettings, accountReference: "acme" }).accountReference, "acme");
});

test("the template rules refuse what aepm refuses", () => {
  const base = { provider: "own-hardware", roomPrefix: "demo-" };
  assert.throws(() => configuration(declarations, { roomPrefix: "demo-" }), /required-setting provider/);
  assert.throws(() => configuration(declarations, { ...base, roomPrefix: "Demo" }), /setting-grammar roomPrefix/);
  assert.throws(() => configuration(declarations, { ...base, allowedOrigins: "app.example.com" }), /setting-grammar allowedOrigins/);
  assert.throws(() => configuration(declarations, { ...base, accountReference: "a/b" }), /setting-grammar accountReference/);
  assert.throws(() => configuration(declarations, { ...base, extra: "x" }), /unknown-setting extra/);
  const values = configuration(declarations, base);
  assert.throws(() => substitute("const a = {{provider}};", declarations, values), (error: Error) => error instanceof TemplateError && error.message.includes("template-string-position"));
  assert.throws(() => substitute('const a = "{{missing}}";', declarations, values), /template-setting missing/);
  assert.throws(() => substitute('const a = "{{provider}";', declarations, values), /template-token/);
  assert.throws(() => substitute('const a = "{{{provider}}}";', declarations, values), /template-token/);
  assert.throws(() => substitute('const a = "{{provider}}"; }}', declarations, values), /template-token/);
  const secret: Declaration[] = [{ id: "token", type: "string", grammar: "slug", required: true, secret: true }];
  assert.throws(() => substitute('"{{token}}"', secret, { token: "x" }), /template-setting token/);
  assert.equal(substitute('a "{{provider}}" b \'{{roomPrefix}}\'', declarations, values), 'a "own-hardware" b \'demo-\'');
});

test("the rendered example matches what the template produces", () => {
  const supplied = { provider: "cloudflare-free", accountReference: "ourpoker-cloudflare-account", allowedOrigins: "https://app.example.com", roomPrefix: "demo-" };
  assert.equal(readFileSync(new URL("../examples/rendered-host-settings.ts", import.meta.url), "utf8"), render(supplied));
});

// ---- wrangler.jsonc and start.ts (installed beside host-settings.ts) ----

const wranglerTemplate = readFileSync(new URL("../implementation/server/wrangler.jsonc", import.meta.url), "utf8");
const jsonc = (text: string) => JSON.parse(text.split("\n").filter((line) => !line.startsWith("//")).join("\n"));

test("the installed wrangler.jsonc is the deployment renderWrangler writes, with the application's worker module", { skip: !existsSync(new URL("../component.json", import.meta.url)) && "component.json is not in this copy" }, () => {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  assert.deepEqual(manifest.artefacts.find((item: any) => item.source === "implementation/server/wrangler.jsonc"),
    { source: "implementation/server/wrangler.jsonc", destination: "components/server-host/server/wrangler.jsonc", template: true, executable: false });
  for (const supplied of [
    { provider: "cloudflare-free", accountReference: "ourpoker-cloudflare-account", allowedOrigins: "https://app.example.com", roomPrefix: "ourpoker-" },
    { provider: "cloudflare-paid", accountReference: "acme", roomPrefix: "demo-" },
  ]) {
    const values = configuration(declarations, supplied);
    const installed = jsonc(substitute(wranglerTemplate, declarations, values));
    const rendered = wranglerOf({ ...supplied, allowedOrigins: values.allowedOrigins } as ServerSettings, { main: "../../../server/src/index.ts" });
    assert.deepEqual(installed, rendered);
    assert.deepEqual(installed.compatibility_flags, ["nodejs_compat"]);
  }
});

test("start.ts serves the application's worker module on Node with the installed settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "start-"));
  try {
    const host = join(root, "components/server-host/server");
    mkdirSync(join(host, "node"), { recursive: true });
    for (const name of ["start.ts", "host.ts", "settings.ts", "entry.ts", "region.ts", "deploy.ts"]) copyFileSync(new URL(`../implementation/server/${name}`, import.meta.url), join(host, name));
    for (const name of readdirSync(new URL("../implementation/server/node/", import.meta.url))) copyFileSync(new URL(`../implementation/server/node/${name}`, import.meta.url), join(host, "node", name));
    writeFileSync(join(host, "host-settings.ts"), render({ provider: "own-hardware", roomPrefix: "demo-", allowedOrigins: "https://app.example.com" }));
    mkdirSync(join(root, "server/src"), { recursive: true });
    writeFileSync(join(root, "server/src/index.ts"), `import { buildWorker } from ${JSON.stringify(new URL("../examples/worker.ts", import.meta.url).href)};
const worker = buildWorker({ provider: "own-hardware", roomPrefix: "demo-", allowedOrigins: "https://app.example.com" });
export default worker.entry;
export const Room = worker.Room;
export const Directory = worker.Directory;
`);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [join(host, "start.ts")], { cwd: join(root, "server"), env: { PATH: process.env.PATH ?? "", PORT: "0", DATA_DIRECTORY: join(root, "data"), POLL_MS: "900" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const address = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; const m = /listening on (http:\/\/\S+)/.exec(out); if (m) resolve(m[1]); });
        child.stderr.on("data", (chunk) => { out += chunk; });
        child.once("exit", (code) => reject(new Error(`start.ts exited ${code}: ${out}`)));
      });
      assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await (await fetch(`${address}/health`, { headers: { origin: "https://app.example.com" } })).json();
      assert.deepEqual(health, { ok: true, origin: "https://app.example.com" });
      assert.equal((await fetch(`${address}/r/casino/add`, { method: "POST", body: JSON.stringify({ by: 2 }) })).status, 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    assert.ok(existsSync(join(root, "data")), "room storage is kept in DATA_DIRECTORY");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
