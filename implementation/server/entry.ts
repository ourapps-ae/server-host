import { placementApplies, regionEnv } from "./region.ts";
import type { ResolvedServerSettings } from "./settings.ts";

// The server's public entry: the origin policy and region placement in front of the room service.

export interface Worker {
  fetch(request: Request, env: any): Promise<Response>;
}

export interface EntryOptions {
  // Origins matching these patterns are also allowed, for example hosted web copies on subdomains.
  originPatterns?: RegExp[];
  // Browsers on the developer's own machine (localhost and 127.0.0.1, any port). On by default.
  allowLoopback?: boolean;
  bindings?: readonly string[];
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function originAllowed(origin: string | null, settings: Pick<ResolvedServerSettings, "allowedOrigins">, webOrigins = "", options: EntryOptions = {}): origin is string {
  if (!origin) return false;
  if (settings.allowedOrigins.includes(origin)) return true;
  if ((options.originPatterns ?? []).some((pattern) => pattern.test(origin))) return true;
  if (options.allowLoopback !== false && LOOPBACK.test(origin)) return true;
  return webOrigins.split(",").map((item) => item.trim()).filter(Boolean).includes(origin);
}

export function createEntry(worker: Worker, settings: ResolvedServerSettings, options: EntryOptions = {}): Worker {
  return {
    fetch(request: Request, env: any): Promise<Response> {
      const origin = request.headers.get("origin");
      let next = env;
      // The inner service trusts the origins listed in WEB_ORIGINS, so an origin this policy accepts is added for the request.
      if (origin && originAllowed(origin, settings, env?.WEB_ORIGINS ?? "", options)) next = { ...env, WEB_ORIGINS: [env?.WEB_ORIGINS, origin].filter(Boolean).join(",") };
      if (placementApplies(settings)) next = regionEnv(next, settings.region, options.bindings);
      return worker.fetch(request, next);
    },
  };
}
