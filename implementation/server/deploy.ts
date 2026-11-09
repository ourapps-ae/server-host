import { DEFAULT_BINDINGS } from "./region.ts";
import { applicationIdFrom, SettingsError, type ResolvedServerSettings } from "./settings.ts";

// Files that deploy the server: a Wrangler project for Cloudflare, a start script for own hardware.

export interface ObjectBinding {
  // Binding name the worker reads from env, for example ROOM.
  binding: string;
  // Exported class name, for example Room.
  className: string;
}

export interface DeployOptions {
  // Module that default-exports the entry and exports the object classes.
  main?: string;
  workerName?: string;
  objects?: ObjectBinding[];
  compatibilityDate?: string;
  // Extra plain variables written into the deployment (never secrets).
  variables?: Record<string, string>;
  // Paid Cloudflare only: CPU milliseconds per request, up to 300000 (the default is 30000).
  cpuMilliseconds?: number;
  // Folder holding this component's server sources, relative to the start script (own hardware).
  hostPath?: string;
  devPort?: number;
}

export const DEFAULT_OBJECTS: readonly ObjectBinding[] = [
  { binding: "ROOM", className: "Room" },
  { binding: "DIRECTORY", className: "Directory" },
];

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const WORKER_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PATH = /^(\.\.?\/)*[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
const WRANGLER_REFERENCE_VARIABLES = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];

function objects(options: DeployOptions): ObjectBinding[] {
  const list = options.objects ?? [...DEFAULT_OBJECTS];
  const seen = new Set<string>();
  for (const item of list) {
    if (!IDENTIFIER.test(item.binding) || !IDENTIFIER.test(item.className)) throw new SettingsError(`object ${item.binding}/${item.className} must use plain identifiers`);
    if (seen.has(item.binding)) throw new SettingsError(`binding ${item.binding} is listed twice`);
    seen.add(item.binding);
  }
  if (!list.length) throw new SettingsError("at least one object binding is needed");
  return list;
}

function variables(settings: ResolvedServerSettings, options: DeployOptions): Record<string, string> {
  const extra = options.variables ?? {};
  for (const [name, value] of Object.entries(extra)) {
    if (!VARIABLE.test(name) || typeof value !== "string") throw new SettingsError(`variable ${name} must be capitals and a string value`);
  }
  return { CODE_VERSION: "dev", WEB_ORIGINS: settings.allowedOrigins.join(","), ...extra };
}

function names(settings: ResolvedServerSettings, options: DeployOptions) {
  const workerName = options.workerName ?? `${applicationIdFrom(settings.roomPrefix)}-server`;
  if (!WORKER_NAME.test(workerName)) throw new SettingsError("workerName must be lower-case words and digits separated by dashes");
  const main = options.main ?? "src/index.ts";
  if (!PATH.test(main)) throw new SettingsError("main must be a plain relative path");
  return { workerName, main };
}

export function renderWrangler(settings: ResolvedServerSettings, options: DeployOptions = {}): string {
  if (settings.adapter !== "cloudflare") throw new SettingsError("wrangler.jsonc is for the Cloudflare providers");
  const { workerName, main } = names(settings, options);
  const date = options.compatibilityDate ?? "2026-10-01";
  if (!DATE.test(date)) throw new SettingsError("compatibilityDate must be YYYY-MM-DD");
  const list = objects(options);
  const config: Record<string, unknown> = {
    name: workerName,
    main,
    compatibility_date: date,
    dev: { port: options.devPort ?? 8788 },
    vars: variables(settings, options),
    durable_objects: { bindings: list.map((item) => ({ name: item.binding, class_name: item.className })) },
    // SQLite-backed objects are the only kind the free plan offers.
    migrations: [{ tag: "v1", new_sqlite_classes: list.map((item) => item.className) }],
  };
  if (options.cpuMilliseconds !== undefined) {
    if (settings.provider !== "cloudflare-paid") throw new SettingsError("cpuMilliseconds can be set only on cloudflare-paid; the free plan allows 10 ms per request");
    if (!Number.isInteger(options.cpuMilliseconds) || options.cpuMilliseconds < 1 || options.cpuMilliseconds > 300000) throw new SettingsError("cpuMilliseconds must be a whole number up to 300000");
    config.limits = { cpu_ms: options.cpuMilliseconds };
  }
  // The account is never written here: Wrangler reads CLOUDFLARE_ACCOUNT_ID from the environment.
  const header = `// ${workerName} on ${settings.provider}. The account comes from the environment (secret reference ${settings.accountReference}), never from this file.\n`;
  return header + JSON.stringify(config, null, 2) + "\n";
}

