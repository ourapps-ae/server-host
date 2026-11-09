import { createServerHost, type ServerSettings } from "../implementation/server/host.ts";
import { Directory as BaseDirectory, Room as BaseRoom, service } from "./service.ts";

// The application's one worker module: Cloudflare runs it as it is and the Node adapter runs the same exports.
export function buildWorker(settings: ServerSettings) {
  const host = createServerHost(settings);
  const Room = host.objectClass(BaseRoom);
  const Directory = host.objectClass(BaseDirectory);
  return { host, Room, Directory, entry: host.entry(service) };
}
