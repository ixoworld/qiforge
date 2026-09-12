# Architecture

One Worker deployment = one oracle. Two Durable Object classes do all the
work; the Worker itself is a thin Hono shell that authenticates a request and
forwards it to the right object.

```mermaid
graph LR
    Client[Portal / SDK / curl] -->|HTTP + SSE, UCAN auth| Shell[Hono shell]
    Shell -->|per user DID| UserDO[UserOracleDO × N users]
    Matrix[(Matrix homeserver)] <-->|/sync, E2EE| Gateway[MatrixGatewayDO × 1]
    Gateway -->|decrypted turn| UserDO
    UserDO -->|reply / media| Gateway
    UserDO -->|export .db.gz| Owner[User-owned file in the IXO VFS]
```

## The objects

### `UserOracleDO` — one per user DID

Holds the user's SQLite database (LangGraph checkpoints, sessions, the full
transcript) in Durable Object storage, opened through wa-sqlite (WASM). The
file is bounded by DO storage (10 GB), not by isolate memory: SQLite sees
4 KB pages, storage packs them into 64 KB chunk rows (16 pages per row)
because DO SQLite bills per row regardless of size — a checkpointer turn
writes about 5 chunk rows instead of 30–80 page rows.

The object runs the agent turn (LangChain `createAgent`) and streams SSE
straight from the object. It is single-threaded, which replaces the Node
runtime's per-user ref-counting, busy-timeouts and cron locks outright.

### `MatrixGatewayDO` — one per oracle

