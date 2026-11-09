// Not packaged. Runs the real realtime-rooms fixture service (its Room and createWorker) with the real room-directory Directory class on the Node adapter
// and exercises join, long-poll state, actions, alarms, room sockets with ping, and the directory socket.
// Usage: node authoring/integration-realtime-rooms.ts
import "../implementation/server/node/register.ts";
import assert from "node:assert/strict";
const { serveNode } = await import("../implementation/server/node/serve.ts");
const rooms: any = await import("../../realtime-rooms/fixtures/worker.ts");
const { DurableObject } = await import("cloudflare:workers" as string);
const { createDirectoryClass } = await import("../../room-directory/implementation/server/directory.ts");
class Directory extends createDirectoryClass(DurableObject, { roomIds: ["one"], maxConnections: 200 }) {}

const server = await serveNode({ entry: rooms.default, objects: { ROOM: rooms.Room, DIRECTORY: Directory }, variables: { CODE_VERSION: "t" }, dataDirectory: null });
const base = `http://127.0.0.1:${server.port}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (path: string, body: unknown, token = "") => fetch(base + "/r/one" + path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
try {
  assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true, app: "counter" });
  const a: any = await (await post("/join", { name: "A" })).json();
  const b: any = await (await post("/join", { name: "B" })).json();
  assert.equal(a.view.secret, `private-${a.playerId}`);
  assert.equal((await post("/action", { type: "increment", expectedVersion: 0 }, a.token)).status, 409);
  const view: any = await (await post("/action", { type: "increment", expectedVersion: b.view.version }, a.token)).json();
  assert.equal(view.value, 1);
  const waiting = fetch(base + `/r/one/state?since=${view.version}`, { headers: { authorization: `Bearer ${b.token}` } }).then((r) => r.json());
  await wait(50);
  await post("/action", { type: "increment", expectedVersion: view.version }, a.token);
  assert.equal(((await waiting) as any).value, 2);

  const room = new WebSocket(`ws://127.0.0.1:${server.port}/r/one/ws`);
  const roomMessages: string[] = [];
  room.onmessage = (e) => roomMessages.push(String(e.data));
  await new Promise((r) => (room.onopen = r));
  room.send(JSON.stringify({ type: "hello", token: a.token }));
  room.send("ping");
  await wait(150);
  assert.ok(roomMessages.includes("pong"), "ping answered");
  assert.ok(roomMessages.some((m) => m.includes('"type":"view"')), "view pushed");
  room.send(JSON.stringify({ type: "hello", token: "wrong" }));
  const closed: number = await new Promise((r) => (room.onclose = (e) => r(e.code)));
  assert.equal(closed, 4001);

  const directory = new WebSocket(`ws://127.0.0.1:${server.port}/rooms/ws`);
  const directoryMessages: string[] = [];
  directory.onmessage = (e) => directoryMessages.push(String(e.data));
  await new Promise((r) => (directory.onopen = r));
  await wait(100);
  assert.ok(directoryMessages[0].includes('"type":"rooms"'), "directory announced on connect");
  await post("/action", { type: "alarm", expectedVersion: (await (await fetch(base + "/r/one/state", { headers: { authorization: `Bearer ${a.token}` } })).json() as any).version }, a.token);
  await wait(400);
  const after: any = await (await fetch(base + "/r/one/state", { headers: { authorization: `Bearer ${a.token}` } })).json();
  assert.equal(after.value, 3, "alarm advanced the game");
  directory.close(1000);
  console.log("integration ok: realtime-rooms fixture and room-directory class on the Node adapter");
} finally {
  await server.close();
}
