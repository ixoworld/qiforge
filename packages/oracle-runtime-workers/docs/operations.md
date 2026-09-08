# Operations

What an operator needs to run an oracle: the routes, what the status fields
mean, how the gateway and the user objects behave over their lifetime, and
the runbook for the failures we have seen.

## Routes

Public (UCAN-authenticated unless noted):

| Route                                                                           | Purpose                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /health`, `GET /`                                                          | Liveness (no auth).                                                      |
| `GET /health/matrix`                                                            | 200 when the gateway is running, 503 otherwise; body = `/matrix/status`. |
| `GET /matrix/status`, `POST /matrix/start`                                      | Gateway status; start the sync loop (idempotent).                        |
| `GET /models`                                                                   | Priced platform models.                                                  |
| `POST/GET /sessions`, `DELETE /sessions/:id`                                    | Sessions.                                                                |
| `POST /messages/:id` (SSE or JSON), `GET /messages/:id`, `POST /messages/abort` | Turns and transcripts.                                                   |
| `POST/GET/DELETE /delegation`                                                   | The user's deposited UCAN delegation.                                    |
| `GET /socket.io/*`                                                              | The realtime channel (websocket transport only).                         |
| `/byo-llm/*`                                                                    | Bring-your-own-credential lane (`BYO_LLM_ENABLED`).                      |
| `GET /user-preferences`                                                         | The user's stored preferences.                                           |

Operator routes, enabled by `ORACLE_DEBUG_ROUTES=true` and authenticated as
the calling user:

| Route                                                                          | Purpose                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `GET /debug/storage`, `POST /debug/storage/flush`, `POST /debug/storage/reset` | The caller's working copy: sizes, generations, flush state, chunk cache; force a flush; wipe and reload. |
| `GET /debug/sessions/:id`                                                      | Raw session row (`lastProcessedCount` included).                                                         |
| `GET /debug/tasks`                                                             | The caller's task records and the object's current alarm.                                                |
| `GET /debug/realtime`                                                          | Sockets, heartbeat deadline, pending browser calls, live timers with creation stacks.                    |
| `GET /debug/delegation`, `GET /debug/memory-schema`                            | What header-less turns mint from; the memory engine's tool schema as delivered.                          |
| `POST /debug/matrix/restart`, `POST /debug/matrix/stop`                        | Gateway stop / restart.                                                                                  |
| `POST /debug/matrix/rotate-device`                                             | Log the bot in as a new device (old one retired).                                                        |
| `GET /debug/matrix/outbox`                                                     | Pending durable sends without bodies (thread id, sizes, attempts).                                       |

## The gateway

### Lifecycle

The gateway starts lazily on the first request (or `POST /matrix/start`) and
stays loaded: the SDK's keep-alive alarm holds the object while it is active
and re-arms itself, and the cron trigger is the safety net. A deploy
replaces the object; the next request boots the new one. Boot timings on
devnet (42 rooms): a fresh device 1.2 s (crypto init plus 100 one-time-key
uploads), a restart that resumes from the persisted sync token 0.23 s.

There is no initial sync. The first start of an account on an object lists
`/joined_rooms` and syncs with a filter that excludes every room; later
starts send `since=<token>`. A room that had more events than one sync
carries is caught up through `/messages` with a durable cursor, so messages
sent while the gateway was down are answered after the restart (the matrix
step "gateway restart: … catch-up" pins it). `MATRIX_BACKFILL_MAX_EVENTS`
caps that replay per room when an oracle should not answer a long backlog.

### Status fields worth watching

`GET /matrix/status` is the SDK's `BotStatus` plus the gateway's own turn
bookkeeping:

| Field                                                                                             | Meaning                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `running`, `syncState`, `lastSyncAt`, `syncs`, `syncFailures`                                     | The sync loop. `syncFailures` climbing = homeserver trouble.                                                  |
| `deviceId`, `deviceRotations`, `resumedSync`                                                      | The current device; rotations since the object was created; whether this start resumed from a token.          |
| `instanceId`, `instanceUptimeMs`                                                                  | A changing instance id with a short uptime means the object was killed or redeployed (see below).             |
| `lastStart` (`restoreMs`, `cryptoInitMs`, `syncMs`, `totalMs`)                                    | Timings of the last boot.                                                                                     |
| `joinedRooms`, `invitedRooms`, `hotRooms`, `hotRoomEvictions`                                     | Rooms known; rooms fully built in memory (≤ `MATRIX_HOT_ROOMS`).                                              |
| `cryptoReady`, `secretStorageUnlocked`, `crossSigningReady`, `keyBackupVersion`                   | E2EE state; the backup version must be set for a fresh device to read history.                                |
| `oneTimeKeys` (`uploads`, `keysUploaded`, `serverCount`)                                          | A healthy client tops up to ~50–100 at boot and then idles; continuous uploads = the runaway described below. |
| `cryptoStoreBytes`, `cryptoStoreTransactions`, `wasmHeapBytes`                                    | Store size; retained fake-indexeddb transactions (a handful at most); crypto WASM heap.                       |
| `sendQueue` (`inFlight`, `waiting`, `durableRows`, `sendsSinceBoot`)                              | Encryption gate occupancy; outbox rows still pending; sends since this instance booted.                       |
| `sendScheduler` (`queued`, `inFlight`, `rooms`, `sent`, `failed`, `rateLimited`, `effectiveRate`) | The per-room scheduler; `rateLimited` must stay 0 under load.                                                 |
| `catchup` (`rooms`, `gaps`, `queuedEvents`, `activeRooms`), `backfilledEvents`                    | Catch-up work outstanding / done.                                                                             |
| `turns` (`inFlight`, `waiting`), `ingestPending`                                                  | Room turns running in user objects; debounce buffers about to become turns.                                   |
| `lastError`                                                                                       | The last start or sync error, if any.                                                                         |

### Sends: scheduling, outbox, poison rows

Outgoing messages go through the SDK's `PrioritySendScheduler`: one FIFO per
room, rooms in parallel (`MATRIX_SEND_CONCURRENCY`), `interactive` (session
markers, room replies, notices) before `background` (HTTP-turn replays), a
token bucket at the homeserver's per-sender limit (`MATRIX_SEND_RATE_PER_SECOND`,
`MATRIX_SEND_BURST`), 429s honoured with `retry_after_ms` and an adaptive
back-off. An encryption gate ahead of the scheduler bounds how many events
are being encrypted at once (memory). Configuring the rate is described in
[configuration](configuration.md#the-bots-send-rate).

Every send that is not consumed synchronously by its caller — replays, room
replies, notices, task deliveries — is written to the SQLite `send_queue`
table before it is scheduled and deleted on acknowledgement; on boot the
survivors are re-issued with their original transaction id, so a send whose
response was lost is deduplicated by the homeserver, never repeated. Rows
are never aged out: an outage of any length only delays them. Session
markers are the exception — their event id becomes the session id, so they
are not replayed; the user object retries the marker with the same
transaction id for ~30 s (`src/do/gateway-retry.ts`) instead, and if every
attempt fails the create fails.

A send the crypto WASM cannot encrypt does not fail cleanly: the machine
panics, later crypto calls throw `null pointer passed to rust`, and the
stuck send would hold a gate slot forever. The SDK's 45 s send watchdog
resets the object, charges one attempt to the row that hung (rows merely
waiting behind it are untouched) and drops it after three attempts with an
`outbox: dropping …` line. `GET /debug/matrix/outbox` lists the rows without
bodies, which is how such rows are found. The one cause we hit — a replay
threaded on a session id that was not an event id — is closed on both
sides: `sendText` rejects a thread id that is not an event id, and room
resolution fails a request instead of minting a local session id on a
transient error.

### Instance changes, memory, recycle

The gateway shares its isolate's 128 MB with the crypto WASM and every event
being encrypted, and a crypto WASM's linear memory only grows inside one
isolate. Two things keep it healthy: the encryption gate plus
`MATRIX_TURN_CONCURRENCY` bound concurrent encryption sources, and after
`MATRIX_RECYCLE_AFTER_SENDS` sends (default 300) the SDK recycles the object —
only when nothing is in flight and no message arrived for 15 s, so nobody
notices. The log line `planned recycle: N sends since boot` precedes every
intentional instance change; an instance change without one is a kill worth
investigating. Cloudflare's GraphQL analytics
(`durableObjectsInvocationsAdaptiveGroups`, dimension `status`) show
`exceededMemory` counts per five minutes and are the acceptance check after
any change to these numbers; a kill is lossless thanks to the outbox and the
catch-up, but it stalls sends for ~30 s.

### Devices and rotation

- The gateway's own device is logged in with the password and its id is
  pinned in storage; the token is verified with `/account/whoami` on every
  boot and re-minted for the same device id when rejected.
- Plugins that run their own client (editor, flows) use a second, crypto-less
  device (`identity:bot-client` in gateway storage, display name "QiForge
  oracle plugins (…)"), minted on first use. Deleting it turns every page
  edit into `401 Invalid access token` until the gateway re-logs it in.
- **One-time-key conflicts.** If a restored crypto store is behind the
  server, every `/keys/upload` fails with `One time key … already exists`,
  matrix-js-sdk retries forever and all other outgoing requests (room-key
  shares) queue behind it, so new E2EE sessions silently stop. The SDK's
  conflict detector then rotates the device: a fresh password login with no
  `device_id`, the old snapshot discarded, room keys restored from the
  account backup, the old device drained and logged out. Each rotation costs
  a fresh boot with a backup restore. `POST /debug/matrix/rotate-device`
  does it on demand.
- **Shared bot account.** Every extra client logged in as the oracle user is
  a separate device that also answers room messages and that every peer has
  to encrypt to. Keep the device list short: the gateway device (`deviceId`
  in `/matrix/status`), the plugins device, and whatever the operator's own
  tooling needs. Prune with `POST /_matrix/client/v3/delete_devices`
  (password UIA). `POST /debug/matrix/rotate-device` logs out only the
  previous device of this runtime.
- `/login` answers 429 with `retry_after_ms` when many objects log in through
  the Worker's shared egress addresses; both logins retry three times.

### Rooms and aliases

- The user ↔ oracle room alias is
  `#<userDid>_<oracleENTITYDid>:<the USER's homeserver>` — the entity DID
  (`ORACLE_ENTITY_DID`), not the account DID, and the user's homeserver from
  their DID document's MatrixHomeServer service (resolved through Blocksync,
  cached six hours), exactly as the Node runtime builds it. A decoupled
  deployment (users on one homeserver, the bot on another) resolves nothing
  otherwise. Room ids are cached per user for 30 minutes.
- Room state right after an invite: `getRoomState` answers a 403 (not yet a
  member) by accepting the pending invite and retrying for up to 5 s, so a
  membership check that lands before the sync loop has joined a just-created
  page room does not fail closed.
- Dedicated task rooms are created by the gateway (`createDedicatedRoom`:
  private, the user invited, a summary posted) for `before-action` tasks,
  on the `auto` heuristic or `dedicatedRoom: 'yes'`; replies there reach the
  user's object like the main room. Leave rooms that are finished with
  rather than letting the bot accumulate hundreds.
- The memory engine needs `x-room-id` (a generic `invalid_token` otherwise);
  every turn therefore runs inside the user's oracle room — Matrix turns
  bring it, HTTP turns take it from the session row or resolve the alias.

## User objects and the owner copy

- **Boot.** A warm object opens its working copy directly. A cold object (no
  working copy) loads the user's VFS file, retrying transient failures three
  times (1 s / 2 s / 4 s); if it still fails, the request fails instead of
  opening an empty database — an empty start would hide the user's history
  and, once dirtied, be flushed over the real copy. The shell answers with an
  honest code (`owner-store/owner-copy-errors.ts`): 503
  `OWNER_COPY_UNAVAILABLE` (`retryable: true`) for a transient failure; 403
  `NO_VFS_DELEGATION` when the user's delegation to the oracle (or the lack
  of one) carries no `ixo:filesystem` capability over `/.oracles`; 403
  `VFS_AUTH_FAILED` when the VFS rejected the oracle's credentials. Only a successful listing with no file yields an empty
  working copy.
- **Never wipe on a failed check.** A `head()` that fails (a VFS error, or the
  flush's own delete → move window) is UNKNOWN, never a deletion. Even a
  proven upstream absence never auto-wipes a working copy that holds turns;
  it is re-uploaded on the next flush. Only a zero-turn copy is dropped; a
  genuine "forget me" goes through the explicit `remove()` path.
- **Flush.** A write arms the alarm for 24 h later (`FLUSH_DEBOUNCE_MS`). The
  export pins a snapshot of the chunk VFS, hashes it in one streamed pass
  and, when the bytes changed, streams gzip → tus upload in 5 MiB parts
  (files ≤ 5 MiB in one `POST`) → temp path → `batch/delete` of the old file
  → `batch/move` into place. Every request is retried 3× (2 s / 5 s / 15 s;
  parts resume from `HEAD`); a flush that still fails leaves the copy dirty
  and retries after 10 min, logged at error from the third consecutive
  failure. Stale `.uploading-` temps are cleaned at the next flush. Nothing
  is ever written to Matrix media.
- **Idle eviction.** After five days without contact (`IDLE_EVICT_MS`) the
  working copy is wiped — only after a flush and a check that the upstream
  copy is current (generation + hash); otherwise it stays and the check
  repeats. `GET /debug/storage` shows `writeGeneration` /
  `uploadedGeneration`, `flushFailures`, `lastVacuumAt`, `legacyCleared`,
  `indexingInFlight`, `flushInFlight` and the alarm.
- **VACUUM** runs on a quiet object (no turn for 10 min, not dirty, no flush
  in progress, file ≥ 4 MB with > 20 % free pages, at most once per 6 h,
  2× the file below the 10 GB cap; `src/sqlite/vacuum-policy.ts`) through
  `VACUUM INTO` a spill file swapped in atomically, so a rebuild of a
  multi-hundred-MB file needs constant memory.
- **Chunk cache.** `CHUNK_CACHE_BYTES` (default 4 MiB) sizes the per-object
  LRU of clean chunks. Measured on devnet with a 28 MB file, 8 MiB was
  indistinguishable in turn latency (the LLM round-trip dominates), so the
  default stays small; `8m` is the knob for unusually large working sets.
  An idle user object is unloaded by the platform within ~10–15 s of its
  last request; the next request re-opens the file (~200–400 chunk rows).
- **Legacy Matrix copies** of migrated users are redacted once the VFS is
  confirmed to hold the file (`removeLegacyCopy`, logged as `legacy Matrix
copy removed`; `legacyCleared` in `/debug/storage`).

## Realtime channel

The engine.io heartbeat runs from the object's alarm, not from a timer: a
wake every 180 s (`PING_INTERVAL_MS`) sends the ping and closes sockets that
missed interval + timeout (240 s), then the object hibernates again. A wake
that is only due for the heartbeat re-arms without opening the database.
Sockets and their ping/pong bookkeeping live on the socket attachments and
are re-adopted from `ctx.getWebSockets()` on every wake. Pending browser
calls do not survive a restart (neither does the turn that made them). A
dead connection is noticed by either side after up to four minutes; the
client SDK's reconnect then restores it. `socket.io-client` must use
`transports: ['websocket']`.

Turn events reach the sockets too, mirrored through the event router's
taps on the Node runtime's wire: the socket event `event` carrying
`{ eventName, payload }` (`tool_call`, `render_component`, `router_update`,
`message_cache_invalidation`, …), which is the envelope the client SDK
validates before it dispatches. Only `browser_tool_call` and `action_call`
are sent by name with the raw payload, because the SDK answers them that
way. `message` / `done` chunks stay SSE-only.

Background work is bounded: the session-history indexer runs under
`ctx.waitUntil` with at most two attempts, 3 s apart, each with a 20 s
timeout on the memory-engine request; a failed session is retried on the
next session create because its watermark did not move.

## ChatGPT-subscription lane needs a proxy

`chatgpt.com` (the Codex backend the subscription lane talks to) answers
Cloudflare Workers egress with an HTML 403 before any authentication; the
API-key providers (OpenAI, Anthropic, Gemini, DeepSeek) and `auth.openai.com`
(device flow, token refresh) answer normally from a Worker. Without a proxy
the runtime probes once per 10 min and falls back to the platform model with
an `unreachable` notice. With one it works: set `BYO_CHATGPT_BACKEND_URL` to
a transparent proxy on a non-Cloudflare host (optionally gated with
`BYO_CHATGPT_PROXY_AUTH_TOKEN`, sent as `X-Proxy-Auth`); only the model
requests of that lane go through it, byte for byte, the OAuth flow stays
direct.

The devnet deployment uses `ixo-proxy-app` (`ghcr.io/ixoworld/ixo-proxy-server`,
one container per upstream, `UPSTREAM=https://chatgpt.com/backend-api/codex`,
no gate) behind nginx on `chatgpt.proxy.ixo.earth` (Vultr host, DNS-only
record) with `proxy_buffering off` and 10-minute idle timeouts — the limit is
silence between two chunks, the same 10 minutes the OpenAI client library
allows before the first byte. The vhost empties every caller-identifying
request header (`CF-*`, `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`,
`Forwarded`, `Via`, `CDN-Loop`): OpenAI's WAF blocks on `CF-Worker` and
`CF-Connecting-IP`, which Cloudflare stamps on a Worker's outbound requests.
Proven end to end: device-flow sign-in, a JSON turn answered with a
Responses-API id, a streaming turn delivering chunks as they are produced.

## Known limits

- The per-DID rate limit (100 requests / 60 s) is the first ceiling a single
  client hits, not the object.
- Session creation waits for the marker send, so it scales with the number
  of simultaneous creators across all users (the one bot's send budget), not
  with load on one user; see [load tests](load-tests.md).
- `search_memory_engine` failing with `Error code: 404 — No endpoints found
that can handle the requested parameters` is the memory engine's own
  OpenRouter call, not this runtime; recall quality on an account with a
  long history is the engine's ranking.
- Optional MCP tool parameters lose their enums before the model sees them
  (`@langchain/mcp-adapters` simplifies `anyOf: [<real>, null]`);
  `GET /debug/memory-schema` shows the schema as delivered.
- Firecrawl: the IXO-hosted server serves Streamable HTTP at `/v2/mcp`;
  `/mcp` is a plain 404 from the ingress.
- Crypto snapshots are not transactional with Olm ratchet advances (a hard
  crash can replay pre-key state — recovered by the conflict detector).

## Runbook

| Symptom                                                                                 | Check                                                                                                           | Action                                                                                                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/matrix/status` `instanceId` changes without a `planned recycle` log line              | Cloudflare analytics `exceededMemory`; `sendQueue.inFlight` at the time                                         | Lower `MATRIX_SEND_CONCURRENCY` / `MATRIX_TURN_CONCURRENCY`; check `cryptoStoreTransactions` stays a handful.                     |
| `oneTimeKeys.uploads` climbing continuously, `One time key … already exists` in the log | `deviceRotations`                                                                                               | The SDK rotates by itself; if it loops, `POST /debug/matrix/rotate-device` once and prune stale devices.                          |
| Sends stall, `sendQueue.durableRows` grows, `null pointer passed to rust` in the log    | `GET /debug/matrix/outbox` for rows with a bad thread id or high attempts                                       | The watchdog drops the row after three attempts; nothing to do unless the same row keeps coming back — then find who produced it. |
| `GET /sessions` empty for a migrated user, `HISTORICAL_MESSAGE_NO_KEY_BACKUP`           | `keyBackupVersion`, `secretStorageUnlocked`                                                                     | Provision the key backup and `MATRIX_RECOVERY_PHRASE` (see configuration → first-time setup).                                     |
| Page edits fail with `401 Invalid access token`                                         | Device list of the bot account                                                                                  | The plugins device was deleted; the gateway re-logs it in on the next use — do not delete `identity:bot-client`'s device again.   |
| A user object never unloads (`instanceUptimeMs` grows while idle)                       | `GET /debug/realtime` → `pendingTimers`; `activeTurns`, `indexingInFlight`, `flushInFlight` in `/debug/storage` | A leaked timer or an open MCP stream — see the workerd rules in [architecture](architecture.md#rules-of-the-road-on-workerd).     |
| Requests fail 503 `OWNER_COPY_UNAVAILABLE`                                              | VFS health                                                                                                      | Transient by definition; the client retries. 403 `NO_VFS_DELEGATION` means the user must deposit a grant.                         |
| `Network connection lost` on a gateway RPC                                              | Gateway just restarted                                                                                          | Expected once per restart; waited sends retry by themselves.                                                                      |
