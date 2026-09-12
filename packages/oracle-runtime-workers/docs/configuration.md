# Configuration and deployment

The complete, runnable reference is
[`apps/qiforge-workers-example`](../../../apps/qiforge-workers-example):
`wrangler.jsonc` (single-script layout, local harness),
`wrangler.devnet.jsonc` + `wrangler.gateway.devnet.jsonc` (the two-script
layout of the devnet oracle) and `.dev.vars.example`.

## Wrangler config

Both scripts need:

- `compatibility_flags: ["nodejs_compat"]`, a `compatibility_date` of
  2026-07-15 or later, `observability.enabled`.
- `alias`: `@matrix-org/matrix-sdk-crypto-wasm` →
  `@ixo/matrix-bot-workers-sdk/crypto-wasm-shim` (the crate's stock entry
  points cannot load on workerd; the shim imports the `.wasm` as a build-time
  `CompiledWasm` module and matrix-js-sdk resolves through it). The oracle
  script also aliases `jsdom` to the runtime's linkedom shim
  (`src/plugins/editor/jsdom-shim.ts`) for the editor plugin.
- `limits.cpu_ms: 300000` on the gateway script: the SDK's keep-alive alarm is
  one long invocation (a 5-minute hold while active) and a first boot runs
  the crypto init; both exceed the default 30 s DO CPU cap.
- Durable Object bindings `USER_ORACLE` (`UserOracleDO`) and `MATRIX_GATEWAY`
  (`MatrixGatewayDO`), both SQLite-backed (`new_sqlite_classes`).
- A cron trigger (`*/5 * * * *`) on whichever script hosts the gateway: the
  keep-alive safety net for its sync loop.
- A Cloudflare `ratelimits` binding named `RATE_LIMIT` on the oracle script
  (the example uses 100 requests / 60 s). The shell enforces it per
  authenticated user DID, so co-located users never share a bucket and a
  leaked token cannot burn unbounded LLM spend. No binding = no limiting
  (local harness). Pair it with a WAF rate-limiting rule at the edge for
  unauthenticated flood protection.

### Two scripts and migrations

The gateway's own script binds `MATRIX_GATEWAY` locally and `USER_ORACLE`
with `script_name: <oracle script>`; the oracle script binds `MATRIX_GATEWAY`
with `script_name: <gateway script>` and must not declare the gateway class
itself. Deploy order on a fresh deployment: gateway script, its secrets,
then the oracle script.

Two migration histories exist in the devnet config and both matter when
reusing it:

1. **Splitting a single-script deployment.** The gateway script's first
   migration is a `transferred_classes` entry (`from_script: <oracle
script>`), which moves the existing `MatrixGatewayDO` namespace — crypto
   snapshot, device identity, caches — into the new script, so the bot keeps
   its device. The oracle script keeps its `new_sqlite_classes` migration as
   history.
