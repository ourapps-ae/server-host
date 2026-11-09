// Typed settings of the server host and the checks every adapter applies to them.

export type Provider = "cloudflare-free" | "cloudflare-paid" | "own-hardware";
export type AdapterKind = "cloudflare" | "node";

export interface ServerSettings {
  provider: Provider;
  // Name of a secret in the release pipeline's secret store. The value is never held here.
  accountReference?: string;
  // Web origins that may call the server: a list, or text separated by spaces.
  allowedOrigins?: string | string[];
  // Prefix of room names, and of video room names when video is connected.
  roomPrefix: string;
  // "any", a Cloudflare jurisdiction (eu, us, fedramp) or location hint, or a free label on own hardware.
  region?: string;
}

export interface ResolvedServerSettings {
  provider: Provider;
  adapter: AdapterKind;
  accountReference: string | null;
  allowedOrigins: string[];
  roomPrefix: string;
  region: string;
}

// The values aepm renders into host-settings.ts from this component's collected settings (every field is always present).
export interface HostSettings {
  provider: Provider;
  // The name of the account secret, or NO_ACCOUNT when none is used (own hardware).
  accountReference: string;
  // One web address (default DEFAULT_ORIGIN); loopback addresses are trusted as well.
  allowedOrigins: string;
  roomPrefix: string;
  region: string;
}

export class SettingsError extends Error {}

// The collected value of accountReference when no account is used.
export const NO_ACCOUNT = "none";
// The collected default of allowedOrigins: a development address that is allowed anyway.
export const DEFAULT_ORIGIN = "http://localhost:5173";

export const PROVIDERS: readonly Provider[] = ["cloudflare-free", "cloudflare-paid", "own-hardware"];
// From https://developers.cloudflare.com/durable-objects/reference/data-location/
export const JURISDICTIONS: readonly string[] = ["eu", "us", "fedramp"];
export const LOCATION_HINTS: readonly string[] = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"];

const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
// The secret reference grammar aepm accepts for configuration values.
const SECRET_REFERENCE = /^[A-Za-z][A-Za-z0-9_./-]{0,127}$/;
const ORIGIN = /^(https?):\/\/([A-Za-z0-9.-]+)(:[0-9]{1,5})?$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

export const adapterFor = (provider: Provider): AdapterKind => (provider === "own-hardware" ? "node" : "cloudflare");

export function parseOrigins(value: string | string[] | undefined): string[] {
  if (value === undefined || value === "") return [];
  const items = Array.isArray(value) ? value : value.split(/\s+/);
  const origins: string[] = [];
  for (const raw of items.map((item) => item.trim().replace(/\/$/, "")).filter(Boolean)) {
    const match = ORIGIN.exec(raw);
    if (!match) throw new SettingsError(`allowedOrigins entry ${raw} must be an origin such as https://example.com (no path, no wildcard)`);
    const port = match[3] ? Number(match[3].slice(1)) : 0;
    if (match[3] && (port < 1 || port > 65535)) throw new SettingsError(`allowedOrigins entry ${raw} has an invalid port`);
    const host = match[2].toLowerCase();
    if (match[1] === "http" && !LOOPBACK.has(host)) throw new SettingsError(`allowedOrigins entry ${raw} must use https (http is allowed only for localhost)`);
    const origin = `${match[1]}://${host}${match[3] ?? ""}`;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export function validateSettings(settings: ServerSettings): ResolvedServerSettings {
  if (!PROVIDERS.includes(settings.provider)) throw new SettingsError(`provider must be one of ${PROVIDERS.join(", ")}`);
  const adapter = adapterFor(settings.provider);
  if (typeof settings.roomPrefix !== "string" || !SLUG.test(settings.roomPrefix)) throw new SettingsError("roomPrefix must be lower-case words and digits separated by dashes");
  const region = settings.region ?? "any";
  if (typeof region !== "string" || !SLUG.test(region)) throw new SettingsError("region must be a slug");
  if (adapter === "cloudflare" && region !== "any" && !JURISDICTIONS.includes(region) && !LOCATION_HINTS.includes(region)) {
    throw new SettingsError(`region ${region} is not any, a jurisdiction (${JURISDICTIONS.join(", ")}) or a location hint (${LOCATION_HINTS.join(", ")})`);
  }
  let accountReference: string | null = null;
  if (settings.accountReference !== undefined && settings.accountReference !== "") {
    if (typeof settings.accountReference !== "string" || !SECRET_REFERENCE.test(settings.accountReference)) throw new SettingsError("accountReference must be the name of a secret, not a value");
    if (adapter === "node") throw new SettingsError("own-hardware needs no account reference");
    accountReference = settings.accountReference;
  } else if (adapter === "cloudflare") {
    throw new SettingsError(`${settings.provider} needs accountReference, the name of the secret that holds the Cloudflare account`);
  }
  return { provider: settings.provider, adapter, accountReference, allowedOrigins: parseOrigins(settings.allowedOrigins), roomPrefix: settings.roomPrefix, region };
}

// The identifier the room service reports in its health answer: the prefix without its trailing dashes.
export const applicationIdFrom = (roomPrefix: string): string => roomPrefix.replace(/-+$/, "") || roomPrefix;

// The settings shape the room service (realtime-rooms createWorker) takes.
export function roomsSettings(settings: ResolvedServerSettings, applicationId: string = applicationIdFrom(settings.roomPrefix)) {
  return { applicationId, allowedOrigins: [...settings.allowedOrigins], roomPrefix: settings.roomPrefix };
}

// Turns the rendered host-settings object into the settings the host takes. NO_ACCOUNT means no account reference.
export function fromHostSettings(raw: HostSettings): ServerSettings {
  const settings: ServerSettings = { provider: raw.provider, roomPrefix: raw.roomPrefix, region: raw.region, allowedOrigins: raw.allowedOrigins };
  if (raw.accountReference !== NO_ACCOUNT) settings.accountReference = raw.accountReference;
  return settings;
}
