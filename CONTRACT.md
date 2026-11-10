# Server host component

## Purpose and facilities
The entry point of a server target. The application writes one worker module (a default-exported entry built from the room service, and the Room and Directory object classes). This component validates the server settings, puts the origin policy and region placement in front of that entry, and renders what is needed to run it: a Wrangler project and deploy script for Cloudflare Workers, or a start script for the Node adapter, which runs the same module on Node's http server for own hardware. The Node adapter supplies the pieces of the Workers runtime the room service uses: named single-instance objects with disk storage and alarms, hibernating WebSockets with automatic ping replies, and the WebSocketPair and WebSocketRequestResponsePair globals.

Facilities: `server-host` (Hosting for the application's room service on Cloudflare or own hardware).

## User inputs
The installer collects `provider` (`cloudflare-free`, `cloudflare-paid` or `own-hardware`), `accountReference` (a reference name, never a value: the name of the secret in the release pipeline's store that holds the Cloudflare account; default `none`, which is right on own hardware and refused on Cloudflare), `allowedOrigins` (one web address of the client; default `http://localhost:5173`; loopback addresses are trusted anyway, and more origins are passed to `createServerHost` as a list), `roomPrefix` (also the prefix of video room names) and `region` (default `any`; on Cloudflare a jurisdiction `eu`, `us` or `fedramp`, or a location hint such as `weur`; on own hardware a free label only). aepm renders all five into `host-settings.ts` at install.

- `provider` (string, slug; required)
- `accountReference` (string, slug; optional; default `none`; a reference name, not secret and never a value)
- `allowedOrigins` (string, address; optional; default `http://localhost:5173`)
- `roomPrefix` (string, slug; required)
- `region` (string, slug; optional; default `any`)

## Artefacts and dependencies
`component.json` maps every `implementation/` source into `components/server-host/`:

- `implementation/server/deploy.ts` -> `components/server-host/server/deploy.ts`
- `implementation/server/entry.ts` -> `components/server-host/server/entry.ts`
- `implementation/server/host-settings.ts` -> `components/server-host/server/host-settings.ts` (template: aepm replaces `{{provider}}`, `{{accountReference}}`, `{{allowedOrigins}}`, `{{roomPrefix}}` and `{{region}}` inside the quoted strings at install)
- `implementation/server/host.ts` -> `components/server-host/server/host.ts`
- `implementation/server/node/globals.ts` -> `components/server-host/server/node/globals.ts`
- `implementation/server/node/loader.ts` -> `components/server-host/server/node/loader.ts`
- `implementation/server/node/register.ts` -> `components/server-host/server/node/register.ts`
- `implementation/server/node/runtime.ts` -> `components/server-host/server/node/runtime.ts`
- `implementation/server/node/serve.ts` -> `components/server-host/server/node/serve.ts`
- `implementation/server/node/storage-export.ts` -> `components/server-host/server/node/storage-export.ts`
- `implementation/server/node/websocket.ts` -> `components/server-host/server/node/websocket.ts`
- `implementation/server/node/workers-shim.ts` -> `components/server-host/server/node/workers-shim.ts`
- `implementation/server/region.ts` -> `components/server-host/server/region.ts`
- `implementation/server/settings.ts` -> `components/server-host/server/settings.ts`

Dependencies: none.
`tools.lock.json` pins verification tools: node 26.5.0. Licence wording remains deferred.

## Provided interfaces
- `interfaces/server-host.json` defines `server-host` (ae/server-host) version 1.0.0 as an OpenRPC 1.3.2 document: one method per exported function of `server/host.ts` and `server/node/*.ts` (`createServerHost`, `validateSettings`, `originAllowed`, `regionEnv`, `serveNode`, the storage export and import functions and the rest), plus the functions of the returned host (`ServerHost.*`), with parameters and results as JSON Schema 2020-12 and the errors each throws.
- `interfaces/object-storage.schema.json` is the JSON Schema 2020-12 document (ae/object-storage 1.0.0) of the object files and the ndjson export lines the Node adapter keeps.

## Required interfaces
- `room-session` (ae/room-session) version 1.0.0, supplied by the recipe or application; `interfaces/required-room-session.json` is a copy of the providing component's interface document.
- `room-directory` (ae/room-directory) version 1.0.0, supplied by the recipe or application; `interfaces/required-room-directory.json` is a copy of the providing component's interface document.

## Integration
aepm renders `components/server-host/server/host-settings.ts` from the five settings (a template artefact; nothing else writes it). It exports `hostSettings` (the typed values) and `serverSettings()` (the settings `createServerHost` takes; `none` for `accountReference` means no account). In the application's server module: `import { serverSettings } from "./host-settings.ts"` and `const host = createServerHost(serverSettings())` (or `createServerHostFromHostSettings(hostSettings)`) from `server/host.ts`; build the room service as usual (`createWorker(host.roomsSettings(), roomIds, service)`); `export const Room = host.objectClass(RoomBase)` and `export const Directory = host.objectClass(DirectoryBase)` (`DirectoryBase = createDirectoryClass(DurableObject, options)` from room-directory); `export default host.entry(worker)`. `host.deployFiles()` renders the deployment files from the same settings; write them next to the module. Cloudflare providers: write them, then run `sh deploy.sh` with the secret reference resolved into `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Own hardware: write `start.ts`, run `node start.ts`; it imports `server/node/register.ts` before the application module (a registered loader maps `cloudflare:workers` to a local shim and extensionless relative imports to `.ts`), then calls `serveNode`. `examples/worker.ts` composes the host with a small room service, `examples/start-own-hardware.ts` runs it, and `examples/rendered-host-settings.ts` is what aepm renders for one set of answers. `server/node/storage-export.ts` exports and imports the Node adapter's data as ndjson (see migration.json).

## Visual definition and connected examples
`visual/definition.json` maps its ports to the provided and required interfaces. `visual/examples/connected.json` connects the component to an illustrative application consumer. Both image formats and a text description are in `visual/output/`.

## Infrastructure
cloudflare-free and cloudflare-paid deploy one Worker with SQLite-backed Durable Objects (the only kind the free plan offers) to a Cloudflare account supplied by reference; nothing in the package holds an account value, and `wrangler.jsonc` carries only a comment naming the reference. own-hardware needs one machine with Node 26 or later, a port, and TLS in front if clients connect from https pages (the adapter speaks plain http and ws). Limits and prices are in suitability.json with their sources; the Node adapter has no measured limits.

## Verification
`node --test tests/web.test.ts` checks settings validation (every provider, account reference grammar, origins, regions), the `host-settings.ts` template rendered by a small pure renderer that mirrors aepm's `{{setting}}` rules (quoted positions, grammars, secret settings refused, defaults) and then loaded and handed to the host,, the origin policy and region placement against fake namespaces, the rendered deployment files, RFC 6455 framing, and the Node adapter end to end on a real socket with a small Workers-style service: HTTP routing to named objects, object-to-object calls, streamed bodies, WebSocket handshake, first message, auto ping reply, broadcast, binary frames, server and client close, protocol errors, alarms, abort and restart, persistence across a restart including a pending alarm, and storage export and import. `authoring/integration-realtime-rooms.ts` (not packaged) additionally runs the real realtime-rooms service on the Node adapter. Deployment to Cloudflare, the wrangler files against a real account, and TLS, load and long-running behaviour of the Node adapter were not exercised.

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5.0)

## Scenarios and presentation
A small table uses cloudflare-free and stays within the free request allowance; a larger or always-on service uses cloudflare-paid; a club that prefers its own machine uses own-hardware and keeps data in a folder it can back up. A server pinned to `eu` keeps its objects in the European Union jurisdiction on Cloudflare.

## Updates and removal
Patch updates replace the owned files; render the deployment files again after each update. The Node adapter's data format is described in migration.json (`ae/object-storage` 1.0.0). `accountReference` is a non-secret reference name with default `none` (a template cannot render a secret setting) and `allowedOrigins` has the default `http://localhost:5173`. `ServerSettings` is the lower layer that `createServerHost` takes; `serverSettings()` builds it from the rendered `hostSettings`. The Directory class comes from room-directory. Removal deletes the owned sources; on Cloudflare the Worker and its objects remain in the account until the owner deletes them, and on own hardware the data folder remains until the owner deletes it (export it first).
