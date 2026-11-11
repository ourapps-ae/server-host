# Server host instructions

## For the agent
Select `ourapps-ae/server-host` when the recipe's server target is chosen; pick the profile (`free` maps to cloudflare-free, `paid` to cloudflare-paid, own hardware to own-hardware) from the scale answer using suitability.json. Connect `room-session` and `room-directory` to the room service and directory components. Never put a Cloudflare token or account id in a setting: supply the name of the secret as `accountReference`. The recipe's server code imports `host-settings.ts` from the installed `components/server-host/server/` folder; do not write that file.

- Select package `ourapps-ae/server-host` version `0.5.0`.
- Settings to configure:
  - `provider` (string, slug; required)
  - `accountReference` (string, slug; optional; default `none`; the name of the secret, never its value)
  - `allowedOrigins` (string, address; optional; default `http://localhost:5173`)
  - `roomPrefix` (string, slug; required)
  - `region` (string, slug; optional; default `any`)
- Connect the provided `server-host` (ae/server-host 1.0.0) to the consumer that needs it.
- Supply `room-session` (ae/room-session 1.0.0) from the component that provides it.
- Supply `room-directory` (ae/room-directory 1.0.0) from the component that provides it (the Directory class comes from `room-directory`, not from `realtime-rooms`).
- Secrets are given by reference only, never by value: `accountReference` carries the name of the secret.
- aepm renders `components/server-host/server/host-settings.ts` and `wrangler.jsonc` from these settings; import `hostSettings` or `serverSettings()` from `host-settings.ts` and do not write either file. The application's worker module is `server/src/index.ts`.

## For the developer
Cloudflare: create an account, create an API token for Workers, store the account id and token in the release pipeline's secret store under the reference name, and give that name as `accountReference`; the pipeline exports `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for `deploy.sh`. From the application's server folder: Cloudflare, `npx wrangler deploy --config ../components/server-host/server/wrangler.jsonc` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` resolved from the reference; own hardware or local development, `node ../components/server-host/server/start.ts` with Node 26 or later, setting `PORT`, `HOST` and `DATA_DIRECTORY`, behind a TLS-terminating proxy, backing up the data folder (or running the ndjson export on a schedule). To check: run the commands below; for a live check call `GET /health` on the deployed address.

## How to check
From the component directory:

- `node --test tests/web.test.ts` (web, required-local; tools: node 26.5.0)
- `python3.12 -B /Users/george/Projects/com/my/tools/check_component.py components/server-host` validates the manifest, sidecars and runs the required-local suite.
