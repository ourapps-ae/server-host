import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Lets code written for Cloudflare Workers load under Node: the `cloudflare:workers` module becomes
// the local shim, and relative TypeScript imports written without an extension resolve to `.ts`.

const SHIM = new URL("./workers-shim.ts", import.meta.url).href;
let installed = false;

export function installLoader(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: SHIM, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !context.parentURL) throw error;
        for (const suffix of [".ts", "/index.ts"]) {
          const candidate = new URL(specifier + suffix, context.parentURL);
          if (existsSync(fileURLToPath(candidate)) && statSync(fileURLToPath(candidate)).isFile()) return { url: candidate.href, shortCircuit: true };
        }
        throw error;
      }
    },
  });
}