2. **Re-creating the gateway namespace.** Moving the gateway onto
   `@ixo/matrix-bot-workers-sdk` changed the object's storage layout, so the
   devnet gateway was wiped through a `v2` `deleted_classes` + `v3`
   `new_sqlite_classes` pair. Cloudflare refuses `deleted_classes` while any
   binding still references the class, including the oracle script's
   cross-script one, so it takes four deploys: the oracle script without the
   `MATRIX_GATEWAY` binding, the gateway script with the delete migration
   (its own binding removed), the gateway script with the new-class
   migration and binding, then the oracle script with its binding restored.
   The bot boots as a fresh device; retire the previous devices by hand
   (see [operations](operations.md#devices-and-rotation)). Any other
   deployment that still carries pre-SDK gateway objects needs the same
   sequence.

## Dependencies

The editor chain (`@ixo/editor`, `@ixo/matrix-crdt`, `@blocknote/*`,
`y-prosemirror`, `y-protocols`) and the runtime's own editor and flows
plugins hand `Y.Doc`s to each other, so a Workers bundle must contain exactly
one copy of `yjs`. A second copy makes yjs log `Yjs was already imported` at
isolate boot and breaks the `instanceof` checks the CRDT libraries rely on.
`@ixo/editor` 6.0.1 pins `yjs` 13.6.27 exactly while everything else resolves
to 13.6.32, which is enough to split the bundle. This repo collapses it with a
pnpm override (`pnpm-workspace.yaml` → `overrides.yjs`) and the runtime
declares the same exact version. **Every app built on the runtime has to
carry the same override** until `@ixo/editor` widens its pin — pnpm does not
inherit overrides from a dependency:

```yaml
# pnpm-workspace.yaml (or "pnpm": { "overrides": { … } } in package.json)
overrides:
  yjs: '13.6.32'
```

Verify after `pnpm install`: the bundle from
`wrangler deploy --dry-run --outdir <dir>` must contain the string
`Yjs was already imported` exactly once (yjs embeds it once per copy).
`lib0`, `y-protocols` and `@ixo/matrix-crdt` already resolve to single
copies.

## Environment

Non-secret values go in `vars`; secrets through `wrangler secret put` (or
`.dev.vars` under `wrangler dev`). The gateway script needs only the
identity, auth and Matrix groups plus `LOG_LEVEL`. Plugins read their own
variables (e.g. `MEMORY_MCP_URL`, `FIRECRAWL_MCP_URL`, `SANDBOX_MCP_URL`,
`DOMAIN_INDEXER_URL`, `SKILLS_CAPSULES_BASE_URL`, `COMPOSIO_*`) through the
same object; each plugin's `configSchema` is the reference.

### Identity and auth

| Variable                    | Required | Meaning                                                                                                                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ORACLE_NAME`               | yes      | Display name (device names, replies).                                                                                                                                                                              |
| `ORACLE_DID`                | yes      | UCAN audience — the DID users address invocations and delegations to; routes user objects.                                                                                                                         |
| `ORACLE_ENTITY_DID`         | no       | On-chain entity DID; forms the oracle half of the user ↔ oracle room alias (falls back to the DID).                                                                                                                |
| `NETWORK`                   | no       | `mainnet` / `testnet` / `devnet`; picks defaults for the VFS and UCAN store URLs.                                                                                                                                  |
| `BLOCKSYNC_GRAPHQL_URL`     | yes      | Blocksync GraphQL endpoint for `did:ixo` key resolution and users' homeserver lookup.                                                                                                                              |
| `UCAN_AUTH_MAX_TTL_SECONDS` | no       | Maximum lifetime accepted for a user auth invocation (default 900).                                                                                                                                                |
| `ORACLE_SIGNING_MNEMONIC`   | no       | Ed25519 mnemonic the oracle signs downstream UCAN invocations with (secret). Unset = read from the account room like the Node runtime (needs `MATRIX_ACCOUNT_ROOM_ID` + `MATRIX_VALUE_PIN`; see first-time setup). |

### Matrix

| Variable                       | Required | Meaning                                                                                                                                      |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATRIX_BASE_URL`              | yes      | Homeserver base URL of the bot account.                                                                                                      |
| `MATRIX_ORACLE_ADMIN_USER_ID`  | yes      | The bot's Matrix user id.                                                                                                                    |
| `MATRIX_ORACLE_ADMIN_PASSWORD` | yes      | The bot's password (secret). The gateway logs its own device in with it and mints a second, crypto-less device for plugins. No access token. |
| `MATRIX_RECOVERY_PHRASE`       | no       | SSSS recovery passphrase (secret): lets a fresh device restore room keys from the account's key backup. The literal value `secret` is unset. |
| `MATRIX_HOMESERVER_NAME`       | no       | Server name for room aliases when a user's DID document names none (default: the bot user id's server).                                      |
| `MATRIX_ACCOUNT_ROOM_ID`       | no       | The oracle's account room, where the CLI published the P-256 encryption key; needed for per-room secrets.                                    |
| `MATRIX_VALUE_PIN`             | no       | PIN the published private key is encrypted with (secret).                                                                                    |
| `MATRIX_SEND_RATE_PER_SECOND`  | no       | Outgoing-message pacing, see below (SDK default 3).                                                                                          |
| `MATRIX_SEND_BURST`            | no       | Token-bucket burst (SDK default 40; keep below the server's `burst_count`).                                                                  |
| `MATRIX_SEND_CONCURRENCY`      | no       | Parallel sends across rooms and the encryption gate (SDK default 4; devnet 6).                                                               |
| `MATRIX_TURN_CONCURRENCY`      | no       | Room turns in flight at once in the gateway (default 4).                                                                                     |
| `MATRIX_RECYCLE_AFTER_SENDS`   | no       | Idle recycle of the gateway object after this many sends (default 300; 0 disables).                                                          |
| `MATRIX_HOT_ROOMS`             | no       | Rooms kept fully built in memory (SDK default 64; idle rooms are released after 10 minutes).                                                 |
| `MATRIX_BACKFILL_MAX_EVENTS`   | no       | Cap on events replayed per room after a restart (SDK default 0 = unbounded).                                                                 |

### Storage

| Variable            | Required | Meaning                                                                                                                                                           |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OWNER_STORE`       | no       | Unset = the IXO VFS is the system of record (Matrix media read once as legacy). `matrix` forces legacy room-media storage — local harness only.                   |
| `VFS_BASE_URL`      | no       | IXO VFS worker (defaults per `NETWORK`). Setting it explicitly also activates the vfs plugin.                                                                     |
| `UCAN_STORE_URL`    | no       | UCAN store worker the vfs plugin's file tools read their grant from (defaults per `NETWORK`). The owner copy never uses it — it mints from the user's delegation. |
| `CHUNK_CACHE_BYTES` | no       | Per-object budget of clean 64 KiB chunks kept in memory (default 4 MiB, 1–64 MiB, `8m` / `8192k` accepted); `GET /debug/storage` reports hit/miss counters.       |

### LLM, tracing, BYO

| Variable                                                                                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPEN_ROUTER_API_KEY` (secret), `DEFAULT_MODEL`, `MODEL_PRICE_MARKUP`, `MAIN_REASONING_EFFORT`               | Platform model configuration; `LLM_PROVIDER=nebius` with `NEBIUS_API_KEY` for self-hosted models.                                                                                                                                                                                                                                                                                                                                                                        |
| `TURN_RECURSION_LIMIT`                                                                                       | LangGraph steps one turn may take (a model call, a batch of tool calls, a middleware hook each count) before it fails with `GraphRecursionError`. Default 600, three times the Node runtime's hard-coded 200. With the bundled middleware stack a tool-call round trip costs about 6 steps (measured on devnet: 60 failed after 10 chained calls), so 600 is roughly 100 chained tool calls; raise it for oracles whose turns chain more, lower it to cap runaway loops. |
| `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_ENDPOINT`, `LANGSMITH_TRACED_DIDS` | Global (`'true'`) or per-DID allowlist tracing (`*` = everyone).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BYO_LLM_ENABLED`                                                                                            | `'true'` enables the bring-your-own-credential lane (`/byo-llm/*`).                                                                                                                                                                                                                                                                                                                                                                                                      |
| `BYO_CHATGPT_BACKEND_URL`, `BYO_CHATGPT_PROXY_AUTH_TOKEN`, `BYO_CHATGPT_CLIENT_ID`                           | ChatGPT-subscription backend proxy (required on Cloudflare, see operations), its optional gate token, OAuth client id override.                                                                                                                                                                                                                                                                                                                                          |

### Ops and misc

| Variable                  | Meaning                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SLACK_ALERT_WEBHOOK_URL` | Slack incoming webhook (secret): one alert per whole-GB watermark as a user's working copy grows toward the 10 GB cap. |
| `ORACLE_DEBUG_ROUTES`     | `'true'` enables the authenticated `/debug/*` operator routes. Leave off in production.                                |
| `LOG_LEVEL`               | `debug` / `info` / `warn` / `error` (default `info`); also the SDK's log level in the gateway.                         |
| `CORS_ORIGIN`             | Default `*`.                                                                                                           |

## First-time setup of an oracle

1. **Bot account, password only.** Set `MATRIX_ORACLE_ADMIN_PASSWORD`. The
   gateway logs in its own device on first boot, keeps the token and device
   id in its storage, verifies the token with `/account/whoami` on later
   boots and re-logs in with the same device id if the homeserver rejected
   it; a rotation asks for a new device. An access token is deliberately not
   accepted: a token is a device, and a device shared with any other client
   (a Node oracle, a second deployment, a script) splits its encryption
   state into the one-time-key conflict loop described in
   [operations](operations.md#devices-and-rotation).
2. **Key backup, when migrating users from a Node oracle.** The
   `m.ixo.media_upload` pointer events holding each user's legacy checkpoint
   are megolm-encrypted by the Node oracle's device; the Workers gateway is a
   new device and can only read them by restoring the room keys from the
   account's server-side key backup. Before decommissioning the Node oracle:
   the account must have Secret Storage with an `m.megolm_backup.v1` secret
   (provisioned at onboarding; for dev accounts
   `apps/qiforge-workers-example/test/lib/provision-ssss.ts`); the Node
   oracle must have run with the real `MATRIX_RECOVERY_PHRASE` (it treats the
   literal `secret` as unset) so its bot SDK created the backup and uploaded
   its keys — check `GET /_matrix/client/v3/room_keys/version` returns a
   version with a non-zero `count`; and the Workers deployment gets the same
   `MATRIX_RECOVERY_PHRASE`. On first start the gateway logs the restored
   key count; without the backup `GET /sessions` comes back empty for
   migrated users and the log shows `HISTORICAL_MESSAGE_NO_KEY_BACKUP`.
   `test/e2e-migration.ts` proves the flow against the local harness.
3. **Account room key** for per-room secrets: `MATRIX_ACCOUNT_ROOM_ID` +
   `MATRIX_VALUE_PIN`, as published by `oracles-cli setup-encryption-key`.
   The same two settings let the runtime read the oracle's **UCAN signing
   mnemonic** the way the Node runtime stores it (state event
   `ixo.room.state.secure` / `encrypted_mnemonic_ed_signing`, encrypted with
   the PIN), so `ORACLE_SIGNING_MNEMONIC` is optional once the Node runtime
   or the CLI has provisioned the account room. The Workers runtime only
   reads it; a missing event or a wrong PIN is logged and leaves downstream
   UCAN minting off, never failing a boot.
4. **Wake the gateway**: it starts lazily on the first request and is then
   kept alive by its alarm and the cron; `POST /matrix/start` and
   `GET /matrix/status` show it.

## The bot's send rate

The gateway paces outgoing messages to the homeserver's per-sender limit
(`rc_message` in Synapse's `homeserver.yaml`; in our infra
`ixo-terra-infra/config/yml/helm_values/matrix-values.yml`, currently
`per_second: 3`, `burst_count: 40`; Synapse's own defaults are 0.2 / 10).

1. Find the real limit. There is no client API for it; if you cannot read the
   config, send `m.notice` events with the bot's credentials to a test room
   as fast as possible and note the first 429 and its `retry_after_ms`.
2. Set `MATRIX_SEND_RATE_PER_SECOND` = `per_second` and `MATRIX_SEND_BURST`
   below `burst_count` (devnet uses half: work-status cards, typing and
   receipts are not paced by the scheduler but share the same server
   bucket). Never configure above the server: a 429 costs a pause plus a
   20 % rate cut in the scheduler's adaptive back-off, and 8/s against a 3/s
   server collapsed the rate in testing.
3. To give one oracle bot more than the site-wide limit, ask the homeserver
   admin for a per-user override (takes effect immediately, no restart):

   ```bash
   curl -X POST "https://<homeserver>/_synapse/admin/v1/users/<bot user id>/override_ratelimit" \
     -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" \
     -d '{"messages_per_second": 10, "burst_count": 100}'
   # read back: GET the same URL; remove: DELETE the same URL
   ```

   `messages_per_second: 0` with `burst_count: 0` disables the limit for that
   user. Appservice-registered senders with `rate_limited: false` are exempt
   without an override. Then raise the two env values on the gateway (keep
   the burst margin) and redeploy it.

4. Check it live: `GET /matrix/status` → `sendScheduler.rateLimited` must
   stay 0 under load; `effectiveRate` shows the current adapted rate.

## Local development

`wrangler dev` with the single-script `wrangler.jsonc` and a `.dev.vars`
copied from `.dev.vars.example`. The ixo testing harness provides the
homeserver, Blocksync and mock MCP servers; `test/lib/oracle.ts` writes the
`.dev.vars` the e2e scripts need. `OWNER_STORE=matrix` there because the
harness has no VFS worker (`test/e2e-vfs.ts` starts one when needed).

## Deploying

```bash
cd apps/qiforge-workers-example
CLOUDFLARE_ACCOUNT_ID=<account> pnpm exec wrangler deploy -c wrangler.gateway.devnet.jsonc
CLOUDFLARE_ACCOUNT_ID=<account> pnpm exec wrangler secret bulk secrets.gateway.json -c wrangler.gateway.devnet.jsonc
CLOUDFLARE_ACCOUNT_ID=<account> pnpm exec wrangler deploy -c wrangler.devnet.jsonc
curl -X POST https://<oracle>/matrix/start && curl https://<oracle>/matrix/status
```

`wrangler deploy --dry-run --outdir <dir>` builds both bundles without
uploading and is the fastest check that the aliases resolve.
