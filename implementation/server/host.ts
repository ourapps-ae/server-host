import { deployFiles, type DeployOptions } from "./deploy.ts";
import { createEntry, type EntryOptions, type Worker } from "./entry.ts";
import { withRegion } from "./region.ts";
import { fromHostSettings, roomsSettings, validateSettings, type HostSettings, type ResolvedServerSettings, type ServerSettings } from "./settings.ts";

export * from "./settings.ts";
export { createEntry, originAllowed, type EntryOptions, type Worker } from "./entry.ts";
export { regionEnv, withRegion, placementApplies } from "./region.ts";
export { deployFiles, renderWrangler, renderNodeStart, renderDeployScript, renderPackage, DEFAULT_OBJECTS, type DeployOptions, type ObjectBinding } from "./deploy.ts";

// The server host for one set of settings. The application writes one worker module (a default-exported
// entry and the Durable Object classes); Cloudflare runs that module as it is, and the Node adapter
// (node/serve.ts, own hardware) runs the same exports. Nothing here imports a Node module, so a Worker bundle stays clean.
export interface ServerHost {
  readonly settings: ResolvedServerSettings;
  readonly adapter: "cloudflare" | "node";
  // The settings in the shape the room service takes.
  roomsSettings(applicationId?: string): ReturnType<typeof roomsSettings>;
  // Origin policy and region placement in front of the room service worker.
  entry(worker: Worker, options?: EntryOptions): Worker;
  // An object class placed in the configured region (the class itself when no placement applies).
  objectClass<C extends new (ctx: any, env: any, ...rest: any[]) => any>(Base: C): C;
  // Files to deploy this server: wrangler.jsonc, deploy.sh and package.json, or start.ts and package.json.
  deployFiles(options?: DeployOptions): Record<string, string>;
}

// The host for the settings aepm rendered into host-settings.ts (`import { hostSettings } from "./host-settings.ts"`).
export const createServerHostFromHostSettings = (raw: HostSettings): ServerHost => createServerHost(fromHostSettings(raw));

export function createServerHost(settings: ServerSettings): ServerHost {
  const resolved = validateSettings(settings);
  return {
    settings: resolved,
    adapter: resolved.adapter,
    roomsSettings: (applicationId) => roomsSettings(resolved, applicationId),
    entry: (worker, options) => createEntry(worker, resolved, options),
    objectClass: (Base) => withRegion(Base, resolved),
    deployFiles: (options) => deployFiles(resolved, options),
  };
}
