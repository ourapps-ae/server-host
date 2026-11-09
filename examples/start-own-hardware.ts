import "../implementation/server/node/register.ts";

// Own hardware: the same worker on Node's http server, with object storage on disk.
const { serveNode } = await import("../implementation/server/node/serve.ts");
const { buildWorker } = await import("./worker.ts");
const { Room, Directory, entry } = buildWorker({ provider: "own-hardware", roomPrefix: "demo-", allowedOrigins: "https://app.example.com" });
const server = await serveNode({ entry, objects: { ROOM: Room, DIRECTORY: Directory }, variables: { CODE_VERSION: "dev" }, port: Number(process.env.PORT ?? 8788), dataDirectory: process.env.DATA_DIRECTORY ?? "./data" });
console.log(`listening on http://${server.host}:${server.port}`);
