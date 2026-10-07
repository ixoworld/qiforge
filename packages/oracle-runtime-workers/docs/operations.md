# Operations

What an operator needs to run an oracle: the routes, what the status fields
mean, how the gateway and the user objects behave over their lifetime, and
the runbook for the failures we have seen.

## Routes

Public (UCAN-authenticated unless noted):

| Route                                                                           | Purpose                                                                                                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /`                                                          | Liveness (no auth). `/health` also advertises `frontendTools`, the [frontend bridge](frontend-bridge.md) version.                   |
| `GET /health/matrix`                                                            | No auth. `{ running }` from the gateway's memory: 200 when true, 503 otherwise. Reads no storage.                                   |
| `GET /matrix/status`, `POST /matrix/start`                                      | No auth, each rate-limited per client IP. Gateway status; start the sync loop (idempotent).                                         |
| `GET /models`                                                                   | Priced platform models (no auth).                                                                                                   |
| `POST/GET /sessions`, `DELETE /sessions/:id`                                    | Sessions.                                                                                                                           |
| `POST /messages/:id` (SSE or JSON), `GET /messages/:id`, `POST /messages/abort` | Turns and transcripts.                                                                                                              |
| `GET /sessions/:id/messages`                                                    | One turn-aligned page of a transcript ([paging](#transcript-paging)).                                                               |
| `GET /sessions/:id/run`, `GET /runs/:runId?after=<seq>`                         | Whether a session has an active run; re-join a run's frames after a cursor ([durable runs](#turns-durable-runs)).                   |
| `POST /channels/turn`                                                           | IXO Channels ingress, under its own channel UCAN policy, not the user auth ([channels](channels.md)).                               |
| `PUT/GET /topic-deliverables/:operationId`, `POST …/:operationId/cancel`        | Owner-only Topic deliverables (`TOPIC_DELIVERABLES_ENABLED=true`, else 404; [architecture](architecture.md#topic-deliverable-api)). |
| `POST/GET/DELETE /delegation`                                                   | The user's deposited UCAN delegation.                                                                                               |
| `GET /socket.io/*`                                                              | The realtime channel (websocket transport only).                                                                                    |
| `/byo-llm/*`                                                                    | Bring-your-own-credential lane (`BYO_LLM_ENABLED`).                                                                                 |
| `GET /user-preferences`                                                         | The user's stored preferences.                                                                                                      |
| `GET /a/:id`, `GET /a/:id/data`                                                 | Artefact links (no auth): the viewer page and the ciphertext.                                                                       |
| `GET /artifacts/:id`, `DELETE /artifacts/:id`                                   | The caller's artefact: its canonical copy; revoke its link.                                                                         |
| `POST /messages/:sessionId/:messageId/feedback`                                 | Anonymous feedback on one completed Agent reply (when configured).                                                                  |

Every other route needs a UCAN invocation (`src/shell/auth.ts`), and each
authenticated request then spends one unit of the caller's `RATE_LIMIT`
budget (see [configuration](configuration.md#wrangler-config)).

- **Body caps.** The shell refuses an oversized body with 413 before it
  reads it (`bodyLimit`): `POST /messages/:id` 256 KiB
  (`MAX_TURN_BODY_BYTES`), `POST /delegation`, `/byo-llm/*` and `/debug/*`
  64 KiB each, `POST /messages/abort` 4 KiB. `POST /messages/:id` also
  type-checks every body field it reads; a wrong type is a 400
  (`src/do/turn-body.ts`), and `null` in an optional top-level field counts
  as absent (`message` is still required).
- **Errors.** An unexpected failure answers 500 with
  `{ statusCode: 500, message: 'Internal server error', requestId }` and the
  same id in `x-request-id`. The detail is only in the log line
  `[shell] <method> <path> failed (request <id>): …`. The id is the
  client's `x-request-id` when that header is a plain token of 1–128
  characters, else a fresh UUID. Owner-copy failures keep their own codes
  (see [user objects](#user-objects-and-the-owner-copy)), and so do errors a
  route throws on purpose with a status.
- **Refused credentials.** The shell authenticates before the request
  reaches the user object, so a 401 from it means nothing was processed;
  the owner-copy 403s (`NO_VFS_DELEGATION`, `VFS_AUTH_FAILED`) are refused
  before anything is written too. With a valid invocation, a delegation
  that fails validation is ignored rather than refused (the request goes
  on without it). `@ixo/oracles-client-sdk` repeats a refused request in
  two stages — a fresh invocation, then a fresh delegation and invocation —
  including a turn's `POST /messages/:id` (never repeated once accepted)
  and the socket CONNECT; it does not renew for `VFS_AUTH_FAILED`. A new
  delegation seen in `x-ucan-delegation` replaces the user object's stored
  copy (`meta:delegation`), which header-less turns mint from.
- **Socket upgrades.** `GET /socket.io/*` is unauthenticated until the
  socket.io CONNECT packet. Before any user object is addressed, the shell
  requires `userDid` to be a W3C DID of at most 512 characters (else 400)
  and limits upgrades per client IP (429). The rest is in
  [Realtime channel](#realtime-channel).

Operator routes, enabled by `ORACLE_DEBUG_ROUTES=true` (otherwise 404).
Every one of them needs a UCAN invocation. The per-user routes act on the
caller's own user object. The `/debug/matrix/*` routes act on the one
gateway every user shares (stop, restart, abort, rotate-device, outbox,
event): with `ORACLE_OPERATOR_DIDS` set, a caller whose DID is not on that
list gets `403 Operator routes are restricted` before the gateway is
addressed; unset, any authenticated caller may use them. Set it wherever
`ORACLE_DEBUG_ROUTES=true` is not a private test deployment (see
[configuration](configuration.md#ops-and-misc)).

| Route                                                                          | Purpose                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /debug/storage`, `POST /debug/storage/flush`, `POST /debug/storage/reset` | The caller's working copy: sizes, generations, flush state, chunk cache, the R2 page tier (`tier`); force a flush (an evicted object boots first); wipe and reload (an object that never booted is booted for the caller first). |
| `POST /debug/storage/tier-flush`                                               | Run one R2 page-tier eviction pass now; body `{ "force": true }` evicts every clean chunk regardless of recency, `{ "maxSegments": n }` caps the pass.                                                                           |
| `GET /debug/sessions/:id`                                                      | Raw session row (`lastProcessedCount` included) plus `threadMessages` / `summaryMessages` / `toolMessages` — whether the thread's agent context was condensed.                                                                   |
| `GET /debug/tasks`                                                             | The caller's task records, the open (unfinished) runs and the object's current alarm.                                                                                                                                            |
| `GET /debug/runs`                                                              | Recent durable runs with their tool marks, segment counts, attempts and live state ([durable runs](#turns-durable-runs)).                                                                                                        |
| `GET /debug/context?model=<id>&session=<id>`                                   | The context-window resolution and derived thresholds for a model; with `session`, that session's context counters ([context budgets](#turns-context-budgets)).                                                                   |
| `GET /debug/realtime`                                                          | Sockets, heartbeat deadline, pending browser calls, live timers with creation stacks.                                                                                                                                            |
| `GET /debug/delegation`, `GET /debug/memory-schema`                            | What header-less turns mint from; the memory engine's tool schema as delivered.                                                                                                                                                  |
| `POST /debug/matrix/restart`, `POST /debug/matrix/stop`                        | Gateway stop / restart.                                                                                                                                                                                                          |
| `POST /debug/matrix/rotate-device`                                             | Log the bot in as a new device (old one retired).                                                                                                                                                                                |
| `GET /debug/matrix/outbox`                                                     | Pending durable sends without bodies (thread id, sizes, attempts).                                                                                                                                                               |
| `POST /debug/matrix/event`                                                     | Post `{ type, content, txnId? }` into the caller's own room; the same `txnId` twice returns the same event id. For transaction-id drills.                                                                                        |
| `POST /debug/object/abort`                                                     | Reset the caller's user object the way a platform host drain does (in-flight turns die, storage survives). For reset-safety tests.                                                                                               |
| `POST /debug/reauth-prompt/reset`                                              | Forget when the last `delegation_required` prompt was posted (the 6 h throttle), so a drill can trigger the next one.                                                                                                            |
| `POST /debug/matrix/abort`                                                     | Reset the gateway object the same way (sync loop and in-flight turns die; outbox, inbox and crypto snapshot survive). For reset-safety tests.                                                                                    |

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
bookkeeping. The part that scans the gateway's storage (rooms, outbox,
catch-up and crypto counts, channel memory, the inbox) is cached for 5 s,
and the cache is dropped when the bot starts or stops. `turns` and
`ingestPending` are always live. The route has no auth, so the shell limits
it per client IP:

| Field                                                                                             | Meaning                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`, `syncState`, `lastSyncAt`, `syncs`, `syncFailures`                                     | The sync loop. `syncFailures` climbing = homeserver trouble.                                                                                                                                                                                    |
| `deviceId`, `deviceRotations`, `resumedSync`                                                      | The current device; rotations since the object was created; whether this start resumed from a token.                                                                                                                                            |
| `instanceId`, `instanceUptimeMs`                                                                  | A changing instance id with a short uptime means the object was killed or redeployed (see below).                                                                                                                                               |
| `lastStart` (`restoreMs`, `cryptoInitMs`, `syncMs`, `totalMs`)                                    | Timings of the last boot.                                                                                                                                                                                                                       |
| `joinedRooms`, `invitedRooms`, `hotRooms`, `hotRoomEvictions`                                     | Rooms known; rooms fully built in memory (≤ `MATRIX_HOT_ROOMS`).                                                                                                                                                                                |
| `cryptoReady`, `secretStorageUnlocked`, `crossSigningReady`, `keyBackupVersion`                   | E2EE state; the backup version must be set for a fresh device to read history.                                                                                                                                                                  |
| `oneTimeKeys` (`uploads`, `keysUploaded`, `serverCount`)                                          | A healthy client tops up to ~50–100 at boot and then idles; continuous uploads = the runaway described below.                                                                                                                                   |
| `cryptoStoreBytes`, `cryptoStoreTransactions`, `wasmHeapBytes`                                    | Store size; retained fake-indexeddb transactions (a handful at most); crypto WASM heap.                                                                                                                                                         |
| `sendQueue` (`inFlight`, `waiting`, `durableRows`, `sendsSinceBoot`)                              | Encryption gate occupancy; outbox rows still pending; sends since this instance booted.                                                                                                                                                         |
| `sendScheduler` (`queued`, `inFlight`, `rooms`, `sent`, `failed`, `rateLimited`, `effectiveRate`) | The per-room scheduler; `rateLimited` must stay 0 under load.                                                                                                                                                                                   |
| `catchup` (`rooms`, `gaps`, `queuedEvents`, `activeRooms`), `backfilledEvents`                    | Catch-up work outstanding / done.                                                                                                                                                                                                               |
| `turns` (`inFlight`, `waiting`), `ingestPending`                                                  | Room turns running in user objects; debounce buffers about to become turns.                                                                                                                                                                     |
| `keepAlive` (`fuseMs`, `holding`, `fuseRearmsSinceBoot`, `fuseRearmFailuresSinceBoot`)            | The keep-alive fuse (`MATRIX_KEEPALIVE_FUSE_MS`): re-arm failures climbing means the alarm could not be kept ahead of a host drain.                                                                                                             |
| `unexpectedResets`, `lastUnexpectedReset`                                                         | Starts that followed a reset without a clean `stop()` (a deploy, an eviction, the isolate over 128 MB), with the previous instance's id and last liveness stamp.                                                                                |
| `interruptedFlushes`                                                                              | Crypto-store snapshot flushes a reset cut short (the next flush repeats them); `0` on a healthy object.                                                                                                                                         |
| `syncShrinks`, `pagesRefused`, `oversizedEvents`, `oversizedDecrypts`                             | Memory guards firing: `/sync` responses over `MATRIX_SYNC_BYTES_CAP`, catch-up pages over `MATRIX_PAGE_BYTES_CAP`, events skipped because they alone exceed the page cap, events refused by `MATRIX_MAX_DECRYPT_BYTES`. All `0` on a quiet bot. |
| `backupBulkRestore` (`version`, `total`, `imported`, `skipped`)                                   | Only with `MATRIX_BACKUP_BULK_RESTORE=true`: the first start imports the backup, later starts report `skipped: 'already-restored'`.                                                                                                             |
| `lastError`                                                                                       | The last start or sync error, if any.                                                                                                                                                                                                           |

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

### Best-effort room posts

Three posts the user object makes are best-effort by design (Node fires and
forgets them too): the room mirror of every HTTP turn (the user message and
the reply, threaded under the session's marker), the `ixo.action.log` audit
event of every browser tool / AG-UI action (identifiers and status only —
never the arguments or the result body, see
[frontend bridge](frontend-bridge.md)), and the `delegation_required`
prompt a Matrix turn posts when the user has no usable delegation. On Workers
the gateway object is replaced on every deploy and can be drained mid-turn,
so each of these is now retried across a restart for ~30 s
(`src/do/gateway-retry.ts`) and kept alive past the request under
`waitUntil`. The mirror is serialised per session and sent with the
transaction id `replay-<session>-<request>-<u|o>`, so a response lost to a
reset is deduplicated by the homeserver and a reply never overtakes the
message it answers (`src/do/room-mirror.ts`). The two custom events are sent
under a transaction id minted once per post and kept for the life of the
retry loop (`sendEvent` takes one since `@ixo/matrix-bot-workers-sdk` 0.4.0),
so a response lost between the homeserver's ack and the reply to the gateway
is deduplicated as well — a retried post lands once.

The prompt's 6-hour throttle (`UCAN_REAUTH_PROMPT_THROTTLE_SECONDS`) is
stamped only after the homeserver accepted the event
(`src/do/reauth-prompt.ts`); a prompt lost to a restart is therefore posted
on the user's next message instead of being suppressed for the whole window.
`POST /debug/reauth-prompt/reset` forgets the stamp for drills.

A turn that dies mid-way (an object reset, a provider error, the user's
stop) leaves committed checkpoint steps with no dirty mark — the mark is set
at the end of a turn. On boot the object compares the file's write
generation with the generation it last uploaded and marks the copy dirty when
the file moved on (`src/do/boot-dirty.ts`, one batched storage read per
boot), so the next flush carries those steps and a later reload from the
system of record cannot drop them. A copy that was never uploaded is left to
its first completed turn.

### Turns: what is and is not on the wire

Three things the SSE stream (`src/do/sse-stream.ts`) decides per event:

- model events tagged `lc_source: 'summarization'` (the summarization
  middleware condensing the thread) or `internal` (a sub-agent's inner
  turn) are dropped — neither their text nor their reasoning is a
  `message` / `reasoning` frame; only the outermost agent's model output
  streams;
- a tool call whose arguments failed the tool's schema comes back from
  LangChain's `toolRetryMiddleware` as an error `ToolMessage` (not as
  `on_tool_error`): it is forwarded as `tool_call` with `status: 'error'`
  and `error: <message>`, and logged as `[tool-retry] tool call rejected by
the tool schema: …` — grep the tail for it when a model keeps "creating"
  things that never appear;
- a tool that threw is `status: 'error'` from `on_tool_error`, as before.

`GET /messages/:id` lists the thread's full history from the saver, not the
agent's live context: after the summarization middleware condensed the
context, every earlier message still lists (Node parity) and only the
summary message itself is hidden. `GET /debug/sessions/:id` reports the
counts.

### Turns: threads are sessions

A room message is answered inside a thread, never in the main timeline, and
the thread is the session — the Node runtime's rule, kept exactly:

- A bare message roots a thread at itself; the reply opens the thread and
  the session id is the message's event id. The next bare message is a new
  thread and a new session.
- A message inside a thread continues the thread's session. A quote-reply
  from a client without native threads (`m.in_reply_to` only) is resolved up
  the reply chain to its thread root (`src/matrix/reply-chain.ts`; an
  unreachable ancestor ends the walk at the last event reached, as on Node).
- A Portal session's id is its marker event, its turns are mirrored into the
  marker's thread, and a reply typed inside that thread continues the Portal
  session. An HTTP turn on a room-born session is mirrored into its thread
  the same way. Nothing is mirrored into the main timeline.
- `GET /sessions` is scoped to the user's main oracle room (the room the
  alias names, resolved once per object instance): Portal sessions and the
  threads opened there. Threads in dedicated task rooms and in any other
  room the bot answers in stay out of the list, and task runs (`task:<id>`)
  are hidden wherever they deliver. A user without an oracle room sees every
  session.
- An earlier build of this runtime kept a room's main timeline as one
  session (`matrix:<roomId>`) and keyed threads as `thread:<root>`. On every
  boot the user object renames `thread:<root>` rows to `<root>` across the
  session-keyed tables (`src/do/session-id-migration.ts`, `[session-ids] …`
  log line; a root that already names a session — the Portal session the
  thread was mirrored from — keeps the old row as it is). `matrix:<roomId>`
  rows are left alone: their transcript stays readable, new room messages no
  longer continue them.

### Turns: the inbox

The outbox only exists once a reply exists. Between the SDK marking a room
message processed and the user object finishing the LLM turn there was
nothing durable, so a gateway reset in that window (a platform host drain,
observed nine times in 37 h on a 1,186-room gateway) lost the reply silently.
The gateway now writes every accepted message to the SQLite `turn_inbox`
table before anything waits on the network and deletes the row when the turn
ends: reply written to the outbox, empty reply, superseded, or the "try
again" notice posted. Every start that brings the bot up re-dispatches the
surviving rows through the ingest pipeline (`inbox replay: …` log line);
each replay is charged to the row and a row replayed `MAX_TURN_REPLAYS`
times gets the notice instead, so a message that kills the instance cannot
loop. `status.inbox` counts pending rows. A replay skips a row whose
message is still in the debounce window or already in a turn, so a start
in place (a device rotation starts the new device without a `stop()`)
does not offer it twice; a `stop()` drops the debounce buffers, so those
rows are replayed on the next start.

A replay never runs a turn twice. Room replies are sent with the transaction
id `reply-<event id>`, so a reply the dead incarnation had already handed to
the outbox or the homeserver is deduplicated server-side. The user object
keeps a ledger per Matrix event (`matrix_turns` in the user's SQLite):
an event it already answered returns the stored text without a model call,
one whose turn is still running attaches to it, and one it lost in a reset
of its own (tools may have run) is refused with a warning — the gateway posts
the notice and the user resends, exactly as before this change.

### Turns: durable runs

Every turn — HTTP, Matrix room, scheduled task — is a **run** the user
object records in its own SQLite before the first model call
(`turn_runs`), keeps notes on while it executes, and can pick up again
after a platform reset. The design is in `docs/plans/durable-runs.md`; what
an operator sees:

- **A run outlives its connection.** A browser that closes the tab does not
  stop the turn; only `POST /messages/abort`, a superseding message on
  the same session (`multitask: 'interrupt'`, the default; with
  `multitask: 'enqueue'` the new message waits its turn) or deleting the
  session does. The reply lands in the transcript either way.
- **One admission at a time per session.** The coordinator admits the
  messages of one session one after another, so two messages that arrive
  together never start two graph runs on one thread. A message that a later
  `interrupt` message supersedes while it waits is recorded `aborted` and
  never runs; its stream ends with its `done` frame. A superseded run gets
  5 s to wind down. A run still executing after that grace keeps running,
  and the new message is queued behind it instead of running beside it.
  Deleting a session first ends every run of it
  (`RunCoordinator.abortAllForSession`): the executing attempt is aborted,
  queued and recovering runs and messages still being admitted are closed
  `aborted`, and the rows are deleted once the attempt ended or the grace
  passed.
- **Stop.** `POST /messages/abort` stops the session's current message: its
  active run, a message still waiting in admission, and a message queued
  only because the run it superseded outlived the grace — each ends
  `aborted`. Messages sent with `multitask: 'enqueue'` behind the active
  run still start after it.
- **Every ending sends its frames.** A run that closes without its own
  `done` (an attempt that crashed, a recovering run that was aborted, a run
  whose deferrals used up the recovery cap) gets an `error` frame when it
  failed, then `done`, and its response streams close. A run counts as
  `aborted` only when its own abort signal fired: a provider or tool error
  that mentions "abort" or a timeout is a failure with an `error` frame.
- **Re-join.** Every SSE frame carries its sequence number as the `id:`
  field and the first frame is `run` `{ runId }` (also the `x-run-id`
  response header). `GET /runs/:runId?after=<seq>` replays the frames after
  the cursor from the packed segments (`turn_run_segments`, one row per
  ~2 s of output, deleted when the run ends) and stays attached until
  `done`. Frames whose segment write has not settled yet are served from
  memory, so a re-join that reads the store during a write misses nothing. `GET /sessions/:id/run` tells a reloading client whether a run is
  active. The `done` frame carries `runId`, `messageId` and, for a run that
  ended early, `aborted` / `interrupted` / `failed` and `partialText` — the
  reply text the runtime kept, which a client shows in place of whatever it
  had streamed. A re-join whose run ends while it reads the stored frames
  is answered as for an ended run: the frames read, the buffer's remaining
  frames without their `done`, and the trailer built from the closed row
  (status, `messageId`, `partialText`).
- **What a client does with a resumed attempt.** A recovered attempt is
  announced with `run` `{ resumed: true, attempt, partialLength }`. The
  frames of each attempt live in their own sequence space (attempt _n_
  numbers from _n_ × 2³², `turn_runs.generation`), so a cursor from before
  the reset — even one pointing at frames that were streamed but never
  packed — is below everything the new attempt emits and a re-join misses
  nothing. Those unpacked frames are the one thing a reset loses (at most
  `RUN_SEGMENT_FLUSH_MS` of text): the model continues from what was
  packed, so the client cuts the text it shows back to `partialLength`
  characters before appending the continuation. `@ixo/oracles-client-sdk`
  does this (`streamRun`, `useChat().run`); a plain SSE consumer that
  ignores `partialLength` may show a repeated fragment after a restart.
- **Reset mid-turn.** A reset leaves the row `running`. The next boot — the
  next request, or the keep-alive alarm the run re-arms every ~15 s —
  schedules a recovery attempt (5 s, then 15 s, 30 s, 60 s), restores the
  partial output, and resumes the graph from the last checkpoint with no new
  input. A checkpoint newer than the one seen at the previous attempt counts
  as progress and resets the counter; four attempts without progress close
  the run as `interrupted` with the friendly "try again" notice and the
  partial text kept on the row. The tail shows `[runs] <id> attempt N in
S s`, `resuming`, and the terminal `finished|aborted|interrupted|failed`.
- **Side effects run at most once.** `turn_tool_marks` records every tool
  call before it executes (`started`) and when it returns (`done`). On a
  resumed attempt a started, unfinished **write** call is not executed
  again: the model gets "outcome unknown, verify before repeating".
  **Read** calls (declared `effect: 'read'` by the plugin, MCP
  `readOnlyHint`, or the `list_/get_/search_/read_/preview_/…` naming
  convention) run again. Undeclared tools are writes. A sub-agent's inner
  tool calls are marked too; the sub-agent call itself is a write.
- **Task runs.** A scheduled run cut off by a reset is resumed like any
  other and its result delivered once by the scheduler
  (`completeRecoveredRun`); it is closed as interrupted only after the
  recovery cap.
- **Request admission.** Before the agent is built, a fresh run records
  the disposition `admitting` in its stored request and offers the turn to
  the plugins' admission handlers
  ([architecture](architecture.md#useroracledo--one-per-user-did)); the
  answer is stored as `direct-read` (text, title, message id) or `agent`.
  A reset during admission recovers as a fresh attempt with the turn's
  input; a recorded direct read is replayed, not asked again. A handler
  that throws or answers invalidly ends the run `failed`: an `error` frame
  with `kind: 'request_admission'`, `source: 'platform'`,
  `retryable: true` and a generic message, then `done` with
  `failed: true`; the user's message is not written to the transcript. The
  log line is `[user-do] turn <requestId>: admission failed: <message>`
  (`direct read failed` when a stored direct read could not be delivered);
  a handler over `REQUEST_ADMISSION_TIMEOUT_MS` logs
  `[user-do] request admission by <plugin> timed out after N ms; continuing as pass`.
- **Ordering.** A message sent with `multitask: 'enqueue'` waits behind
  the session's running turn _and_ behind one that is waiting for its
  recovery attempt; the session's turns never interleave. Each attempt
  records how it started (`LiveRun.attemptSource`: `begin` for a message
  just admitted, `dequeue`, or `recovery`); a queued or recovering run that
  is aborted while it is being started is closed instead of attempted.
- **Diagnostics.** `GET /debug/runs` lists recent runs with their marks,
  segment counts, attempts and the live state — per live run its
  `generation`, `lastSeq`, `packedSeq` (what a reset would keep) and
  subscriber count (`ORACLE_DEBUG_ROUTES=true`). `POST /debug/object/abort`
  resets the object mid-turn; it is what the durable-runs drill uses.
- **Cost.** Rows written per turn: the run row and one update when it
  ends, which also stores the turn's usage; the end is one transaction
  (`RunStore.close`: the terminal update and the segment delete) and the
  coordinator keeps the record it wrote in memory instead of reading it
  back; one segment per `RUN_SEGMENT_FLUSH_MS` (2 s) of output plus one per
  settled tool result (a tool's start frame, the `run`, `router.update` and
  `error` frames and the text all ride the timer; `done` closes the last
  pack), each deleted at cutover; one mark and one update per tool call
  (a re-run read adds an update). A 10 s reply with four tool calls is
  ~25 rows. Alarms: the keep-alive re-arms the object's single alarm once
  per ~15 s of active turn (coalesced across runs and multiplexed with the
  scheduler, tier and idle alarms); the segment timer is in-memory. No
  loaded-time change: the model wait still happens inside the object. The
  boot pruning of ended runs and old write claims reads through
  `idx_turn_runs_updated` and `idx_turn_write_claims_started` (created with
  `CREATE INDEX IF NOT EXISTS` on the first boot that has them), at one
  index entry per run-row update.

### Transcript: paging

`GET /sessions/:id/messages?limit=20&before=<cursor>&after=<cursor>` reads a
session's transcript one turn-aligned page at a time
(`docs/plans/transcript-paging.md`); `GET /messages/:id` still returns the
whole transcript for older clients. A turn is a user message with everything
the agent did until the next one, so a tool result never lands in a different
page from the reply that called it. Cursors are message ids resolved to their
row position at query time (rowids move when a checkpoint rewrites the
thread's rows); an unknown cursor is a 400, an unknown session an empty page,
`limit` is clamped to 100. `after=` re-sends the turn the cursor split so a
client can fold the page in by message id. Cost: one indexed range read per
80 rows plus one lookup per cursor; nothing is written.

### Turns: context budgets

Every context limit of a turn is a fraction of the model's own context
window, resolved per model (`docs/plans/context-budgets.md`). What an
operator sees:

- **The window.** `[context] model=… window=N (origin) …` on every turn.
  `origin` is `override` (`MODEL_CONTEXT_OVERRIDES`), `catalog` (the
  OpenRouter `/models` listing, BYO-native ids under their vendor prefix),
  `learned` (a provider's "too long" error named a smaller limit; kept in
  the object's KV as `ctxwin:<model>`), or `default`
  (`MODEL_CONTEXT_TOKENS`, 100k). `GET /debug/context?model=<id>` shows the
  resolution and every derived threshold.
- **New models.** Nothing to add here: a model listed by OpenRouter gets its
  window from the catalog at the next refresh (once per isolate-hour). The
  only manual step for a new selectable model is the runtime's allow-list,
  `MODEL_CATALOG` in `src/core/llm.ts`, plus its entry in
  `MODEL_INPUT_CAPS` (`src/core/llm.test.ts` requires one per catalog id,
  unique ids and exactly one default); check `origin` on `/debug/context`
  afterwards, and pin the id in `MODEL_CONTEXT_OVERRIDES` only when it
  shows `default` (a model OpenRouter does not list).
- **Summarization** fires at the smaller of 50% of the window (tokens,
  chars/4) and what the summarizer may read, keeps the last 10 messages,
  and no longer counts messages (set `CONTEXT_SUMMARIZE_MESSAGES` to add
  that trigger back). What the summarizer reads is bounded by the main
  model's window and by the window of the model that writes the summary
  (the routing model), with the same margins; `summaryInput` on
  `/debug/context` shows the bound. Starting no later than that bound means
  the summarizer reads the earlier summary and everything after it instead
  of dropping the oldest messages unread (a 400k main model with a
  131,072-token summarizer summarizes, and prunes, from about 112k tokens).
  A mid-turn summary's record of the turn's calls (`turn_carry`) survives
  the checkpoint save, keeping the newest calls that fit 64 KiB of JSON
  (`TURN_CARRY_MAX_CHARS`). A failed
  summary keeps the history (`[summarization] summary failed; keeping the
full history for the rest of this turn`); it never replaces the
  conversation with an error, and it is not attempted again in the same
  turn — the next turn tries again. A summary written in the middle of a
  turn carries the turn's earlier tool calls, so the repetition guard still
  refuses an identical write after it.
- **Capped tool results.** A result above 12% of the window (×4 chars, at
  most 200,000 chars — `CONTEXT_RESULT_CAP_MAX_CHARS`) is stored whole and
  the model sees the first 40% and last 60% of the visible budget with a
  footer naming the saved id; `read_result` pages it back by
  byte range. `[result-cap] <tool>: N chars > cap …; saved as … (sqlite|r2)`.
  Results under 1 MB live in `tool_results` in the object's SQLite; larger
  ones in the tier bucket as `<object id>/results/<id>`. Rows expire after
  24 h (swept at boot), and identical results share one row.
  `tool_result_sessions` records every session that holds a result, so a
  result shared by two sessions survives the deletion of one of them and
  goes with the last. Writes to the store (puts, sweeps, session deletes,
  a read's removal of an expired row) run one at a time, so a result stored
  again while its last session is being deleted survives. A put reuses only
  a row that has not expired; identical content whose row has expired is
  uploaded again. When an R2 delete fails, only the rows of that 1,000-key
  batch stay, marked expired, until a later sweep or read deletes the
  object. Pages
  end on UTF-8 character boundaries; `offset`, `length` and `next` say
  where a page really ended. Optionally add an R2 lifecycle rule on the
  `results/` prefix as a belt on top of the sweep.
- **Pruning under pressure.** Above 35% of the window, tool results outside
  the kept tail become one-line placeholders (a capped one keeps its
  handle) and results identical to a later one become back-references —
  on the request only, never in the checkpoint or the transcript.
  `[context] over the prune threshold: pruned N tool result(s), ~A → ~B tokens`.
- **Refusal and recovery.** A request still above 95% of the window (minus
  the reply reserve) after a hard prune fails with "The conversation no
  longer fits the model's context window …". A provider overflow lowers the
  window when the error names a limit (`[context] <model>: window lowered
A → B`), prunes hard and retries once.
- **Per-session counters.** `GET /debug/context?session=<id>` adds a
  `session` block: the working context the latest checkpoint carries into
  the next request (`contextMessages`, `contextSummaries`,
  `contextToolMessages`, `contextTokens` — one summary plus the kept tail
  once the history was condensed, while `threadMessages` counts the
  transcript rows, which are never condensed) and what the guard did across
  the session's turns (`prunes`, `hardPrunes`,
  `prunedResults`, `overflowRetries`, `refusals`, `lastEventAt`; kept in the
  object's KV as `ctxstats:<session>`, dropped with the session). This is
  what the context drill asserts on; a deployed oracle has no harness log to
  read, and `wrangler dev` does not forward the worker's `console.log` lines
  to a parent process (only `warn`/`error`/`debug`), so never gate a test on
  a `[context]` or `[summarization]` line.
- **Catalog fetch.** The `/models` fetch times out after 3 s
  (`OPENROUTER_FETCH_TIMEOUT_MS`), concurrent callers share one fetch, an
  expired listing is served while a fresh one loads in the background
  (kept alive with the request's `waitUntil`, which `GET /models` and turns
  both hand it), and after a failure the next attempt waits 60 s
  (`OPENROUTER_FAILURE_TTL_MS`). A shared fetch that has not settled
  within its timeout plus 1 s (`OPENROUTER_INFLIGHT_MARGIN_MS`) is
  abandoned and the next caller starts a new one; no caller waits longer
  than that.
- **Cost.** One `/models` fetch per isolate-hour (shared with prices); a KV
  read per model per boot; one row (or one R2 put plus an index row) per
  capped result, one delete at expiry. Pruning and guarding write nothing.

### Turns: attachments

The attachment pipeline (`src/attachments/`) routes each file of a turn to
the model natively or through the helper model's extraction:

- **One budget per turn.** Both lanes share one 50 MB download budget
  (`MAX_TOTAL_SIZE`; 25 MB per file, `MAX_FILE_SIZE`). A file's declared
  size is checked against what is left before it is downloaded, and each
  download is cut off at what is left. A file the native lane refuses (over
  the budget, empty, or content that is not what it claims) is noted for
  the model, never downloaded a second time. Usage of paid extractions is
  counted even when a later file is refused.
- **Deadlines.** Every download, http(s) or Matrix media, has a 60 s
  deadline (`DOWNLOAD_TIMEOUT_MS`) from the request to the last byte. The
  gateway applies it to Matrix media on its side of the RPC (an
  `AbortSignal` cannot cross a Durable Object RPC); when the turn is
  aborted, the user object cancels the stream it reads, which stops the
  gateway's download. A redirect without a `Location` header is reported
  as such.
- **Type.** The content's magic bytes are checked against the declared
  type. A container format whose bytes are consistent with the claim keeps
  the claimed type (`containerMatchesClaim`, `src/attachments/magic.ts`):
  a zip for an Office Open XML, OpenDocument or EPUB file, OLE2 for
  `.xls`/`.ppt`, ISO-BMFF `ftyp` for HEIC/HEIF/AVIF, M4A, QuickTime and
  3GPP, RIFF for WAV/AVI, EBML for WebM audio and Matroska — so Office
  documents and HEIC/AVIF photos go to the model natively. A file whose
  bytes contradict its claim (a PDF named `.png`) is never sent as a
  native block, by a turn or by `view_attachment`: the turn hands the bytes
  it already downloaded to the extraction lane, whose content check notes
  the mismatch.
- **`view_attachment`** keeps the text it extracted in the user's SQLite
  (`attachment_text_cache`, per session, attachment and extraction model,
  at most 65,536 characters per entry, `VIEW_CACHE_MAX_CHARS`), so a second
  view of the same file costs neither a download nor a helper-model call.
  Only Matrix media references are cached (what an http(s) URL serves can
  change); an entry expires after 30 days (`VIEW_CACHE_MAX_AGE_MS`), a
  session keeps its newest 50 (`VIEW_CACHE_MAX_PER_SESSION`), and the cache
  goes with its session. An unsupported file type is reported without a
  download.

### Tasks: the run ledger

A scheduled run used to be invisible to storage until it was over: the
schedule advanced only after the result was delivered. Durable Object alarms
are at-least-once, so a user-object reset anywhere inside a run made the
retried alarm find the task still due and run it again, tools included; and
a delivery whose RPC response was lost (a gateway reset in the second the
send takes, or a dropped connection) marked a delivered one-shot `failed`
with a failure notice next to its result.

Every run now has a row in `task_runs` that moves `running` → `delivering`
→ `delivered` (three single-row writes per run; the turn's own checkpoints
cost far more). `running` is written before the turn starts; `delivering`
stores the result text and advances the schedule in one transaction, before
the send; `delivered` closes it. The scheduler keeps the run ids it is
executing in memory, which is what tells a long live run from a dead one —
memory is per instance and empty after any reset, so a row in `running` or
`delivering` whose id is not in memory belongs to an incarnation that died.
On every alarm, before the due scan:

- `delivering` rows are re-sent from the stored result under the run's fixed
  transaction id `task-<runId>` (server-side dedupe, so a copy the dead
  incarnation got out is not repeated), with no model call;
- `running` rows are closed as `interrupted` and never re-run: a one-shot
  task fails with the notice, a recurring task skips the occurrence and
  counts one failure toward the stop threshold.

Delivery itself is retried across a gateway restart (`retryGateway`, same
transaction id). A round that still fails parks the run with `retry_at` and
re-arms the alarm (1, 2, 4, 8 minutes between rounds); after five rounds the
task fails. A partial index (`idx_task_runs_retry`) serves the query for
the next parked round. `GET /debug/tasks` lists the open runs; the log
lines are `[tasks] run … re-delivering`, `… never finished … closing it as
interrupted`, `… delivery round N failed`. A delivered row records its own
run's output.

- **Concurrency.** One alarm tick runs up to `MAX_CONCURRENT_TASK_RUNS` (3)
  due tasks at a time, so a slow task does not hold back the others. Each
  task is claimed before anything is awaited, so none runs twice. The tick
  still waits for all of its runs before it returns.
- **Approvals.** `resolve_task_approval` does not run the task inside its
  own tool call (the run's write tools would wait for the write slot that
  call holds). It stores the approval on the task (`approved_at`,
  `approval_note`) and arms the alarm for now; the alarm runs it once.
  Claiming the approval and opening the run row are one transaction, so a
  reset before the alarm still runs it once and a reset after it started
  never runs it again. Pausing or cancelling the task drops a pending
  approval. The tool tells the model the run is starting. The approval
  request is posted to the room under one transaction id per occurrence
  (`task-approval-<task>-<nextRunAt>`), retried across a gateway restart,
  so a request sent just before a reset is not posted again by the next
  tick. A user's yes/no reply is read under the turn-time note, so a
  noted reply still decides.
- **Recovery.** While a task's turn is being recovered after a reset, the
  scheduler leaves that task out of its next wake (no re-arm every second);
  the end of the recovered run re-arms the alarm.
- **History.** Each task keeps its newest 50 run rows
  (`MAX_RUNS_KEPT_PER_TASK`) plus every open one. A closed ordinary run
  keeps no result text; Topic deliverables keep theirs.
- **Schedules.** The minimum interval between runs is checked when a task
  is created or updated as the shortest gap between consecutive fire times:
  across midnight, weekday and month-end boundaries, and across the DST
  changes of the task's timezone in the coming year. An irregular pattern
  such as `0,30-34 * * * *` is refused when any gap is below the floor.
  Around each clock change only the fires near it are examined (the change
  is found to the minute by bisection). Deciding whether a task gets a
  dedicated `[Task]` room (the `auto` rule) uses the clock cadence without
  the timezone, so a daily task in a DST zone counts as daily and gets
  none.
- **Idle tick.** An alarm tick with nothing due issues 4 SQL statements.
  `onAlarm` arms nothing itself: it returns the next wake, and the user
  object arms the alarm for it (at least 1 s out) with its other deadlines.

What the user sees is plain language only — "could not be completed",
"has been stopped after N unsuccessful runs", or, for a one-shot whose
result could not be delivered, "ran, but its result could not be delivered
here" without a prompt to run it again — and `lastResult.summary` (what the
task tools relay) says the same; the technical reason is in the log line
and the run row's `detail`. A Topic deliverable posts no room notice for an
undelivered result; its result stays readable through its API.

A turn that names a task run (`taskRunId`, original or recovered) runs only
while that run's row is still open on the task's own session. Once the row
is closed — reported as interrupted, or its result dropped — the recovered
turn attempt fails instead of executing again: its result could no longer be
delivered and its tools would only run a second time.

Supplied-context tasks (see
[architecture](architecture.md#supplied-context-tasks)) are one-shot,
immutable attempts: `pause` / `resume` / `update` are refused, `cancel`
works, and the task tools show metadata only. Their `task:<id>` session is
never titled by the title model, never indexed into the memory engine and
never traced to LangSmith. A task row whose `execution_profile` this runtime
does not know is skipped with a `[tasks] task … has an execution profile
this runtime does not support` warning on each read (it is not in
`GET /debug/tasks` either); roll forward, or cancel such tasks from the
newer runtime before rolling back.

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
  oracle plugins (…)"), minted on first use. Deleting it turns page edits
  into `401 Invalid access token` until the gateway re-logs it in; the
  editor's Matrix client is rebuilt whenever the gateway hands out a
  different access token or homeserver, so the next turn uses the new
  token without an isolate restart.
- **One-time-key conflicts.** If a restored crypto store is behind the
  server, every `/keys/upload` fails with `One time key … already exists`,
  matrix-js-sdk retries forever and all other outgoing requests (room-key
  shares) queue behind it, so new E2EE sessions silently stop. The SDK's
  conflict detector then rotates the device: a fresh password login with no
  `device_id`, the old snapshot discarded, room keys restored from the
  account backup, the old device drained and logged out. Each rotation costs
  a fresh boot with a backup restore. `POST /debug/matrix/rotate-device`
  does it on demand.
- **Media never sits in the gateway.** Snapshots (the legacy owner copy)
  and attachments cross the RPC to the user object as streams, as stored:
  the object decrypts them (`createAttachmentDecryptor`) and enforces the
  size caps chunk by chunk. The SDK's whole-buffer download decrypted inside
  the crypto WASM and grew its heap for good (a buffered 10 MiB round trip
  took it from 7 to 41 MB); the streamed calls keep the gateway's memory
  flat whatever the file size.
- **Shared bot account.** Every extra client logged in as the oracle user is
  a separate device that also answers room messages and that every peer has
  to encrypt to. Keep the device list short: the gateway device (`deviceId`
  in `/matrix/status`), the plugins device, and whatever the operator's own
  tooling needs. Prune with `POST /_matrix/client/v3/delete_devices`
  (password UIA). `POST /debug/matrix/rotate-device` logs out only the
  previous device of this runtime.
- `/login` answers 429 with `retry_after_ms` when many objects log in through
  the Worker's shared egress addresses; both logins retry three times.

### Rooms: group chats

The bot joins every room it is invited to (the SDK's autojoin, as on Node).
A room is direct when its verified canonical alias (see
[Rooms and aliases](#rooms-and-aliases)) is a user↔oracle alias of this
oracle, when its `m.room.create` event carries `is_direct`, or when it has
≤ 2 joined members; every other room is a group room. An alias lookup that
fails counts as no alias for this decision. The alias rule is
this runtime's addition to Node's two: a real user↔oracle room holds the
rooms appservice bot and the memory-engine bot as well (four members on
devnet), and counting them would have silenced the oracle in the one room
it must always answer in.

What happens in a group room is the gateway's `MATRIX_GROUP_ROOMS` policy:

- `silent` — **the default**: the bot never speaks in a group room and
  captures nothing there; no typing indicator, no turn, no user object woken,
  one `not answered (group-rooms-off)` log line per message. The bot only
  ever talks in direct rooms: the user↔oracle room and the task rooms it
  creates. Pick this unless the Node group-chat lane below has been
  reviewed for the deployment.
- `gate` — the Node group-chat lane, described next.
- `answer` — every room is treated as direct (Node without the plugin).

With `gate` the gateway runs the Node group-chat gate before a message
becomes a turn (`src/matrix/group-chat.ts`):

- It answers a message that mentions the bot (`m.mentions.user_ids`), one
  that quote-replies a message the bot sent, or one inside a thread the bot
  answered in within `GROUP_CHAT_ACTIVE_THREAD_TTL_MS` (30 min; the map is
  in memory and mirrored in the durable `group_bot_threads` table, so a
  restart forgets nothing). Everything else is ignored: no typing, no turn,
  no user object woken, one `not answered (ignored)` log line.
- An answer is skipped (`power-level` in the log) when the bot's power
  level is below the room's `m.room.message` threshold or
  `GROUP_CHAT_REQUIRE_POWER_LEVEL`.
- Every group message, answered or not, is captured into the room's
  channel memory: a durable per-room buffer (`group_message_buffer`) that is
  compacted at 20 messages, and just in time before an answer when ≥ 5 are
  waiting (bounded to 3 s so the reply is not held up), into a summary chunk
  (`group_memory_chunks`, FTS5-indexed). The summary is produced by the
  speaker's user object with the platform's small model and the Node
  prompt (`summarizeGroupMessages`) — the gateway script holds no model
  keys. One chunk covers at most the 50 oldest buffered messages. A failed
  summary leaves the batch buffered; automatic compaction of that room then
  backs off for 1 minute, doubling up to 30 minutes.
- The turn the gate lets through carries `roomKind: 'group'` and the
  speaker's display name (the room's member event, else the profile, else
  the user id; cached `GROUP_CHAT_ROOM_INFO_TTL_MS`): the user object
  stores the message as `[DisplayName]: …` with `senderDid` /
  `senderMatrixUserId` / `senderDisplayName` / `threadId` / `eventId` in
  the message's `additional_kwargs`, and the `matrix-group-chats` plugin
  offers `recall_channel_memory`, `search_channel_memory`, `pin_room_fact`
  and `unpin_room_fact` (all backed by the gateway's tables) — in group
  rooms only. A room message that names the bot's user id reaches the
  model as `(USER MENTIONED YOU @AI_AGENT)`, the Node bridge's rewrite.
- `status.groupChat` counts buffered messages, chunks and facts.
- A member whose messages the gate lets through still needs a user object
  that can boot; on a VFS-backed deployment that means a delegation to this
  oracle. A member without one is answered with the "try again" notice
  (the turn fails to load an owner copy), exactly as their 1:1 room would.

### Rooms and aliases

- **Which alias a room has.** A room's `m.room.canonical_alias` is
  ordinary room state that any member with the power level can set, and a
  homeserver does not check an alias that lives on another server. The
  gateway therefore counts a canonical alias only when it is a user↔oracle
  alias of this oracle _and_ the alias's own server resolves it to this
  very room (`src/matrix/room-alias.ts`). An alias that resolves to another
  room or to nothing means the room has no alias. Verdicts are kept in
  memory per room for 30 minutes (at most 5,000 rooms) and dropped when an
  `m.room.canonical_alias` event arrives; the alias a message was verified
  with is the one it is attributed with, even when such an event lands
  while the check runs. The thread a message belongs to is resolved
  alongside the alias and homeserver lookups, not after them. A lookup
  that fails is no
  verdict: the message keeps its inbox row
  (`ingest: could not prepare … keeping it in the inbox for a replay`) and
  is replayed 60 s later; every replay is charged to the row.
- **Who a room message belongs to.** A DID-shaped sender
  (`@did-ixo-…:server`) is that DID. A non-DID sender in a user↔oracle
  room is the room's owner, named by its verified alias, but only when the
  sender's server is the alias's server; anyone else there is unmapped and
  wakes no user object. Either way the server the identity came from (the
  sender's, or the alias's) must be the user's registered homeserver: the
  MatrixHomeServer service of their DID document, resolved through
  Blocksync (each lookup bounded at 5 s) and cached six hours, in storage
  and in an in-memory memo in front of it. Anyone can
  register `@did-ixo-<someone>` on a server of their own, so a message
  whose server does not match is dropped before any user object is woken
  (`ingest dropped … : foreign`, a warning). A DID document that names no
  homeserver falls back to the oracle's own server (`MATRIX_HOMESERVER_NAME`,
  else the bot's), and that answer is cached for 5 minutes only
  (`UNREGISTERED_CACHE_TTL_MS`), so a homeserver registered since is
  picked up soon: senders on it are accepted, senders anywhere else are
  not. A DID Blocksync has no record of yet also gets the oracle's own
  server, and nothing is cached for it. A Blocksync that cannot be reached is no verdict: the last cached
  server is used even when its six hours are up (a registration rarely
  moves; a stale entry is logged `using the expired cached …`), and with
  nothing cached the message is neither dropped nor run — its inbox row
  stays (`ingest: no homeserver verdict for … keeping …`, a warning) and it
  is replayed 60 s later, and again on the next start. Each replay is
  charged to the row, so an outage longer than its replays ends in the "try
  again" notice, never a silent drop. Two members writing in one thread of
  a group room are two turns, each in its own user object.
- The user ↔ oracle room alias is
  `#<userDid>_<oracleENTITYDid>:<the USER's homeserver>` — the entity DID
  (`ORACLE_ENTITY_DID`), not the account DID, and the user's homeserver from
  their DID document's MatrixHomeServer service (resolved through Blocksync,
  cached six hours; when Blocksync fails, the expired cached server, else
  the oracle's own — a wrong guess there only misses the room), exactly as
  the Node runtime builds it. A decoupled
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
- Replies go into threads, one session per thread
  ([above](#turns-threads-are-sessions)).

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
  working copy. An owner copy that loads but is not a database (a short or
  truncated file passes the import's header check) fails the boot and
  leaves the cold object empty again, so the next request retries instead
  of opening a broken file on every boot. A boot that fails after the
  database was opened closes every connection and forgets its in-memory
  state; the next request or alarm boots afresh.
- **What a boot costs.** A boot checks for local turns with one
  `SELECT 1 … LIMIT 1` (the boot log reads `turns=yes` or `turns=none`). It
  hashes the whole working copy only while a legacy Matrix copy may still
  need removing (the store can remove one, `legacyCleared` is unset, and
  the copy holds turns). A zero-turn copy probes the gateway for a legacy
  copy: a probe that proves there is none, or finds a copy without turns,
  is remembered (`meta:legacyUnusable`) and later boots skip it. A legacy
  read that fails (Matrix unreachable, a failed download) is no answer: it
  is logged as a warning, does not fail the boot, and the next boot probes
  again. Adopting a legacy copy clears the marker.
- **Never wipe on a failed check.** A `head()` that fails (a VFS error), or
  that lands in the flush's own window between its two moves (see below),
  is UNKNOWN, never a deletion. Even a
  proven upstream absence never auto-wipes a working copy that holds turns;
  it is re-uploaded on the next flush. Only a zero-turn copy is dropped; a
  genuine "forget me" goes through the explicit `remove()` path. A file
  that changed upstream (a new etag) is re-imported only when every local
  write was already uploaded; over local writes that are not uploaded yet
  the local copy is kept, marked dirty and replaces the upstream file on
  the next flush (`owner copy … changed upstream … keeping the local copy`,
  a warning).
- **Flush.** The first write after an upload records a deadline 24 h out
  (`meta:flushAt`, `FLUSH_DEBOUNCE_MS`) and arms the alarm for it; later
  writes never push it back. The alarm is shared with the realtime
  heartbeat, the durable-run keep-alive, task runs, compaction and the R2
  tier, so a wake alone never uploads: the tick consults the deadline
  (`do/flush-schedule.ts`) and a dirty copy waits until it is due. The only
  early uploads are the explicit ones (`POST /debug/storage/flush`, a new
  delegation only while a flush failure is recorded — a user who
  alternates two clients' delegations does not upload per request — the
  legacy migration, a reset) and the one before an idle eviction. The dirty
  mark and the deadline are written once per debounce window, not per
  turn. A copy dirtied
  by an older build with no deadline on disk uploads once, then the
  debounce applies. A failed upload replaces the deadline with the
  10-minute retry, so a failing store is retried on that clock and not on
  every wake. The
  export pins a snapshot of the chunk VFS and reads it exactly twice: one
  streamed pass computes the hash (the change gate) and the gzipped length
  the upload needs (`owner-store/measure.ts`), and, only when the bytes
  changed, a second pass streams gzip → tus upload in 5 MiB parts (files
  ≤ 5 MiB in one `POST`) → a temp path (`.uploading-<ts>`). The swap is
  moves only (`src/owner-store/ixo-vfs-store.ts`): `batch/move` of the old
  file aside to `.replaced-<ts>`, `batch/move` of the temp into place, and
  only then `batch/delete` of the old copy and of leftovers of earlier
  flushes (`.uploading-` and `.replaced-` files). The path is empty only
  between the two moves. When the move into place fails for good, the old
  file is moved back before the flush fails; when that restore fails too,
  the log says `… is empty: the previous copy stays at <path>.replaced-…`
  and the next good flush cleans it up. While the path is empty after such
  a failed swap, `head()` and `load()` use the newest `.replaced-<ts>`
  copy (never an `.uploading-` temp, whose swap did not finish), so a boot
  or reset in that state loads the previous copy instead of nothing. A
  "Destination occupied" answer (409) moves the occupant aside as well. A
  move whose response was lost but which the VFS committed answers its
  retry with a per-item 409 ("File changed concurrently"); when the file
  being moved is then already at its destination, the move counts as
  done. Two passes, not three, because
  with the R2 page tier every pass over a cold file is one R2 GET per
  1 MiB segment. Every request is retried 3× (2 s / 5 s / 15 s; parts
  resume from `HEAD`); a flush that still fails leaves the copy dirty and
  retries after 10 min, logged at error from the third consecutive failure.
  A leftover may be the only complete copy, so none is deleted before a
  new file has landed. Nothing is ever written to Matrix media.
- **Idle eviction.** After five days without a request from the user
  (`IDLE_EVICT_MS`) the working copy is wiped — only after a flush and a
  check that the upstream copy is current (generation + hash); otherwise it
  stays and the check repeats. The object's own wakes do not count as
  access: the alarm, flushes (scheduled or `POST /debug/storage/flush`),
  the tier flush, a reset, the task and run status reads
  (`GET /debug/tasks`, `GET /debug/runs`) and the
  `GET /debug/sessions/:id` and `GET /debug/memory-schema` reads boot it
  with `ready(…, { recordAccess: false })`. The last access is kept in memory
  and written to storage (`meta:lastAccessAt`) on an instance's first
  request, then at most hourly, and before every idle decision; an instance
  that unloads can therefore lose up to an hour of it. A scheduled task or
  any other pending deadline (a flush retry, a run, compaction) keeps the
  copy; the R2 tier's next pass does not, because the wipe deletes the
  object's R2 prefix with the working copy, and the idle decision runs
  before the tier pass. A request can arrive while that check awaits (the hash reads the
  whole file, from R2 for tiered pages), so idleness is read again after it
  (last access, dirty flag, runs, a flush in flight); activity keeps the
  copy (`became active during the idle check`). The object drops its handles
  before the wipe starts, and a request arriving during the wipe waits for
  it and boots afresh from the owner copy (`src/do/idle-eviction.ts`).
  Every deadline armed between ticks (a flush or its retry, a task,
  compaction, a run's keep-alive or recovery) also lowers the stored
  housekeeping deadline (`meta:housekeepingAt`), which the heartbeat-only
  fast path trusts, so an attached socket never delays them; a run's
  keep-alive deadline is what boots a reset object to recover its runs. `GET /debug/storage` shows `writeGeneration` /
  `uploadedGeneration`, `dirty`, `nextFlushAt` (the deadline, absent when
  clean), `lastFlushAt`, `flushFailures`, `lastVacuumAt`, `legacyCleared`,
  `indexingInFlight`, `flushInFlight` and the alarm.
- **Session titles** are generated in the background (`ctx.waitUntil`),
  bounded by a 15 s timeout and by the turn's abort, so `done` and the
  Matrix reply never wait for them. Restricted task sessions get no title.
- **Expired plugin blobs** (`blob:` keys in the object's KV) are swept one
  page of 128 keys per alarm tick, resuming from an in-memory cursor; a
  new sweep starts at most once an hour per object instance
  (`BLOB_SWEEP_INTERVAL_MS`), and the follow-up tick is armed after the
  idle decision, so it never keeps an idle copy alive. A failing sweep is
  logged and does not fail the tick.
- **VACUUM** runs on a quiet object (no turn for 10 min, not dirty, no flush
  in progress, file ≥ 4 MB with > 20 % free pages, at most once per 6 h,
  2× the file below the 10 GB cap; `src/sqlite/vacuum-policy.ts`) through
  `VACUUM INTO` a spill file swapped in atomically, so a rebuild of a
  multi-hundred-MB file needs constant memory.
- **R2 page tier** (`TIER_BUCKET` bound; [architecture](architecture.md#r2-page-tier)).
  The housekeeping alarm runs an eviction pass at most every six hours
  (after the owner-store flush and the idle decision, never over a flush in
  flight or while a run executes): chunks untouched for `TIER_EVICT_AFTER_PERIODS` days go to R2 in
  rewritten 1 MiB segments, at most 64 segments per pass (the rest re-arms
  in a minute). A pass holds the database lock only for its storage steps
  (planning, reading one segment's rows, committing that segment), never
  across an R2 upload, so a turn that starts mid-pass is not blocked. When
  the file changed under a segment (a truncation, an import, a rename or
  delete, a snapshot opened), the pass stops, its upload is queued for
  deletion, and the next pass starts over. The orphan sweep (R2 objects the
  map no longer references) runs from a persisted schedule: at most weekly,
  one R2 listing page (1,000 keys) per step, resuming where it stopped,
  never while a pass has uploads in flight. It deletes only keys shaped like
  tier segments (`<object id>/<file>/<segno>.<gen>`), so the result store's
  `<object id>/results/…` objects in the same bucket are left alone. The log line
  reads `tier pass for <did>: N chunks → R2 in S segment(s), H hot rows
(M MB) kept, P segment(s) pending`. `GET /debug/storage` → `tier` shows
  `hotRows`/`hotBytes`, `coldSegments`/`coldBytes`, the R2 op counters,
  `coldMisses` / `missResolutions` / `retries` (how often a turn had to
  fetch), `pendingDeletes` and `lastPassAt`. A `tier segment … missing in
R2` error means the bucket lost an object the map references — the
  user's VFS file is intact; `POST /debug/storage/reset` reloads from it.
  The idle wipe deletes the object's R2 prefix along with the working copy.
- **Chunk cache.** `CHUNK_CACHE_BYTES` (default 4 MiB) sizes the per-object
  LRU of clean chunks. Measured on devnet with a 28 MB file, 8 MiB was
  indistinguishable in turn latency (the LLM round-trip dominates), so the
  default stays small; `8m` is the knob for unusually large working sets.
  An idle user object is unloaded by the platform within ~10–15 s of its
  last request; the next request re-opens the file (~200–400 chunk rows).
- **Legacy Matrix copies** of migrated users are redacted once the VFS is
  confirmed to hold the file (`removeLegacyCopy`, logged as `legacy Matrix
copy removed`; `legacyCleared` in `/debug/storage`).
  The import itself is streamed (see [architecture](architecture.md#self-sovereign-storage)):
  decrypt → gunzip → header check → chunk VFS, then the flush to the VFS
  from a snapshot; a legacy file of any size costs a few chunks of memory,
  and a failed VFS write after the import keeps the working copy dirty and
  retried every 10 min while the object serves the imported history. The
  boot log reads `imported N bytes from legacy Matrix media` followed by
  `migrated N bytes from legacy Matrix media to vfs (<etag>)`. When the VFS
  holds no file, a legacy read that fails (Matrix unreachable, a forbidden
  or failed media download) fails the boot like any owner-copy load, and the
  next request retries; it never starts an empty history. Only a legacy
  copy proven unusable (its whole header arrived and is not SQLite) counts
  as absent, logged at error as `legacy Matrix copy is unusable`.

## Realtime channel

The engine.io heartbeat runs from the object's alarm, not from a timer: a
wake every 180 s (`PING_INTERVAL_MS`) sends the ping and closes sockets that
missed interval + timeout (240 s), then the object hibernates again. A wake
that is only due for the heartbeat re-arms without opening the database.
Sockets and their ping/pong bookkeeping live on the socket attachments and
are re-adopted from `ctx.getWebSockets()` on every wake. Pending browser
calls do not survive a restart (neither does the turn that made them).
A socket joins only a session of the user its CONNECT token proves; a
session lookup that fails refuses it. Browser tools and AG-UI actions follow
the [frontend bridge](frontend-bridge.md) contract: each invocation has its
own id, goes to one socket of its session (the one with the latest client
event, else the one that connected last) and settles only from
that socket; a result from another socket, with a different `sessionId`, or
for an invocation already settled is rejected with a `[realtime] … rejected:`
warning that names ids only. A call no socket can take fails at once; one
whose answer misses its deadline or whose socket goes resolves with
`FRONTEND_OUTCOME_UNKNOWN` and is never re-sent. `GET /debug/realtime`
shows `pendingCalls` (with the executing socket's `executorSid`) and
`completedCalls`. A
dead connection is noticed by either side after up to four minutes; the
client SDK's reconnect then restores it. `socket.io-client` must use
`transports: ['websocket']`.

Until its CONNECT is accepted a socket is unauthenticated, and it is
bounded accordingly (`src/realtime/realtime-endpoint.ts`): it must
authenticate within 10 s (`HANDSHAKE_DEADLINE_MS`) or is closed with 4408,
and a socket restored after a restart gets only the rest of that window.
One CONNECT per socket is validated at a time (a second one meanwhile is
ignored). No heartbeat alarm is armed for it, and `nextPingAt` counts only
authenticated sockets. A text frame over `MAX_PAYLOAD_BYTES` (1,000,000
bytes of UTF-8, the limit the OPEN handshake advertises) closes the socket
with 1009 before it is parsed.

Turn events reach the sockets too, mirrored through the event router's
taps on the Node runtime's wire: the socket event `event` carrying
`{ eventName, payload }` (`tool_call`, `render_component`, `router_update`,
`message_cache_invalidation`, …), which is the envelope the client SDK
validates before it dispatches. `browser_tool_call` and `action_call` are
not mirrored: they reach a socket only as a dispatched invocation, by name
with the raw payload, because the SDK executes them. `message` / `done`
chunks stay SSE-only.

Background work is bounded: the session-history indexer runs under
`ctx.waitUntil` with at most two attempts, 3 s apart, each with a 20 s
timeout on the memory-engine request; a failed session is retried on the
next session create because its watermark did not move. Task-run sessions
(`task:<id>`) are never indexed: a session create indexes the user's most
recent conversation, skipping task runs.

## Anonymous response feedback

`POST /messages/:sessionId/:messageId/feedback` turns one user's free-text
feedback about one completed Agent reply into one Linear issue, in the team
and project from [configuration](configuration.md#anonymous-response-feedback)
(default: Studio, "User Feedback from Portal"). With the feature off the route
answers `404` and the transcripts carry no `capabilities` field, so the
Portal never shows the control.

Body: `{ submissionId, feedback, context }` — a client UUID v4 reused on
retry, 1–2000 characters, and the allowlisted context: `surface`, `locale`
(a language with an optional region only, such as `en`, `en-GB`, `es-419`),
`theme`, `deviceClass`, `viewportBucket`, `network`, and an optional
`portalBuildVersion` (a release such as `1.4.0` / `1.5.0-rc.2` /
`1.4.0+4f2ea36`, or a 7–40 character commit sha). Any other field or shape is
a `400`.

Every refusal carries `{ statusCode, code, message, retryable }`; the SDK
copies `code` and `retryable` onto its `RequestError`. `retryable: true`
means: send the same submission (same `submissionId`) again later.

| Status | `code`                            | Retryable | When                                                                                                                                     |
| ------ | --------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 200    |                                   |           | Delivered; or a replay of the delivered submission (same `submissionId`, same `submittedAt`, no second issue).                           |
| 400    | `FEEDBACK_INVALID`                | no        | Body not in the contract.                                                                                                                |
| 400    | `FEEDBACK_EMPTY`                  | no        | Empty after normalising and trimming.                                                                                                    |
| 401    |                                   |           | No valid UCAN invocation.                                                                                                                |
| 404    | `FEEDBACK_DISABLED`               | no        | The feature is off.                                                                                                                      |
| 404    | `FEEDBACK_TARGET_NOT_FOUND`       | no        | No such session or message in the caller's own database; a user message; a reply of the turn still running or recovering in the session. |
| 409    | `FEEDBACK_IN_FLIGHT`              | yes       | This same submission is being delivered right now (a client retrying after a timeout).                                                   |
| 409    | `FEEDBACK_ALREADY_SUBMITTED`      | no        | Different feedback for the message was delivered or is being delivered.                                                                  |
| 413    |                                   |           | Body over 16 KiB.                                                                                                                        |
| 422    | `FEEDBACK_CONTAINS_PERSONAL_DATA` | no        | The text holds an email, Matrix id, DID, wallet address, phone number, credential or secret-bearing URL.                                 |
| 429    | `FEEDBACK_RATE_LIMITED`           | yes       | More than 3 new submissions a minute from the user, or the per-IP limit (see configuration).                                             |
| 502    | `FEEDBACK_DELIVERY_FAILED`        | yes       | Linear did not confirm the issue after bounded retries; the reservation is released, so the user can send again.                         |

The text is screened after Unicode NFKC normalisation with invisible format
characters (zero-width spaces and joiners, bidi marks) removed, and that
normalised text is what is sent. Dates (`2026-10-05`), year ranges and
grouped amounts (`1 000 000`) are not taken for phone numbers.

The flow: the shell validates and screens the text, then asks the user's
object to check the target and reserve a marker (`message_feedback_markers`:
session id, message id, submission id, the submission it took over if any,
status, timestamps — one row per message, removed with its session; a table
an older build created gains the newer columns in place when the object
opens). The
shell then calls Linear: it looks for an issue whose description holds the
message's pseudonym and creates one only if there is none, at most three
attempts each with 250/500 ms backoff. Only a rate limit (HTTP 429 or
GraphQL `RATELIMITED`) waits for Linear's `X-RateLimit-*-Reset` (epoch ms)
instead — Linear sends those headers on every response, so they are not a
retry hint otherwise — and the sink gives up rather than wait more than 2 s.

A reservation the shell never settled (its isolate died) is reclaimed after
2 minutes. Taken over by the same submission, the pseudonym lookup finds the
issue it may already have created and the answer is `200`. Taken over by a
different submission, the issue that exists is the earlier one's: the new
text is not sent, the marker is settled under the earlier submission, and the
answer is `409 FEEDBACK_ALREADY_SUBMITTED` — never a `200` for text that went
nowhere.

**What the issue holds**: a neutral title (`[Agent feedback] <surface> ·
<UTC time>`), the screened feedback text, the submission id, keyed
pseudonyms of the user, session and message (`user_<hmac>`, …), the oracle's
entity DID and name, the deployment's default model and provider, the
allowlisted context, the QiForge build and the time.

**What never leaves the oracle, and what is never kept**: the prompt, the
reply, reasoning, tool calls or results, attachments, the user's DID, raw
session and message ids, the IP address (only its pseudonym keys the rate
limit), the user agent, URLs, payment data and location. The feedback text
is held only for the request: it is not written to the user's database or
the owner copy, and no log line carries it, the DID or the ids. The
feedback log lines are `[feedback] issue delivered`, `[feedback] an earlier
submission already delivered the issue`, `[feedback] delivery failed:
<status/code>` and the settle warnings. The shell's own lines that name a
caller — the bare-delegation `[auth]` warning and the `[shell] … failed`
error — log the matched route pattern (`/messages/:sessionId/:messageId/feedback`),
never the concrete path with its ids.

Pseudonyms are HMAC-SHA256 under `FEEDBACK_HMAC_SECRET`: whoever holds the
secret and a user's DID can recompute that user's pseudonym, so treat the
secret like the Linear key. Linking an issue to a user otherwise needs both
the Linear workspace and Cloudflare's own request logs (Workers Logs and
Logpush can record the request URL, and with it the raw session and message
ids, outside the runtime's control).

## Bundled plugins: what they refuse

The constants named here are listed in
[configuration](configuration.md#built-in-limits).

- **VFS file tools** act only on the file whose path equals the one given:
  `*` and `?` are not wildcards there (a real file whose name contains them
  still resolves), and a path that matches two files is refused.
  `vfs_share` refuses a wildcard path that is not a file. `vfs_move` and
  `vfs_delete` take files only and point the model at `vfs_glob` for a
  folder's files. `vfs_delete` takes at most 50 paths
  (`VFS_DELETE_MAX_PATHS`), looked up 6 at a time, each repeated path once.
  `vfs_read` answers with a metadata stub, without downloading, for an
  image or document over 10 MB and for a binary type it would not render.
  A path containing `*` or `?` is looked up through `/glob` in pages of 200
  until the page holding the exact path, at most 25 pages (5,000 matches);
  past that the tool refuses and asks for the file to be renamed rather
  than answering "not found". `VFS_REQUEST_TIMEOUT_MS` (default 20,000) and
  the turn's abort hold until the response body has been read; a stalled
  body fails as `Filesystem request timed out.` and is not retried.
- **Sandbox ↔ VFS transfers** are capped at 10 MB
  (`MAX_SANDBOX_TRANSFER_BYTES`): `sandbox_to_vfs` checks the size inside
  the sandbox before encoding, `vfs_to_sandbox` before downloading, and it
  always sends base64, so text in any encoding arrives byte for byte.
  `sandbox_write_blob` reports `success: false` for a failed write. A
  sandbox connect reads the user's secrets with one room-state read
  (`ctx.secrets.getAll()`).
- **MCP call timeouts.** Sandbox, memory-engine and Firecrawl tools are
  MCP tools; each call carries its timeout as the MCP request's own
  (`metadata.timeoutMs`, which the MCP SDK clears when the response
  arrives; without it the SDK cuts a call at 60 s): sandbox 180 s
  (`SANDBOX_MCP_TIMEOUT_MS`, the plugin and the VFS bridge), memory 420 s,
  Firecrawl 120 s. Each call also races the runtime's own always-cleared
  timer (`withCallTimeout`), which closes the client when it fires. No
  LangChain tool timeout is ever set (see the workerd rules in
  [architecture](architecture.md#rules-of-the-road-on-workerd)).
- **Composio** tools are not MCP tools and take no signal: each call is
  raced against 190 s (`COMPOSIO_TOOL_TIMEOUT_MS`) and the turn's abort,
  and the request is abandoned, not cancelled. The Composio client itself
  gives each HTTP attempt 60 s and retries a timed-out or 5xx `execute`
  up to twice, so a side-effecting Composio action can run more than once;
  the client exposes no option to turn that off.
- **User preferences.** `set_user_preferences` fails when the stored
  preferences could not be read, instead of overwriting them; a room with no
  preferences event yet still gets one. `tone` is at most 120 characters
  (`MAX_TONE_LENGTH`); a longer stored tone is cut to 120 when read.
- **Editor.** `delete_block` and `move_block` refuse a `secrets` or `skills`
  block, or a block with one nested inside it (`prop_not_editable`). One
  `call_editor_agent` run opens its document once, on the first content-tool
  call, and closes it when the run ends however it ends; the inner agent
  gets the turn's abort signal. A document write is sent at most
  `DOC_WRITE_MAX_ATTEMPTS` (4) times within `DOC_WRITE_RETRY_BUDGET_MS`
  (15 s), with back-off from `DOC_WRITE_BASE_BACKOFF_MS` (250 ms) and
  `retry_after_ms` honoured; only 408, 429, 5xx and network failures are
  retried (a 400, 401 or 413 abandons the write at once). A caller
  waits at most `DOC_FLUSH_TIMEOUT_MS` (20 s) for pending changes. The
  outcome of a write the guard gave up on is one of three codes: a write
  the homeserver forbade (`M_FORBIDDEN`) is `needs_access`; one it refused
  outright (a 400, 401 or 413) is `error` — nothing was stored and the
  same change must not be resent unchanged; one that was never
  acknowledged is `write_not_saved` — it may or may not have landed, so the
  document is re-read before retrying. A document that fails to load fails
  the tool within its retry budget instead of hanging; disposing it ends a
  load's back-off and availability wait at once. A client skips
  `POST /join` for a room it joined in the last 60 s
  (`JOIN_REUSE_WINDOW_MS`); a write refused with `M_FORBIDDEN` forgets
  that join, and a load
  refused with 403 after a skipped join joins and retries once.
- **Flows.** Flow writes go through the same guard and report the same
  three codes (`needs_access`, `error`, `write_not_saved`).
  `create_template` refuses a room that already holds a flow
  (`validation_failed`) and points at the edit tools. `add_step` keeps the
  flow's title, owner and step order and refuses a step id that already
  exists. `update_step` and `add_step` check every part of the change
  before the first write, so an invalid change writes nothing. Assigning a
  step authorises that DID to run it, so the assignee must be a `did:`
  value. Secret inputs — every input port the action catalogue flags
  `secret` (`src/plugins/flows/action-metadata.ts`: PINs, mnemonics, Matrix
  access tokens, passwords and recovery phrases, a plaintext OpenRouter
  key, deploy `secrets` maps), matched by name on every action — accept
  only a `{{<step>.output.<field>}}` reference to a step of the same flow,
  at any depth; a literal value, or anything else in braces, is refused.
  `fill_form` refuses any secret-named answer and a form that is running,
  completed or awaiting read-back. Authored flows are bounded
  (`src/plugins/flows/input-policy.ts`): 30 steps, 16,000 bytes of UTF-8
  per flow, 12,000 per step, 40 inputs and 8,000 bytes of inputs per step,
  8,000 bytes of form answers, plus caps on ids, names, descriptions,
  conditions, skills and form questions; a larger input is
  `validation_failed` naming the limit.
- **Browser tools and AG-UI actions** a request declares are checked per
  request (`src/plugins/portal/declared-tools.ts`): a name must match
  `^[A-Za-z0-9_-]{1,64}$`, a later duplicate is dropped, a description over
  2,048 characters or a schema over 16,384 drops the tool, and at most 64
  are kept. A request's dropped declarations are logged as one warning
  naming at most five of them
  (`Ignoring N declared browser tools: "<name>" (<reason>), … and M more`;
  `AG-UI actions` for the AG-UI plugin). A declared name
  equal to a server tool's name is not caught here: the plugins pass no
  reserved names.

## Artefact sweep

Expired artefact share copies (`art/<id>` in `ARTIFACT_BUCKET`) are deleted
by the cron tick of the script that binds the bucket (`src/artifacts/sweep.ts`),
so copies nobody opens again do not stay in the bucket. It needs a cron
trigger on that script: the single-script layout's `*/5 * * * *` keep-alive
cron covers it; in a gateway split, give the oracle script its own (the
example's devnet config uses `0 3 * * *`). The gateway script's cron never
sweeps. The keep-alive runs first; a failed keep-alive does not stop the
sweep and still fails the cron invocation afterwards.

- **State.** One JSON object, `artifact-sweep/state` (outside `art/`, so a
  lifecycle rule on `art/` never removes it):
  `{ v: 1, sweptAt, cursor }`. `sweptAt` is when the last full sweep ended;
  `cursor` is set while a sweep is unfinished. A missing or unreadable state
  counts as "never swept"; deleting it forces a full sweep on the next tick.
- **Throttle.** A tick with no unfinished sweep and a `sweptAt` younger than
  `ARTIFACT_SWEEP_INTERVAL_HOURS` (default 24) reads the state and stops.
  It logs nothing.
- **Bounded work.** A tick lists at most 20 pages of up to 1,000 objects
  (`include: ['customMetadata']`, never a per-object read) and deletes the
  copies whose `expiresAt` has passed, up to 1,000 keys per delete. A copy
  without a readable `expiresAt` is left alone. A larger bucket is finished
  over the next ticks from the stored cursor, whatever the interval.
- **Logs.** One line per tick that did work:
  `[artifacts] sweep finished: pages=… seen=… deleted=… unknown=… resumed=… elapsedMs=…`
  (`sweep paused, resumes next tick:` while pages remain). `unknown` counts
  objects without a readable `expiresAt`; a steady non-zero value means
  something else writes under `art/`. A failure logs
  `[artifacts] sweep failed: <error> (…counters)` once, writes no state, and
  the next tick retries from the last stored cursor. Two overlapping ticks
  are harmless: the second only re-deletes deleted keys.
- **Cost.** Per tick between sweeps: one Class B read (the state). Per sweep:
  one Class A list per page (up to 1,000 objects; R2 may return fewer per
  page when it includes metadata), one Class A write per tick the sweep
  spans (one for a bucket under 20,000 objects), one Class B read per tick,
  and free deletes. With the 5-minute cron that is 288 reads a day plus the
  daily sweep.
- **Stuck cursor.** A resume whose first list fails (`sweep failed` with
  `resumed=true pages=0`) drops the stored cursor and logs
  `sweep dropped its stored cursor`; the next tick starts a fresh sweep. A
  transient R2 error at that point costs the same restart. To force a fresh
  sweep by hand, delete the state object
  (`wrangler r2 object delete <bucket>/artifact-sweep/state --remote`).

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

## BYO model the provider refuses

The pre-turn checks (credential present, token fresh, backend reachable)
cannot tell whether the user's provider serves the selected model. The
ChatGPT backend answers a model id the subscription does not offer with an
immediate `400` and an empty body (logged as
`[byo-chatgpt] backend 400 Bad Request: <empty body>`); an API-key provider
answers `404 model_not_found` or a "does not exist" text. Every BYO model the
adapter hands out (`createByoLlmAdapter`) is wrapped in
`ByoModelFallbackChatModel` (`src/llm/byo-model-fallback.ts`), which turns
that into a fallback instead of a failed turn:

- **When it fires.** A BYO model call fails before the provider produced any
  output (text, reasoning or a tool call) with an error
  `isModelUnavailableError` (`src/llm/provider-error.ts`) accepts: an explicit
  `model_not_found` / `unsupported_model` code or a "does not exist", "is not
  supported", "unsupported model" text on a 400/403/404 or status-less error,
  or a bare HTTP 400/404 that is nothing else known (not a context overflow,
  not LangChain's `INVALID_TOOL_RESULTS`, not a billing / auth / rate-limit /
  timeout / network / server text). A failure after output keeps the old
  behaviour (`error` frame, `done { failed: true }`).
- **What the client sees.** The same `error`-channel notice the pre-turn
  fallbacks send — `kind: 'byo_fallback'`, `reason: 'model_unavailable'`,
  `source: 'byo'`, `retryable: false`, plus `model` (the refused id) — e.g.
  "Your ChatGPT subscription doesn't offer GPT-5.6 Terra, so this reply used
  the platform model instead. Pick another model in your Personal Agent
  settings." (API-key providers: "Your OpenAI API account doesn't offer …";
  the catalog label when the id is catalogued, else the id). The wrapper
  raises it as a LangChain custom event (`byo_fallback`); `runTurnFrames`
  writes it as an `error` frame in stream order, ahead of the platform
  model's reply, which answers the very same call; the turn ends with a plain
  `done`. The client SDK treats an `error` frame as a callback only, so the
  run continues.
- **Scope.** The refusal is remembered per model id for the rest of the turn
  (the adapter is per turn): later calls to that id — the main agent's next
  steps, sub-agents and helpers asking for the same id — go to the platform
  model directly. Other BYO ids of the turn (the helper roles' models) stay
  on the user's account. Nothing is persisted: the next turn on that model
  tries the provider again and falls back again, with the same notice.
- **Logs.** One `[byo] <provider> refused model "<id>" (HTTP <status>): …`
  warning per refused id per turn.
- **Errors after the fallback.** A failure of the platform model answering
  for the refused one is classified as a platform failure (and an operator
  auth/billing fault is redacted), not blamed on the user's account.
- **Limits.** The turn's context budget was sized from the BYO model's
  window, and `runtime.context.byo` still reports the turn as BYO (the
  history sanitizer and anything else reading it see a BYO ChatGPT turn). A
  refusal on a model call made outside the streamed graph (attachment
  extraction while the turn is prepared) still falls back, but the notice has
  no stream to ride and is dropped.

## Known limits

- The per-DID rate limit (100 requests / 60 s in the example config) is the
  first ceiling a single client hits, not the object. A channel turn spends
  the same budget, checked before the Auth Hub call.
- Anonymous feedback: the identifier screen is pattern-based (it catches
  emails, Matrix ids, DIDs, wallet addresses, phone numbers and credential
  shapes, not names or street addresses); a user can send one feedback per
  Agent reply; the per-IP limit uses Cloudflare's rate-limit binding, which
  counts per Cloudflare location, not globally.
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

| Symptom                                                                                                   | Check                                                                                                           | Action                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/matrix/status` `instanceId` changes without a `planned recycle` log line                                | Cloudflare analytics `exceededMemory`; `sendQueue.inFlight` at the time                                         | Lower `MATRIX_SEND_CONCURRENCY` / `MATRIX_TURN_CONCURRENCY`; check `cryptoStoreTransactions` stays a handful.                                                                        |
| `oneTimeKeys.uploads` climbing continuously, `One time key … already exists` in the log                   | `deviceRotations`                                                                                               | The SDK rotates by itself; if it loops, `POST /debug/matrix/rotate-device` once and prune stale devices.                                                                             |
| Sends stall, `sendQueue.durableRows` grows, `null pointer passed to rust` in the log                      | `GET /debug/matrix/outbox` for rows with a bad thread id or high attempts                                       | The watchdog drops the row after three attempts; nothing to do unless the same row keeps coming back — then find who produced it.                                                    |
| `GET /sessions` empty for a migrated user, `HISTORICAL_MESSAGE_NO_KEY_BACKUP`                             | `keyBackupVersion`, `secretStorageUnlocked`                                                                     | Provision the key backup and `MATRIX_RECOVERY_PHRASE` (see configuration → first-time setup).                                                                                        |
| Page edits fail with `401 Invalid access token`                                                           | Device list of the bot account                                                                                  | The plugins device was deleted; the gateway re-logs it in on the next use and the next turn's editor client uses the new token — do not delete `identity:bot-client`'s device again. |
| A 500 `Internal server error` with a `requestId`                                                          | The log line `[shell] <method> <path> failed (request <requestId>)`                                             | The response body never carries the cause; the log line does.                                                                                                                        |
| A user object never unloads (`instanceUptimeMs` grows while idle)                                         | `GET /debug/realtime` → `pendingTimers`; `activeTurns`, `indexingInFlight`, `flushInFlight` in `/debug/storage` | A leaked timer or an open MCP stream — see the workerd rules in [architecture](architecture.md#rules-of-the-road-on-workerd).                                                        |
| Requests fail 503 `OWNER_COPY_UNAVAILABLE`                                                                | VFS health                                                                                                      | Transient by definition; the client retries. 403 `NO_VFS_DELEGATION` means the user must deposit a grant.                                                                            |
| A plugin with `requires` is refused although the user authorized it; `[UCAN] the delegation expired at …` | `GET /debug/delegation` (the stored delegation's expiry)                                                        | Validity is checked at use: an expired stored delegation grants nothing even while the object stays warm. The user re-authorizes (a new delegation).                                 |
| An admin tool (or its whole plugin) is missing for a user; `[main-agent] admin tools withheld from <did>` | `GET /debug/delegation`; the grants the user issued                                                             | Expected without the grant: the user delegates `admin-tool/invoke` on `ixo:qiforge:admin-tool/<plugin>[/<tool>]` (architecture → Admin-plane tools).                                 |
| `Network connection lost` on a gateway RPC                                                                | Gateway just restarted                                                                                          | Expected once per restart; waited sends retry by themselves.                                                                                                                         |

## Write claims and turn usage

`turn_write_claims` (in the user's run ledger, next to `turn_runs` and
`turn_tool_marks`) holds one row per write whose outcome is not known:
the SHA-256 of the tool name and canonical arguments, the tool name, the
run and session that started it, when, and a state. Never the arguments.

- A returned outcome — success, or a failure the service reported (a 4xx,
  a validation error) — releases the row.
- An abort, the turn deadline, a dropped connection or a 5xx keeps it
  (`pending`) — thrown, or returned by a tool that catches its failures
  (an error-status result, a JSON `ok`/`success`/`successful: false`,
  `isError` or `error` body, or text opening with `Error` / `Failed`, whose
  cause is a timeout, a transport failure or a server error:
  `[tool-execution] <tool>: returned a failure that leaves its outcome
unknown (…)`). The cause is read from how such failures are reported — a
  transport error code (`ECONNRESET`, `ETIMEDOUT`, `UND_ERR_…`), `fetch
failed`, `socket hang up`, `Network connection lost`, `timed out`, an
  `AbortError` / `TimeoutError` name, the editor's and flows'
  `write_not_saved` (a document write that may or may not have landed), a
  5xx
  status or reason phrase — never a bare word, so a refusal such as
  `network 'base' not supported` releases the row. A returned failure of
  any other kind is a reported one.
- An identical write attempted while a row stands is not run. The model
  gets an error tool message asking it to verify with a read and tell the
  user; the row becomes `warned` and is owned by that run, which stays
  blocked. A later turn that asks for the same write again runs it: the
  user was told and asked again.
- Rows are per user object (every session of the user) and are dropped
  with the run retention (7 days) at the next setup.

To inspect, use the existing storage inspection route and read
`turn_write_claims`. To clear one by hand after reconciling the external
receipt, delete its row; do not clear rows merely to make a retry pass.

`turn_runs.usage` carries the turn's usage once the run ended: estimated
and provider-reported tokens, model calls, tool attempts and elapsed time
(`[harness] turn <requestId> usage: …` in the logs). Estimates, not an
invoice.

A turn that ends on a budget or deadline shows on the wire as an `error`
frame with `kind: budget_exhausted` and `retryable: false`, then `done`
with `failed: true`. The client SDK reports it as a failed run; it never
resubmits a POST by itself. Before raising a limit, check the run's usage
and the tool marks for the loop that spent it.
