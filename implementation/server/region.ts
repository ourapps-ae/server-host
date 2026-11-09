import { JURISDICTIONS, LOCATION_HINTS, type ResolvedServerSettings } from "./settings.ts";

// Placement of Durable Objects on Cloudflare: a jurisdiction restricts where objects run and store data;
// a location hint only suggests where a new object starts. Own hardware has no such placement.

type Namespace = {
  getByName(name: string, options?: Record<string, unknown>): unknown;
  jurisdiction?(name: string): Namespace;
};

export const DEFAULT_BINDINGS: readonly string[] = ["ROOM", "DIRECTORY"];

export const placementApplies = (settings: Pick<ResolvedServerSettings, "adapter" | "region">): boolean => settings.adapter === "cloudflare" && settings.region !== "any";

// The same bindings, placed. Bindings that are not namespaces are left alone.
export function regionEnv<E extends Record<string, any>>(env: E, region: string, bindings: readonly string[] = DEFAULT_BINDINGS): E {
  if (region === "any") return env;
  const placed: Record<string, unknown> = { ...env };
  for (const name of bindings) {
    const namespace = env[name] as Namespace | undefined;
    if (!namespace || typeof namespace.getByName !== "function") continue;
    if (JURISDICTIONS.includes(region)) {
      if (typeof namespace.jurisdiction !== "function") throw new Error(`binding ${name} cannot be restricted to jurisdiction ${region}`);
      placed[name] = namespace.jurisdiction(region);
    } else if (LOCATION_HINTS.includes(region)) {
      placed[name] = new Proxy(namespace, {
        get(target, property, receiver) {
          if (property !== "getByName") return Reflect.get(target, property, receiver);
          return (objectName: string, options?: Record<string, unknown>) => target.getByName(objectName, { locationHint: region, ...options });
        },
      });
    } else {
      throw new Error(`unknown region ${region}`);
    }
  }
  return placed as E;
}

// An object class whose own env is placed too, so objects reach each other inside the same jurisdiction.
export function withRegion<C extends new (ctx: any, env: any, ...rest: any[]) => any>(Base: C, settings: Pick<ResolvedServerSettings, "adapter" | "region">, bindings: readonly string[] = DEFAULT_BINDINGS): C {
  if (!placementApplies(settings)) return Base;
  const region = settings.region;
  return class extends Base {
    constructor(ctx: any, env: any, ...rest: any[]) {
      super(ctx, regionEnv(env, region, bindings), ...rest);
    }
  } as C;
}
