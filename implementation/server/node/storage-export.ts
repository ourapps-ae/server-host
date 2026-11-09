import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Portable export and import of the object files the Node adapter keeps, as ndjson (ae/object-storage 1.0.0).

export type ObjectRecord = { namespace: string; name: string; storage: Record<string, unknown>; alarm: number | null };
export type Check = { counts: boolean; checksums: boolean; sample: string[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const fileName = (name: string) => Buffer.from(name).toString("base64url") + ".json";

// Reads every object in the data directory.
export function readStorage(dataDirectory: string): ObjectRecord[] {
  const records: ObjectRecord[] = [];
  if (!existsSync(dataDirectory)) return records;
  for (const namespace of readdirSync(dataDirectory).sort()) {
    const folder = join(dataDirectory, namespace);
    for (const entry of readdirSync(folder).sort()) {
      if (!entry.endsWith(".json")) continue;
      const saved = JSON.parse(readFileSync(join(folder, entry), "utf8")) as { storage: Record<string, string>; alarm: number | null };
      const storage: Record<string, unknown> = {};
      for (const [key, text] of Object.entries(saved.storage)) storage[key] = JSON.parse(text);
      records.push({ namespace, name: Buffer.from(entry.slice(0, -5), "base64url").toString(), storage, alarm: saved.alarm });
    }
  }
  return records.sort((a, b) => (a.namespace + "/" + a.name < b.namespace + "/" + b.name ? -1 : 1));
}

export function exportStorage(records: ObjectRecord[]): string {
  const sorted = [...records].sort((a, b) => (a.namespace + "/" + a.name < b.namespace + "/" + b.name ? -1 : 1));
  const lines: unknown[] = [{ type: "header", format: "ae/object-storage", version: "1.0.0", objects: sorted.length }];
  for (const record of sorted) lines.push({ type: "object", ...record, sha256: digest(record) });
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export function importStorage(text: string): ObjectRecord[] {
  const lines = text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  const header = lines[0];
  if (!header || header.type !== "header" || header.format !== "ae/object-storage" || header.version !== "1.0.0") throw new Error("not an ae/object-storage 1.0.0 export");
  const records: ObjectRecord[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    if (line.type !== "object") throw new Error("unknown line type " + line.type);
    const { type: _type, sha256, ...record } = line;
    if (digest(record) !== sha256) throw new Error(`checksum mismatch for ${record.namespace}/${record.name}`);
    const key = record.namespace + "/" + record.name;
    if (seen.has(key)) throw new Error("duplicate object " + key);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(record.namespace)) throw new Error("invalid namespace " + record.namespace);
    seen.add(key);
    records.push(record);
  }
  if (records.length !== header.objects) throw new Error("object count mismatch");
  return records;
}

// Writes imported objects into an empty data directory; refuses to overwrite an existing object.
export function writeStorage(dataDirectory: string, records: ObjectRecord[]): void {
  for (const record of records) {
    const folder = join(dataDirectory, record.namespace);
    mkdirSync(folder, { recursive: true });
    const target = join(folder, fileName(record.name));
    if (existsSync(target)) throw new Error(`object ${record.namespace}/${record.name} already exists`);
    const storage = Object.fromEntries(Object.entries(record.storage).map(([key, value]) => [key, JSON.stringify(value)]));
    writeFileSync(target + ".tmp", JSON.stringify({ storage, alarm: record.alarm }));
    renameSync(target + ".tmp", target);
  }
}

export function verifyStorage(expected: ObjectRecord[], actual: ObjectRecord[], sample = 20): Check {
  const key = (record: ObjectRecord) => record.namespace + "/" + record.name;
  const found = new Map(actual.map((record) => [key(record), record]));
  return {
    counts: expected.length === actual.length,
    checksums: expected.every((record) => found.has(key(record)) && digest(found.get(key(record))) === digest(record)),
    sample: expected.slice(0, sample).map(key),
  };
}
