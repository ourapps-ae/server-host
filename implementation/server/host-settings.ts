import { fromHostSettings, type HostSettings, type ServerSettings } from "./settings.ts";

// Rendered by aepm at install from the server-host settings; nothing else writes this file.
export const hostSettings: HostSettings = {
  provider: "{{provider}}",
  accountReference: "{{accountReference}}",
  allowedOrigins: "{{allowedOrigins}}",
  roomPrefix: "{{roomPrefix}}",
  region: "{{region}}",
};

// What the Worker module and the Node start script pass to createServerHost.
export const serverSettings = (): ServerSettings => fromHostSettings(hostSettings);
