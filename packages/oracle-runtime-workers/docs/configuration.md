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
- With `ARTIFACT_BUCKET` bound, a cron trigger on the script that binds it
  (the oracle script in a gateway split; daily is enough): its tick sweeps
  expired artefact share copies. In the single-script layout the gateway's
  cron already covers it. The gateway script's cron never sweeps.
- A Cloudflare `ratelimits` binding named `RATE_LIMIT` on the oracle script
  (the example uses 100 requests / 60 s). The shell enforces it per
  authenticated user DID, so co-located users never share a bucket and a
  leaked token cannot burn unbounded LLM spend; a channel turn is counted
  as soon as its invocation proves the user, before the Auth Hub call. The
  unauthenticated routes that cost work are limited per client IP
  (`cf-connecting-ip`): the artefact data route, socket.io upgrades,
  `GET /matrix/status` and `POST /matrix/start`. Every key is
  `<ORACLE_DID>|<scope>|<subject>` (`rateLimitKey`, scopes `user`,
  `artifact`, `socket`, `status`, `start`), and the
  binding's `namespace_id` must be unique per oracle on the account:
  bindings that share a `namespace_id` share their counters, even across
  Workers. No binding = no limiting (local harness). Pair it with a WAF
  rate-limiting rule at the edge for unauthenticated flood protection.
