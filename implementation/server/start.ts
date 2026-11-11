// Starts the application's server on this machine with Node: own hardware, or local development for any provider.
// Run from the application's server folder: `node ../components/server-host/server/start.ts`.
// The application's worker module is server/src/index.ts: its default export is the entry, Room and Directory the object classes.
// PORT (default 8788), HOST (default 127.0.0.1) and DATA_DIRECTORY (default ./data) choose where it listens and keeps rooms;
// every other upper-case environment variable reaches the worker's env, as Wrangler variables and secrets do on Cloudflare.
import "./node/register.ts";

const { serveNode } = await import("./node/serve.ts");
const { hostSettings } = await import("./host-settings.ts");
const app = await import("../../../server/src/index.ts");

const OWN = new Set(["PORT", "HOST", "DATA_DIRECTORY"]);
const variables: Record<string, string> = { CODE_VERSION: "dev", WEB_ORIGINS: hostSettings.allowedOrigins };
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined && /^[A-Z][A-Z0-9_]*$/.test(name) && !OWN.has(name)) variables[name] = value;
}

const server = await serveNode({
  entry: app.default,
  objects: { ROOM: app.Room, DIRECTORY: app.Directory },
  variables,
  port: Number(process.env.PORT ?? 8788),
  host: process.env.HOST ?? "127.0.0.1",
  dataDirectory: process.env.DATA_DIRECTORY ?? "./data",
});
console.log(`${hostSettings.roomPrefix.replace(/-+$/, "")} listening on http://${server.host}:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)); });
}
