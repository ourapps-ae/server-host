import { installGlobals } from "./globals.ts";
import { installLoader } from "./loader.ts";

// Import this first, before any module written for Workers: `import "./register.ts"`.
installLoader();
installGlobals();
