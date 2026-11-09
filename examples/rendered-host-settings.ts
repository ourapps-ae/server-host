import { fromHostSettings, type HostSettings, type ServerSettings } from "./settings.ts";

// Rendered by aepm at install from the server-host settings; nothing else writes this file.
export const hostSettings: HostSettings = {
  provider: "cloudflare-free",
  accountReference: "ourpoker-cloudflare-account",
  allowedOrigins: "https://app.example.com",
  roomPrefix: "demo-",
  region: "any",
};

// What the Worker module and the Node start script pass to createServerHost.
export const serverSettings = (): ServerSettings => fromHostSettings(hostSettings);