export function renderDeployScript(settings: ResolvedServerSettings): string {
  if (settings.adapter !== "cloudflare" || !settings.accountReference) throw new SettingsError("deploy.sh is for the Cloudflare providers");
  return `#!/bin/sh
# Deploys the worker. The release pipeline resolves the secret reference "${settings.accountReference}" and exports
# ${WRANGLER_REFERENCE_VARIABLES.join(" and ")} before running this script. No value is stored in this repository.
set -eu
${WRANGLER_REFERENCE_VARIABLES.map((name) => `: "\${${name}:?${name} must come from the secret reference ${settings.accountReference}}"`).join("\n")}
exec npx wrangler deploy
`;
}

export function renderPackage(settings: ResolvedServerSettings, options: DeployOptions = {}): string {
  const { workerName } = names(settings, options);
  const cloudflare = settings.adapter === "cloudflare";
  const body = cloudflare
    ? {
      name: workerName, version: "0.1.0", type: "module", private: true,
      scripts: { dev: "wrangler dev", deploy: "sh deploy.sh", typecheck: "tsc --noEmit" },
      devDependencies: { "@cloudflare/workers-types": "^5.20261015.1", typescript: "^5.9.3", wrangler: "^4.151.0" },
    }
    : {
      name: workerName, version: "0.1.0", type: "module", private: true,
      scripts: { start: "node start.ts", typecheck: "tsc --noEmit" },
      devDependencies: { "@types/node": "^26.6.5", typescript: "^5.9.3" },
    };
  return JSON.stringify(body, null, 2) + "\n";
}

export function renderNodeStart(settings: ResolvedServerSettings, options: DeployOptions = {}): string {
  if (settings.adapter !== "node") throw new SettingsError("start.ts is for own-hardware");
  const { main } = names(settings, options);
  const hostPath = options.hostPath ?? "../components/server-host/server";
  if (!PATH.test(hostPath)) throw new SettingsError("hostPath must be a plain relative path");
  const list = objects(options);
  const vars = variables(settings, options);
  const lines = Object.entries(vars).map(([name, value]) => `    ${name}: process.env.${name} ?? ${JSON.stringify(value)},`);
  return `// Starts the server on this machine. Read PORT, HOST, DATA_DIRECTORY and the variables below from the environment.
import "${hostPath}/node/register.ts";

const { serveNode } = await import("${hostPath}/node/serve.ts");
const app = await import("./${main.replace(/^\.\//, "")}");

const server = await serveNode({
  entry: app.default,
  objects: { ${list.map((item) => `${item.binding}: app.${item.className}`).join(", ")} },
  variables: {
${lines.join("\n")}
  },
  port: Number(process.env.PORT ?? ${options.devPort ?? 8788}),
  host: process.env.HOST ?? "127.0.0.1",
  dataDirectory: process.env.DATA_DIRECTORY ?? "./data",
});
console.log(\`${applicationIdFrom(settings.roomPrefix)} listening on http://\${server.host}:\${server.port}\`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)); });
}
`;
}

// Output path (relative to the server project folder) to file text.
export function deployFiles(settings: ResolvedServerSettings, options: DeployOptions = {}): Record<string, string> {
  if (settings.adapter === "cloudflare") {
    return { "wrangler.jsonc": renderWrangler(settings, options), "deploy.sh": renderDeployScript(settings), "package.json": renderPackage(settings, options) };
  }
  return { "start.ts": renderNodeStart(settings, options), "package.json": renderPackage(settings, options) };
}

export { DEFAULT_BINDINGS };