- Optionally a Workers AI binding named `AI` (`"ai": { "binding": "AI" }`)
  when the oracle uses [Decisions](#decisions) with
  `DECISION_PROVIDER=cloudflare-jev`: the binding authenticates implicitly, so
  no Cloudflare account credentials are needed. Leave it off otherwise.
- The other optional bindings are described with their feature below: the
  R2 buckets `TIER_BUCKET` ([storage](#storage)) and `ARTIFACT_BUCKET`
  ([chat delivery](#chat-delivery-and-artefacts)), the `FEEDBACK_RATE_LIMIT`
  rate limiter ([feedback](#anonymous-response-feedback)) and the `AUTH_HUB`
  service binding ([channels](#channels-ingress)).

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

LangSmith before 0.6.0 can trust public prompt pulls implicitly
(CVE-2026-45134). The runtime and `@ixo/common` depend on `langsmith`
`^0.6.0`, and this repo also forces every other path (LangChain's own
dependency on it) onto the patched line with a second override. pnpm does
not inherit it either, so an app that wants the same guarantee for its
transitive copies carries it too, and checks with `pnpm why langsmith`:

```yaml
overrides:
  'langsmith@<0.6.0': '^0.6.0'
```

## Environment

Non-secret values go in `vars`; secrets through `wrangler secret put` (or
`.dev.vars` under `wrangler dev`). The gateway script needs only the
identity, auth and Matrix groups plus `LOG_LEVEL`. Plugins read their own
variables (e.g. `MEMORY_MCP_URL`, `FIRECRAWL_MCP_URL`, `SANDBOX_MCP_URL`,
`DOMAIN_INDEXER_URL`, `SKILLS_CAPSULES_BASE_URL`, `COMPOSIO_*`,
`IXO_TRANSACTION_*`) through the same object; each plugin's `configSchema` is
the reference. Two plugin keys gate money: `POD_CREATOR_ALLOW_MAINNET`
(default `false`) must be `'true'` before the POD Creator plugin prepares a
mainnet creation batch — with `NETWORK` at its `mainnet` default and the flag
unset, the create path refuses ([pod-creator](pod-creator.md)); the opt-in
wallet-signing plugin's variables, including `IXO_TRANSACTION_ALLOW_MAINNET`,
are described in [ixo-transaction](ixo-transaction.md#configuration). The
`IXO_TRANSACTION_CHAIN_ID_DEVNET` / `_TESTNET` / `_MAINNET` chain ids are
declared by both wallet-signing plugins (the same schema objects, so the
boot does not report them as a collision): one set of variables names the
chain for `sign_ixo_transaction` and for the POD Creator's
`request_pod_signature`, whichever plugins the oracle loads.

### Identity and auth

| Variable                              | Required | Meaning                                                                                                                                                                                                                                                |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ORACLE_NAME`                         | yes      | Display name (device names, replies).                                                                                                                                                                                                                  |
| `ORACLE_DID`                          | yes      | UCAN audience — the DID users address invocations and delegations to; routes user objects.                                                                                                                                                             |
| `ORACLE_ENTITY_DID`                   | no       | On-chain entity DID; forms the oracle half of the user ↔ oracle room alias (falls back to the DID).                                                                                                                                                    |
| `NETWORK`                             | no       | `mainnet` / `testnet` / `devnet`; picks defaults for the VFS and UCAN store URLs.                                                                                                                                                                      |
| `BLOCKSYNC_GRAPHQL_URL`               | yes      | Blocksync GraphQL endpoint for `did:ixo` key resolution and users' homeserver lookup.                                                                                                                                                                  |
| `UCAN_AUTH_MAX_TTL_SECONDS`           | no       | Maximum lifetime accepted for a user auth invocation (default 900).                                                                                                                                                                                    |
| `UCAN_ALLOW_BARE_DELEGATION_AUTH`     | no       | `true` lets an `x-ucan-delegation` without an invocation authenticate (the legacy fallback, logged per HTTP request and per socket CONNECT as `[auth] … authenticated with a bare delegation`). Off by default: requests must carry a UCAN invocation. |
| `UCAN_REAUTH_PROMPT_THROTTLE_SECONDS` | no       | Minimum time between two `delegation_required` prompts a Matrix turn posts for one user without a usable delegation (default 21600 = 6 h; anything not a positive number keeps the default). See [operations](operations.md#best-effort-room-posts).   |
| `ORACLE_SIGNING_MNEMONIC`             | no       | Ed25519 mnemonic the oracle signs downstream UCAN invocations with (secret). Unset = read from the account room like the Node runtime (needs `MATRIX_ACCOUNT_ROOM_ID` + `MATRIX_VALUE_PIN`; see first-time setup).                                     |

### Matrix

| Variable                          | Required | Meaning                                                                                                                                                                                                                                            |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATRIX_BASE_URL`                 | yes      | Homeserver base URL of the bot account.                                                                                                                                                                                                            |
| `MATRIX_ORACLE_ADMIN_USER_ID`     | yes      | The bot's Matrix user id.                                                                                                                                                                                                                          |
| `MATRIX_ORACLE_ADMIN_PASSWORD`    | yes      | The bot's password (secret). The gateway logs its own device in with it and mints a second, crypto-less device for plugins. No access token.                                                                                                       |
| `MATRIX_RECOVERY_PHRASE`          | no       | SSSS recovery passphrase (secret): lets a fresh device restore room keys from the account's key backup. The literal value `secret` is unset.                                                                                                       |
| `MATRIX_HOMESERVER_NAME`          | no       | Server name for room aliases when a user's DID document names none (default: the bot user id's server).                                                                                                                                            |
| `MATRIX_ACCOUNT_ROOM_ID`          | no       | The oracle's account room, where the CLI published the P-256 encryption key; needed for per-room secrets.                                                                                                                                          |
| `MATRIX_VALUE_PIN`                | no       | PIN the published private key is encrypted with (secret).                                                                                                                                                                                          |
| `MATRIX_SEND_RATE_PER_SECOND`     | no       | Outgoing-message pacing, see below (SDK default 3).                                                                                                                                                                                                |
| `MATRIX_SEND_BURST`               | no       | Token-bucket burst (SDK default 40; keep below the server's `burst_count`).                                                                                                                                                                        |
| `MATRIX_SEND_CONCURRENCY`         | no       | Parallel sends across rooms and the encryption gate (SDK default 4; devnet 6).                                                                                                                                                                     |
| `MATRIX_TURN_CONCURRENCY`         | no       | Room turns in flight at once in the gateway (default 4).                                                                                                                                                                                           |
| `MATRIX_RECYCLE_AFTER_SENDS`      | no       | Idle recycle of the gateway object after this many sends (default 300; 0 disables).                                                                                                                                                                |
| `MATRIX_HOT_ROOMS`                | no       | Rooms kept fully built in memory (SDK default 64; idle rooms are released after 10 minutes).                                                                                                                                                       |
| `MATRIX_BACKFILL_MAX_EVENTS`      | no       | Cap on events replayed per room after a restart (SDK default 0 = unbounded).                                                                                                                                                                       |
| `MATRIX_SYNC_TIMELINE_LIMIT`      | no       | Gateway memory guard: events per room per `/sync` batch (SDK default 30).                                                                                                                                                                          |
| `MATRIX_SYNC_BYTES_CAP`           | no       | Gateway memory guard: largest `/sync` response held in memory (SDK default 16 MiB; `0` = no cap). Over it the batch is re-requested at timeline limit 1 and busy rooms catch up through `/messages`.                                               |
| `MATRIX_CATCHUP_PAGE_SIZE`        | no       | Gateway memory guard: events per catch-up `/messages` page (SDK default 100).                                                                                                                                                                      |
| `MATRIX_PAGE_BYTES_CAP`           | no       | Gateway memory guard: largest catch-up page held in memory (SDK default 10 MiB; `0` = no cap); a bigger page is refused unread and fetched again smaller, down to one event.                                                                       |
| `MATRIX_MAX_DECRYPT_BYTES`        | no       | Gateway memory guard: refuse to decrypt an event whose ciphertext is larger than this (SDK default 0 = off).                                                                                                                                       |
| `MATRIX_BACKUP_BULK_RESTORE`      | no       | `true`: on a device's first start restore every room key the key backup holds in one go, capped by `MATRIX_BACKUP_BULK_RESTORE_MAX_KEYS` (SDK default 5,000; a larger backup is skipped). Default off: keys are fetched from the backup on demand. |
| `MATRIX_KEEPALIVE_FUSE_MS`        | no       | Gateway keep-alive fuse: the alarm is re-armed this far ahead while the object works, so a host drain brings it back within the fuse (SDK default 10 s, floor 2 s, `0` = off).                                                                     |
| `MATRIX_GROUP_ROOMS`              | no       | Gateway: what the bot does in a room with more than two members — `silent` (default: never speaks there), `gate` (the Node group-chat lane), `answer` (every room is direct). See [operations](operations.md#rooms-group-chats).                   |
| `GROUP_CHAT_ACTIVE_THREAD_TTL_MS` | no       | Gateway: how long a thread the bot answered in stays "active" (default 30 min, min 1 min).                                                                                                                                                         |
| `GROUP_CHAT_REQUIRE_POWER_LEVEL`  | no       | Gateway: extra minimum power level the bot needs before posting in a group room (default 0 = the room's own threshold).                                                                                                                            |
| `GROUP_CHAT_ROOM_INFO_TTL_MS`     | no       | Gateway: how long room membership, the direct-room flag and display names stay cached (default 30 min, min 1 min).                                                                                                                                 |

### Storage

| Variable                   | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OWNER_STORE`              | no       | Unset = the IXO VFS is the system of record (Matrix media read once as legacy). `matrix` forces legacy room-media storage — local harness only.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `VFS_BASE_URL`             | no       | IXO VFS worker (defaults per `NETWORK`). Setting it explicitly also activates the vfs plugin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `UCAN_STORE_URL`           | no       | UCAN store worker the vfs plugin's file tools read their grant from (defaults per `NETWORK`). The owner copy never uses it — it mints from the user's delegation.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CHUNK_CACHE_BYTES`        | no       | Per-object budget of clean 64 KiB chunks kept in memory (default 4 MiB, 1–64 MiB, `8m` / `8192k` accepted); `GET /debug/storage` reports hit/miss counters.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TIER_BUCKET`              | no       | **Binding**, not a var: `"r2_buckets": [{ "binding": "TIER_BUCKET", "bucket_name": "<oracle>-tier" }]`. Turns on the [R2 page tier](architecture.md#r2-page-tier): chunks no turn touched for two days move out of DO storage into 1 MiB R2 segments under the object's id, and the per-user size limit becomes R2's (none in practice). **Absent = the pre-tier behaviour: every chunk stays in the object's SQLite, with Durable Objects' 10 GB cap per user.** Create the bucket once (`wrangler r2 bucket create <name>`); never share one bucket between oracles that could carry the same object ids. |
| `TIER_HOT_BUDGET_BYTES`    | no       | Soft target for hot bytes per user object (default `16m`, 1 MiB–1 GiB); logged when a pass cannot get under it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `TIER_EVICT_AFTER_PERIODS` | no       | Periods a chunk must go untouched before eviction (default 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TIER_PERIOD_MS`           | no       | Length of one access-tracking period (default one day; ≥ 1000). Tests shorten it; production keeps the day.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Channels ingress

`POST /channels/turn` lets IXO Channels (WhatsApp now) submit a turn to the
user's Companion; the authorization model, retries and replies are in
[channels](channels.md). Set these on the script that serves HTTP (the
oracle script in a gateway split).

| Binding or variable            | Required         | Meaning                                                                                                                                                                                               |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_SERVICE_DID`          | to enable        | The one channel service DID allowed to invoke this deployment. Unset = the route answers `503 Channels are not configured`.                                                                           |
| `AUTH_HUB_CHANNEL_SERVICE_KEY` | with the route   | Dedicated credential (secret) sent as `x-channels-service-key` when the runtime asks Auth Hub whether a channel binding is active. Never an operator credential.                                      |
| `AUTH_HUB`                     | one of these two | **Binding**, not a var: a Cloudflare service binding to Auth Hub (`"services": [{ "binding": "AUTH_HUB", "service": "<auth hub worker>" }]`). Used in preference to `AUTH_HUB_URL` when both are set. |
| `AUTH_HUB_URL`                 | one of these two | Auth Hub's origin when there is no service binding. Must be `https`.                                                                                                                                  |

Without the key, or without both `AUTH_HUB` and `AUTH_HUB_URL`, binding
validation is "not configured": a new channel turn gets `503` and nothing is
recorded, and an admitted run waits on the recovery backoff
([channels](channels.md#authorization)). Channel turns count against
`RATE_LIMIT` under the user's DID, like an authenticated request.

### Chat delivery and artefacts

Turns from IXO Channels reply in chat style: a few short messages, with a browser document for anything long. Matrix rooms do so only when `MATRIX_CHAT_DELIVERY=true`. The Portal and scheduled tasks keep the whole reply. See [chat delivery](chat-delivery.md). New artefacts need a bucket and a public origin. Without them, long chat replies are split into messages, and `create_artifact` is not offered. The env schema rejects a malformed or insecure URL, a lifetime outside 1–365 days and a sweep interval outside 1–168 hours at boot; the user object also logs a warning when the bucket is bound without `ORACLE_PUBLIC_URL` (or the other way round).

| Variable                        | Required      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATRIX_CHAT_DELIVERY`          | no            | `true` gives Matrix room turns the chat style (one event per part, artefacts for long content). Unset = `OracleConfig.delivery.matrixChat`, which defaults to off: one plain message per reply, as before. Set it on the script that runs `UserOracleDO` (the oracle script in a gateway split). When set, it wins over the code setting.                                                                                   |
| `ARTIFACT_BUCKET`               | no            | **Binding**, not a var: `"r2_buckets": [{ "binding": "ARTIFACT_BUCKET", "bucket_name": "<oracle>-artifacts" }]`. Holds the encrypted share copies under `art/`. It never holds plaintext.                                                                                                                                                                                                                                   |
| `ORACLE_PUBLIC_URL`             | with a bucket | The oracle script's public origin, for example `https://companion.devnet.ixo.earth`. Links are `<origin>/a/<id>#k=<key>`. It must be `https`; `http` is allowed only for `localhost` and `127.0.0.1` (anything else fails boot). Without it no new artefact is made, but stored ones stay readable (`GET /artifacts/:id`, no `url`), revocable and deleted with their session.                                              |
| `ARTIFACT_VIEWER_URL`           | no            | A shared viewer page that opens links instead of the oracle's own page: the Portal's `/artifact` page on Qi.Space (`https://<portal host>/artifact`). Links become `<viewer>#a=<source>&k=<key>`; the viewer fetches `<source>/data` and decrypts in the browser. The Portal fetches only from hosts in its `NEXT_PUBLIC_ARTIFACT_SOURCE_HOSTS` (default `ixo.earth`). Unset = the built-in page, which needs nothing else. |
| `ARTIFACT_LINK_TTL_DAYS`        | no            | Link lifetime in whole days, 1 to 365 (default 30; a value outside the range fails boot). Links are bearer links until they expire: see the [link policy](../../../README.md#artefact-link-policy).                                                                                                                                                                                                                         |
| `ARTIFACT_SWEEP_INTERVAL_HOURS` | no            | Hours between full sweeps of expired share copies, 1 to 168 (default 24; a value outside the range fails boot). The sweep runs on the cron tick of the script that binds `ARTIFACT_BUCKET`; between sweeps a tick costs one R2 read.                                                                                                                                                                                        |

The runtime removes share copies nobody opened itself: the cron tick of the script that binds the bucket sweeps `art/` and deletes every copy whose `expiresAt` has passed (see [operations](operations.md#artefact-sweep)). That needs a cron trigger on that script. The data route already refuses expired copies in between. Create the bucket once:

```bash
wrangler r2 bucket create <oracle>-artifacts
```

A lifecycle rule on `art/` is now optional, as belt and braces. If you add one, set it to `ARTIFACT_LINK_TTL_DAYS + 1` days, so it never removes a copy whose link still works (31 for the default 30), and raise it whenever you raise the TTL:

```bash
wrangler r2 bucket lifecycle add <oracle>-artifacts artefact-expiry art/ --expire-days 31
```

`OracleConfig.delivery` tunes the behaviour: `matrixChat: true` gives Matrix rooms the chat style in code (`MATRIX_CHAT_DELIVERY` overrides it when set), and `limits` overrides the per-surface limits.

### LLM, tracing, BYO

| Variable                                                                                                                                                                                                                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPEN_ROUTER_API_KEY` (secret), `DEFAULT_MODEL`, `MODEL_PRICE_MARKUP`, `MAIN_REASONING_EFFORT`                                                                                                                                            | Platform model configuration; `LLM_PROVIDER=nebius` with `NEBIUS_API_KEY` for self-hosted models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TURN_RECURSION_LIMIT`                                                                                                                                                                                                                    | LangGraph steps one turn may take (a model call, a batch of tool calls, a middleware hook each count) before it fails with `GraphRecursionError`. Default 600, three times the Node runtime's hard-coded 200. With the bundled middleware stack a tool-call round trip costs about 6 steps (measured on devnet: 60 failed after 10 chained calls), so 600 is roughly 100 chained tool calls; raise it for oracles whose turns chain more, lower it to cap runaway loops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RUN_KEEPALIVE_MS`, `RUN_SEGMENT_FLUSH_MS`, `RUN_SEGMENT_BYTES`, `RUN_RECOVERY_ATTEMPTS`, `RUN_RECOVERY_DELAYS_MS`, `TURN_MULTITASK_DEFAULT`                                                                                              | Durable runs (see [operations](operations.md#turns-durable-runs)): the keep-alive alarm horizon while a run executes (default 20000 ms), how often the streamed output is packed into SQLite (2000 ms / 16384 bytes), how many consecutive recovery attempts without progress a reset run gets before it is closed as interrupted (4) and the delay before each (`5000,15000,30000,60000`), and what a new message does to a run already active on its session (`interrupt`, or `enqueue`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MODEL_CONTEXT_TOKENS`, `MODEL_CONTEXT_OVERRIDES`                                                                                                                                                                                         | Context windows (see [operations](operations.md#turns-context-budgets)): the window for a model no source knows (default 100000, min 16000) and explicit per-model windows as `model=tokens,…` (`openai/gpt-5.6-luna=400000`). Everything else is resolved from the OpenRouter `/models` listing per model, and lowered permanently when a provider's "too long" error names a smaller limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CONTEXT_SUMMARIZE_FRACTION`, `CONTEXT_PRUNE_FRACTION`, `CONTEXT_RESULT_CAP_FRACTION`, `CONTEXT_RESULT_CAP_MAX_CHARS`, `CONTEXT_REQUEST_FRACTION`, `CONTEXT_OUTPUT_RESERVE_TOKENS`, `CONTEXT_KEEP_MESSAGES`, `CONTEXT_SUMMARIZE_MESSAGES` | Fractions of the model's window at which the history is summarized (0.5), old tool results are pruned from the request (0.35), one tool result is capped (0.12, ×4 chars, never above the ceiling of 200,000 chars — a million-token window does not make a half-megabyte tool result useful; the rest is reachable through `read_result`), and a request is refused (0.95, minus the reply reserve of 8000 tokens, at most a quarter of the window); the recent messages the summarizer keeps verbatim (10); and an optional message-count trigger on top of the token one (unset: tokens only). What the summarizer reads is also bounded by the window of the model that writes the summary (the routing model), and summarizing starts at the smallest of the summarize fraction of the window, the request cap and that summary input limit, so the summarizer never has to drop history it was meant to condense: with a 400k main model and a 131,072-token summarizer, summarizing (and pruning) start at about 112k tokens. |
| `TOOL_RESULT_TTL_HOURS`, `TOOL_RESULT_R2_MIN_BYTES`                                                                                                                                                                                       | Saved tool results (the whole text behind a capped result): lifetime (24) and the size from which they go to the R2 tier bucket instead of the object's SQLite (1000000; 65536 … 1500000).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_ENDPOINT`, `LANGSMITH_TRACED_DIDS`                                                                                                                              | Global (`'true'`) or per-DID allowlist tracing (`*` = everyone).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BYO_LLM_ENABLED`                                                                                                                                                                                                                         | `'true'` enables the bring-your-own-credential lane (`/byo-llm/*`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `BYO_CHATGPT_BACKEND_URL`, `BYO_CHATGPT_PROXY_AUTH_TOKEN`, `BYO_CHATGPT_CLIENT_ID`                                                                                                                                                        | ChatGPT-subscription backend proxy (required on Cloudflare, see operations), its optional gate token, OAuth client id override.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Decisions

Bounded semantic Decisions (`getDecisions` / `ctx.decisions`). The provider
`DECISION_PROVIDER` selects is registered under that value as its id
(`cloudflare-jev` / `openrouter-jev`) and is the default provider.
`createOracleWorker({ decisionProviders, decisionProviderPolicy })` registers
further host providers beside it and routes Decisions between them
(`defaultProviderId`, exact per-Decision `routes`); a caller may pick one per
evaluation with `{ providerId }`. With no provider at all every
`ctx.decisions` call rejects with `DecisionProviderUnavailableError`; with
several and neither a route nor a default for a Decision, its evaluation
rejects with `AmbiguousDecisionProviderError`. A policy naming an unknown
provider, a duplicate provider id, or `decisionProviders` together with
`decisionAdapter` fails the boot. `createOracleWorker({ decisionAdapter })`
supplies a single adapter (provider `host`) and bypasses these variables. A
Decision whose projection declares its evidence incomplete is refused with
`DecisionNotApplicableError` before any provider is called. See
`docs/architecture/decisions.md#choosing-a-provider` at the repo root.

When the turn is traced (see the LangSmith variables), every evaluation is a
`decision:<name>` span on the turn's tracer: a tool's Decision nests under the
tool, and the capability router's Decision is its own trace with the turn's
`thread_id`. See `docs/architecture/decisions.md#tracing` at the repo root.

| Variable                                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DECISION_PROVIDER`                                      | `openrouter-jev` (the Jev model on OpenRouter; reuses `OPEN_ROUTER_API_KEY`) or `cloudflare-jev` (Jev on Workers AI).                                                                                                                                                                                                                                                                      |
| `DECISION_MODEL`                                         | Model id override. Default `typesafe/jev-1.13` on OpenRouter, `typesafe/jev` on Workers AI.                                                                                                                                                                                                                                                                                                |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (secret) | Only for `cloudflare-jev` **without** the `AI` binding: the account and Workers AI token for the REST API. With `"ai": { "binding": "AI" }` declared in `wrangler.jsonc` the binding is used and neither is needed.                                                                                                                                                                        |
| `CAPABILITY_ROUTER`                                      | Capability router, the runtime's own Decision (requires a `DECISION_PROVIDER`). `off` (default) never evaluates; `shadow` evaluates off the turn's path and logs `[capability-router-shadow]` verdicts for accuracy measurement; `on` awaits the verdict before the first model call and preloads the predicted on-demand plugin's tools for that turn only. Any failure preloads nothing. |

### Anonymous response feedback

Users can send anonymous free-text feedback about one completed Agent reply
(`POST /messages/:sessionId/:messageId/feedback`). Each user can give one
feedback per reply, and it becomes one Linear issue; a retry of the same
submission never creates a second one. Off unless both the Linear key and the HMAC secret are set; then
the transcript routes advertise `capabilities.anonymousMessageFeedback` and
the client SDK shows the control. Setting only one of the two, a secret
shorter than 32 characters, a malformed id or an insecure API URL fails the
boot (`Anonymous feedback is half-configured …` / `… configuration is
invalid …`; the message names keys, never values). Set them on the script
that serves HTTP (the oracle script in a gateway split). What operators see
and what is never sent: [operations](operations.md#anonymous-response-feedback).

The runtime reads these keys in the shell. They are kept out of the
validated config plugins receive as `ctx.config`, and a plugin whose
`configSchema` declares any `FEEDBACK_` key fails the boot. A plugin HTTP
route (`getRoutes`) still receives the raw Worker env, which holds these keys
like every other binding and secret.

| Variable                     | Required        | Meaning                                                                                                                                                        |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEEDBACK_LINEAR_API_KEY`    | to enable       | Linear API key (secret) able to create issues in the feedback team, sent as `Authorization: <key>`. Use a key restricted to that team.                         |
| `FEEDBACK_HMAC_SECRET`       | to enable       | At least 32 characters (secret). Derives the user, session, message and IP pseudonyms. Rotating it starts new pseudonyms; old issues can no longer be grouped. |
| `FEEDBACK_LINEAR_TEAM_ID`    | no              | Linear team id (default Studio, `c781a53a-d432-469f-9c9c-2345a0f8243b`).                                                                                       |
| `FEEDBACK_LINEAR_PROJECT_ID` | no              | Linear project id (default "User Feedback from Portal", `6c1474a9-620c-4e3c-b443-0263992f3b55`).                                                               |
| `FEEDBACK_LINEAR_LABEL_IDS`  | no              | Comma-separated Linear label ids for every issue.                                                                                                              |
| `FEEDBACK_LINEAR_API_URL`    | no              | GraphQL endpoint (default `https://api.linear.app/graphql`; `http` only on localhost — the harness e2e points it at a fake).                                   |
| `QIFORGE_BUILD_VERSION`      | no              | Release or commit shown as "QiForge build" in the issue (default `unknown`).                                                                                   |
| `FEEDBACK_RATE_LIMIT`        | no, **binding** | `ratelimits` binding for the per-IP limit, e.g. `{ "name": "FEEDBACK_RATE_LIMIT", "namespace_id": "1002", "simple": { "limit": 3, "period": 60 } }`.           |

Without `FEEDBACK_RATE_LIMIT` the per-IP check uses `RATE_LIMIT` under a
feedback-only key, so it allows that binding's limit (100 a minute in the
example) per address; declare the dedicated binding to get the Node runtime's
3 a minute. With neither binding there is no per-IP limit. The per-user limit
(3 new submissions a minute) is kept in the user's object and needs no binding.

### Ops and misc

| Variable                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_ALERT_WEBHOOK_URL`    | Slack incoming webhook (secret): one alert per whole-GB watermark as a user's working copy grows toward the 10 GB cap.                                                                                                                                                                                                                                                                                                                                                       |
| `ORACLE_DEBUG_ROUTES`        | `'true'` enables the `/debug/*` operator routes; every one needs a UCAN invocation, the gateway's stop and restart included. Leave off in production.                                                                                                                                                                                                                                                                                                                        |
| `ORACLE_OPERATOR_DIDS`       | Optional, comma-separated DIDs allowed onto the gateway-wide operator routes `/debug/matrix/*` (stop, restart, abort, rotate-device, outbox, event). When set, every other authenticated caller gets 403 there. A list with an entry that is not a DID admits nobody and logs an error. Unset: any authenticated caller may use them while `ORACLE_DEBUG_ROUTES=true` — set it on any shared deployment that enables debug routes. The per-user debug routes are unaffected. |
| `TOPIC_DELIVERABLES_ENABLED` | `'true'` enables the owner-only Topic deliverable routes (`/topic-deliverables/*`, see [architecture](architecture.md#topic-deliverable-api)). Off by default: the routes and the object's RPC answer `404`. Read the known limits there before turning it on.                                                                                                                                                                                                               |
| `LOG_LEVEL`                  | `debug` / `info` / `warn` / `error` (default `info`); also the SDK's log level in the gateway.                                                                                                                                                                                                                                                                                                                                                                               |
| `CORS_ORIGIN`                | Default `*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Built-in limits

Not configurable; listed so an operator knows where each refusal comes
from. Behaviour is in [operations](operations.md).

| Constant                                                                                    | Value                 | Where it applies                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_TURN_BODY_BYTES`                                                                       | 256 KiB               | `POST /messages/:id` body (413 above it, checked before the body is read; `src/shell/turn-body-cap.ts`).                                                                                           |
| `DELEGATION_BODY_BYTES`, `BYO_LLM_BODY_BYTES`, `DEBUG_BODY_BYTES`                           | 64 KiB each           | `POST /delegation`, `/byo-llm/*`, `/debug/*` bodies (`src/shell/app.ts`).                                                                                                                          |
| `ABORT_BODY_BYTES`                                                                          | 4 KiB                 | `POST /messages/abort` body.                                                                                                                                                                       |
| `HANDSHAKE_DEADLINE_MS`, `MAX_PAYLOAD_BYTES`                                                | 10 s, 1,000,000 bytes | A socket must authenticate within the deadline; a larger text frame closes it with 1009 (`src/realtime/`).                                                                                         |
| `BLOCKSYNC_LOOKUP_TIMEOUT_MS`                                                               | 5 s                   | One Blocksync homeserver lookup in the gateway (`src/matrix/user-homeserver.ts`); the user object bounds its own at 3 s.                                                                           |
| `UNREGISTERED_CACHE_TTL_MS`                                                                 | 5 min                 | How long the gateway remembers that a DID document names no homeserver (a DID Blocksync does not know is not cached).                                                                              |
| `DEFAULT_IXO_RESOLVER_TIMEOUT_MS`, `IXO_DID_RESOLUTION_CACHE_TTL_MS`                        | 3 s, 60 s             | did:ixo key resolution for UCAN validation (and the channel route's did:web service identity), and how long a resolved key set is reused per isolate.                                              |
| UCAN store / `did.json` look-up timeout (`fetchTimeoutMs`)                                  | 10 s                  | The user object's look-up of a service delegation in the UCAN store and of a service's `did.json` (`src/do/ucan-service.ts`).                                                                      |
| `MEDIA_DOWNLOAD_TIMEOUT_MS`, `DOWNLOAD_TIMEOUT_MS`                                          | 60 s                  | A Matrix media transfer in the gateway; any attachment download.                                                                                                                                   |
| `MAX_FILE_SIZE`, `MAX_TOTAL_SIZE`                                                           | 25 MB, 50 MB          | One attachment; all attachments of a turn, both lanes together.                                                                                                                                    |
| `OPENROUTER_FETCH_TIMEOUT_MS`, `OPENROUTER_FAILURE_TTL_MS`, `OPENROUTER_INFLIGHT_MARGIN_MS` | 3 s, 60 s, 1 s        | The OpenRouter `/models` fetch; the wait after a failed one; a shared fetch older than timeout + margin is abandoned and the next caller starts a new one.                                         |
| `CHATGPT_PROBE_TIMEOUT_MS`, `KEY_CHECK_TIMEOUT_MS`                                          | 5 s, 10 s             | The BYO ChatGPT reachability probe (no answer counts as reachable); a BYO API-key check (`src/llm/byo-service.ts`).                                                                                |
| `MAX_CONCURRENT_TASK_RUNS`, `MAX_RUNS_KEPT_PER_TASK`                                        | 3, 50                 | Due tasks one alarm tick runs at once; run-history rows kept per task (open ones on top).                                                                                                          |
| `COMPACT_STEP_MAX_BYTES`                                                                    | 8 MiB                 | Legacy-blob compactor step (at least one row).                                                                                                                                                     |
| `DEFAULT_TIER_ORPHAN_SWEEP_INTERVAL_MS`                                                     | 7 days                | R2 tier orphan sweep.                                                                                                                                                                              |
| `VFS_DELETE_MAX_PATHS`, `VFS_PATH_LOOKUP_CONCURRENCY`                                       | 50, 6                 | Paths per `vfs_delete` call; path lookups at once.                                                                                                                                                 |
| `MAX_VISION_BYTES`, `MAX_SANDBOX_TRANSFER_BYTES`                                            | 10 MB each            | `vfs_read` downloads of images and documents; `sandbox_to_vfs` / `vfs_to_sandbox` transfers.                                                                                                       |
| `SANDBOX_MCP_TIMEOUT_MS`, `MEMORY_TOOL_TIMEOUT_MS`, `FIRECRAWL_TOOL_TIMEOUT_MS`             | 180 s, 420 s, 120 s   | One sandbox, memory-engine or Firecrawl MCP call: the MCP request's own timeout (`metadata.timeoutMs`, otherwise the MCP SDK's 60 s default), plus the runtime's own timer that closes the client. |
| `COMPOSIO_TOOL_TIMEOUT_MS`                                                                  | 190 s                 | One Composio call, raced against the runtime's timer and the turn's abort (the SDK takes no signal; see operations).                                                                               |
| `MAX_TONE_LENGTH`                                                                           | 120 characters        | The stored `tone` preference.                                                                                                                                                                      |
| `DOC_WRITE_MAX_ATTEMPTS`, `DOC_WRITE_RETRY_BUDGET_MS`, `DOC_FLUSH_TIMEOUT_MS`               | 4, 15 s, 20 s         | Sends of one editor or flow document write; the time to give up on it; a caller's wait for pending writes.                                                                                         |
| `MAX_DECLARED_TOOLS`                                                                        | 64                    | Browser tools and AG-UI actions kept per request (descriptions ≤ 2,048 characters, schemas ≤ 16,384).                                                                                              |

`VFS_REQUEST_TIMEOUT_MS` (vfs plugin config, default 20,000 ms) covers a
VFS request until its response body has been read.

## `createOracleWorker` options

What an oracle sets in code rather than in the environment
(`CreateOracleWorkerOptions`, `src/index.ts`). The result is
`{ fetch, scheduled, UserOracleDO, MatrixGatewayDO, core }`: the Worker
exports `fetch` and `scheduled` as its default export and the two classes by
name.

| Option                                        | Meaning                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`                                      | Required `OracleConfig`: `name`, optional `org`, `description`, `prompt` (opening, communication style, capabilities) and `delivery` ([chat delivery](chat-delivery.md#delivery-profiles)). The entity DID comes from `ORACLE_ENTITY_DID`, never from here.                                               |
| `plugins`                                     | Every plugin the oracle may load, e.g. `[...BUNDLED_WORKERS_PLUGINS, new IxoTransactionPlugin()]`. Each passes `features` and its own `autoDetect`.                                                                                                                                                       |
| `features`                                    | Per-plugin toggle by name. `false` leaves the plugin out; `true` requires it, so a failing `autoDetect` fails the boot (`boot.plugin.env_missing`); `'auto'` or no entry loads it when its `autoDetect` passes (or it has none). A loaded plugin whose `configSchema` rejects the env fails the boot too. |
| `manifestOverrides`                           | Shallow-merged over a loaded plugin's manifest at boot (e.g. `{ portal: { visibility: 'always' } }`); unknown names are logged and ignored; the merged manifest is validated.                                                                                                                             |
| `decisionAdapter`                             | One host Decision adapter, registered as provider `host`; wins over `DECISION_PROVIDER`; cannot be combined with `decisionProviders` ([Decisions](#decisions)).                                                                                                                                           |
| `decisionProviders`, `decisionProviderPolicy` | Further host Decision providers beside the env-selected one, and the default plus exact per-Decision routes over them ([Decisions](#decisions)).                                                                                                                                                          |
| `routes`, `authExcludedRoutes`                | Extra host routes on the shell (after the plugins' `getRoutes`), and host routes exempt from UCAN auth.                                                                                                                                                                                                   |
| `listModels`                                  | Replaces the `GET /models` listing (default: the curated catalog with live OpenRouter prices).                                                                                                                                                                                                            |
| `hooks`                                       | Per-turn build hooks: `getRoomTitle(roomId, ambient)` for the page-context middleware and `safetyModel(ambient)` for the safety-guardrail middleware (Node's `createOracleApp({ hooks })` pair).                                                                                                          |

The `scheduled` handler is the cron entry point: it keeps the gateway's sync
loop alive and, where `ARTIFACT_BUCKET` is bound, runs the
[artefact sweep](operations.md#artefact-sweep).

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

## Turn budgets and tool execution

Every turn runs under one budget shared by the main agent, its sub-agents
and the helper models the turn's LLM adapter hands out (the summarizer,
extraction). See [docs/plans/workers-harness-hardening.md](../../../docs/plans/workers-harness-hardening.md).

| Variable                    | Default  | Meaning                                                                                                 |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `TURN_MAX_TOKENS`           | `500000` | Cumulative model tokens: a chars/4 estimate plus the reply reserve per call, settled to reported usage. |
| `TURN_MAX_TOOL_CALLS`       | `120`    | Tool attempts, counting a read's retry and a sub-agent dispatch.                                        |
| `TURN_TIMEOUT_MS`           | `600000` | Wall-clock deadline of the turn; the abort reaches sub-agents and provider calls in flight.             |
| `TURN_MAX_IDENTICAL_WRITES` | `1`      | Identical successful write calls (same tool, same arguments) per turn; one more is refused.             |
| `TURN_MAX_IDENTICAL_READS`  | `5`      | The same for a read, or a `repeatable` UI step such as a browser tool.                                  |

Exhaustion ends the turn with an `error` frame (`kind: budget_exhausted`,
`limit: tokens | tools | time`, `retryable: false`) followed by `done`
(`failed: true`); work already done is kept. These are estimated resource
limits, not billing. The two `TURN_MAX_IDENTICAL_*` caps end nothing: the
refused call gets an error tool message with the earlier outcome and the turn
goes on. Sub-agents follow the same caps for their own tools, classified by
each tool's declared effect, and each dispatch's tool marks are kept apart,
so two dispatches whose models reuse a call id both run. The turn budget
ignores a non-finite token estimate instead of corrupting its counter. `TURN_RECURSION_LIMIT` remains the separate graph
guard; raising it does not raise a budget. The context window and reply
reserve come from the context budget (`MODEL_CONTEXT_TOKENS`, `CONTEXT_*`).

`REQUEST_ADMISSION_TIMEOUT_MS` (default `2000`) is the time limit of each
plugin `getRequestAdmission` handler, the inference-free step that may answer
a turn before the agent is built. A handler that has not answered by then is
treated as `pass` (logged as a warning) and the turn continues with the next
handler or the agent. See
[architecture](architecture.md#useroracledo--one-per-user-did) and, for the
plugin-author contract,
[request admission](../../../docs/architecture/request-admission.md).

Tool calls are scheduled per user object: writes one at a time across every
session, reads up to four at a time, sub-agent dispatches up to four in
their own lane. A tool is a read when it declares `effect: 'read'`, carries
the MCP `readOnlyHint` annotation, or matches the read-name convention
(`get_`, `list_`, `search_`, `read_` …); everything else is a write. Only
reads are retried once after a transient failure. A write whose outcome is
unknown (abort, deadline, dropped connection, 5xx) is claimed in the run
ledger; see [operations](operations.md#write-claims-and-turn-usage). Within
one turn the repetition guard refuses an identical call (same tool, same
arguments) that already failed, a second identical write that already
succeeded (an identical call earlier in the same model response counts), and
a sixth identical read (`TURN_MAX_IDENTICAL_WRITES` / `TURN_MAX_IDENTICAL_READS`
in the table above); the model gets the earlier outcome instead. A tool
that declares `repeatable: true` (the Portal's browser tools and AG-UI
actions: a UI step such as scrolling, where the same arguments again is a new
action) is capped like a read, whatever its `effect`.

`@ixo/oracle-runtime-workers/prompt` exports the prompt composer, so a
consuming instance can render its actual system prompt in a contract test
without importing the Worker bootstrap.