A subclass of `MatrixBotDO` from
[`@ixo/matrix-bot-workers-sdk`](https://www.npmjs.com/package/@ixo/matrix-bot-workers-sdk)
(`src/matrix/gateway-do.ts`). The SDK owns everything generic about running
an E2EE Matrix bot on Workers:

- password login and the device identity (the same device survives eviction
  and restart; a device rotation is the recovery path);
- E2EE through `@matrix-org/matrix-sdk-crypto-wasm`, with the crypto store
  persisted into DO storage;
- its own `/sync` loop under an alarm-driven keep-alive (no initial sync,
  ever: the first start of an account bootstraps from `/joined_rooms`, later
  starts resume from the persisted sync token);
- paced, durable sends: one FIFO per room, a token bucket that mirrors the
  homeserver's per-sender limit, `interactive` before `background`, an
  outbox that survives restarts, poison-row eviction after three hung
  attempts;
- resumable catch-up of rooms that had events while the bot was down;
- invite handling, room upgrades, hot-room memory bounds, the idle recycle
  and the one-time-key conflict detector.

The subclass adds only what is specific to the oracle:

- inbound room messages → user-object turns (`src/matrix/ingest.ts` debounces
  per session for 500 ms and builds one turn per burst, with attachments and
  the thread or quote-reply chain resolved);
- user ↔ oracle room resolution from DIDs (alias on the user's own
  homeserver, see [operations](operations.md#rooms-and-aliases));
- dedicated `[Task] <title>` rooms;
- user SQLite snapshots as encrypted room media (`m.ixo.media_upload` +
  `m.ixo.media_state`, wire-identical to the Node runtime — read-only legacy
  today);
- the oracle's P-256 secrets key from its account room;
- a second, crypto-less password device for plugins that drive a raw
  matrix-js-sdk client (editor, flows).

### Two Worker scripts: the gateway split

Every Durable Object of one script shares that script's isolate on a given
server, and an isolate has a 128 MB heap. With the gateway (matrix-js-sdk,
the crypto WASM, room state) in the same heap as every user object, a user's
flush or import spike could reset the bot and the bot's footprint counted
against the user objects' budget. The runtime therefore ships as two
scripts:

| Script                     | Entry                                                         | Holds                                   | Bundle (devnet)       |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------- | --------------------- |
| oracle (`<name>`)          | `createOracleWorker` (`src/index.ts`)                         | Hono shell + `UserOracleDO` × N         | 24 MiB / 5.4 MiB gz   |
| gateway (`<name>-gateway`) | `createGatewayWorker` (`@ixo/oracle-runtime-workers/gateway`) | `MatrixGatewayDO` × 1 + keep-alive cron | 10.6 MiB / 2.7 MiB gz |

The gateway entry imports nothing from `core/` or `plugins/`, so its bundle
carries no LangChain, MCP or editor code. The two scripts talk over
cross-script Durable Object bindings (`script_name`): the oracle's
`MATRIX_GATEWAY` binding points at the gateway script's class, the gateway's
`USER_ORACLE` binding points back. RPC is identical either way, so nothing
inside the objects depends on the layout; the single-script layout
(`wrangler.jsonc`, used by the local harness) stays supported and
`createOracleWorker` keeps exporting `MatrixGatewayDO` for it. How to
migrate a deployment between layouts is in
[configuration](configuration.md#two-scripts-and-migrations).

## Self-sovereign storage

The Durable Object only ever holds a **working copy**. The durable file the
user owns is `/.oracles/<oracleDid>/state.db.gz` in the user's IXO VFS — the
system of record.

- **One delegation, no other grant channel.** Every VFS request is a
  single-use invocation minted from the delegation the user deposited for
  this oracle (`POST /delegation`, the `ucan_delegation` room state — the
  same delegation Matrix turns and every plugin mint from). It must carry
  `{ can: '*', with: 'ixo:filesystem/.oracles', nb: { hidden: ['/.oracles'] } }`
  (the whole personal library, `ixo:filesystem`, also qualifies; nothing
  narrower does, because the store lists `/.oracles`). A delegation without
  it means the user is "not on VFS": an existing legacy copy still boots
  from Matrix media and stays in the object until the user re-authorizes,
  a user with nothing else is refused with 403 `NO_VFS_DELEGATION`.
  `GET /delegation` reports the stored delegation's `capabilities` so a
  client can detect an older delegation and re-mint. The UCAN store worker
  plays no part in the owner copy (the vfs plugin's file tools still read
  their library-wide grant from it).
- The user's Matrix room media (`m.ixo.media_upload` + `m.ixo.media_state`)
  is a **read-only legacy source**: checked once when the VFS has no file
  yet, migrated into the VFS on first touch, never written again. The
  migration is streamed end to end: the gateway hands the media across the
  object boundary as stored (ciphertext plus its `EncryptedFile` fields),
  the user object decrypts, gunzips and header-checks it chunk by chunk into
  its working copy, then flushes that copy to the VFS from a snapshot like
  every other flush — so a Node-era history of any size costs a few chunks
  of memory (a 50 MB checkpoint used to be materialised three times over in
  the object and reset its 128 MB isolate on the first Portal open after
  cutover). Once the VFS is confirmed to hold the file (the first verified
  flush, or the first boot that loads it from the VFS), the old Matrix copy
  is redacted so no second copy of the history lingers. `OWNER_STORE=matrix` forces legacy
  room-media storage for environments without a VFS worker (the local
  harness only).
- There is no Matrix fallback for writes: a failed VFS flush keeps the
  working copy dirty in DO storage (durable, replicated) and retries.
- Export runs on a debounced alarm after every turn (24 h); a cold object
  re-imports the file; deleting the file upstream deletes the working copy
  only when it holds no turns. The exact rules are in
  [operations → user objects](operations.md#user-objects-and-the-owner-copy).
- Blobs are gzipped per row (`sqlite/blob-codec.ts`; gzip magic detected on
  read, so uncompressed legacy rows coexist) and a background compactor
  rewrites and `VACUUM`s files imported from the Node runtime. Nothing is
  pruned or summarised. A Node-written `.db` loads here; a compressed file
  is no longer readable by the Node runtime.

### What fills a user's file

Measured on a devnet user after ~350 sessions / 2,500 messages (26 MB
working copy, 16.5 MB gzipped in the VFS): LangGraph `writes` 35 %,
`messages` 27 %, `checkpoints` 21 %, indexes 13 %. Inside `messages`, tool
outputs are ~90 % of the text, and every message is stored twice (the
plain-text column the Node schema declares, plus the gzipped blob that is
the only copy anything reads). Checkpoints are kept at 10 per thread
(`DEFAULT_MAX_CHECKPOINTS_PER_THREAD`).

Candidates deliberately not done yet, in order of payoff: cap or
de-duplicate large tool outputs; a full-text index (our wa-sqlite build has
no FTS5); native DO SQLite instead of the in-isolate WASM engine (removes
the ~16 MB per-object heap, loses raw-file export); a resume of the turn
after an isolate reset (the checkpointer already saves every step, but a
tool mid-flight at the reset would run twice).

## Object lifetime and cost

An object costs by how long it is **loaded**, how much it **stores**, and how
many rows it **reads and writes**. Cloudflare's SQLite-backed Durable Object
prices (paid plan, beyond the included quotas): duration $12.50 per million
GB-s with every loaded object charged at 128 MB; requests $0.15 per million;
storage $0.20 per GB-month; rows read $0.001 per million; rows written or
deleted $1.00 per million.

- **Loaded time is the expensive meter.** An object is loaded from the first
  request until ~10 s after the last one, then unloaded (storage untouched;
  the next request boots it again, 200–400 chunk rows read). A 5 s turn plus
  the idle tail is ≈ 2.5 GB-s; a user with 100 turns a day costs ≈ $0.10 a
  month; an object kept loaded around the clock ≈ $4.15 a month. The gateway
  is the one intentionally always-loaded object. Anything that keeps a user
  object awake between messages — a timer, an un-hibernated WebSocket, an
  open MCP stream — turns a per-turn cost into a per-tab-open cost; see the
  workerd rules below.
- **Storage is cheap; wiping is not free.** For a 28 MB working copy,
  keeping it costs $0.0056 a month; wiping and re-importing it costs ≈
  $0.0009 per cycle, about five days of storage. Hence `IDLE_EVICT_MS` is
  five days: a daily user is never wiped, a lapsed one costs nothing after
  the fifth day.
- **Concurrency, not sessions, is the memory limit.** Only loaded objects
  occupy the isolate: with the 4 MiB chunk cache and streamed flush/import a
  turn holds roughly 10–20 MB, so several turns run concurrently per server.

### Storage cost planning

Resident DO storage is the dominant cost at scale. Idle users cost nothing
after the idle wipe, **but scheduled tasks count as activity**: a user with
a recurring task keeps their working copy resident indefinitely. Worked
example: 10,000 task-holding users × 1 GB resident ≈ $2,000/month; with the
blob compression the same history is realistically 100–300 MB, ≈
$200–600/month. Evicting task users between runs does not help — re-import
costs more in row writes than the storage it saves.

The structural fix is an **R2 page tier**: hot pages in the DO as a cache,
the file backed by R2 ($0.015/GB-month, ~13× cheaper; the example drops to
≈ $150/month; the 10 GB per-user cap disappears). It is a swap of the
wa-sqlite page-storage layer only — the user's VFS file stays the system of
record — so it can ship later with no data migration. The Slack watermark
alerts (`SLACK_ALERT_WEBHOOK_URL`, one alert per whole GB from 1 GB) are the
tripwire to build it with runway.

## Rules of the road on workerd

These came out of production incidents and are enforced in code; break one
and an object stops hibernating or a request dies with an opaque error.

- **No timer may outlive a request.** A pending `setTimeout`/`setInterval`
  keeps a Durable Object resident and blocks WebSocket hibernation.
  `@ixo/ucan`'s invocation store used to start an hourly sweep interval per
  validator; `shell/auth.ts` shares one store per isolate with auto-cleanup
  off. Tools register cleanups with `RuntimeContext.onTurnEnd`. With debug
  routes on, `GET /debug/realtime` → `pendingTimers` lists every live timer
  with its creation stack.
- **No MCP client may outlive a call.** A streamable-HTTP MCP client keeps a
  server→client stream open for as long as it exists, which counts as
  in-flight I/O: the object never hibernates and is billed around the
  clock. Clients connect, call and close per invocation (memory and sandbox
  at turn end, firecrawl per call). Never hand the MCP SDK a tool timeout
  either — its per-request timer pins the object for the whole window;
  every upstream call races our own always-cleared timer
  (`src/plugins/mcp-call-timeout.ts`).
- **Never store the global `fetch`.** workerd rejects `fetch` called with a
  foreign `this` ("Illegal invocation"). Wrap it:
  `(input, init) => globalThis.fetch(input, init)`. matrix-js-sdk clients
  and the BYO reachability probe both went through this.
- **No code generation from strings.** The MCP SDK's default Ajv validator
  compiles schemas to code, which workerd forbids; the repo patches
  `@langchain/mcp-adapters` (`patches/`) to use the cfworker validator.
  jsdom needs `node:vm`, so the editor plugin aliases it to a linkedom shim.
- **Typed errors do not cross the DO RPC boundary.** The caller gets a plain
  `Error` with only the message, so owner-copy failures travel as a JSON
  envelope in the message (`toRpcError` / `parseOwnerCopyFailure`) and the
  shell maps them to 403 / 503.
- **A stub is one incarnation.** After the gateway restarts, calls on a stub
  created earlier fail with `Network connection lost`; the user object's
  `gateway` getter is a self-refreshing proxy (`src/do/fresh-stub.ts`) and
  waited sends retry with the same transaction id (`src/do/gateway-retry.ts`).
- **DO SQL** allows at most 100 bound parameters per statement and dislikes
  `LIKE` patterns; wa-sqlite's heap never shrinks (~16 MiB steady state).
