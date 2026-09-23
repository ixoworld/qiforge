# Parity with the Node runtime

The Workers runtime is a port of `@ixo/oracle-runtime`, not a rewrite of its
behaviour: the plugin API, the wire protocol, the auth model and the on-disk
formats are the same, so a user can move between the runtimes. This page is
the contract — what is identical, what is ported with a different
implementation, and what is deliberately left out.

## Identical

- **Plugin API**: `OraclePlugin` / `defineOraclePlugin` / `tool()`,
  manifests, `configSchema`, `autoDetect`, boot/request tools, sub-agents
  (with `forwardTools`), middlewares, shared state, auth-excluded routes.
  `getNestModules` is replaced by `getRoutes(ctx)` (plain `fetch` handlers).
  `createOracleWorker({ features, manifestOverrides })` are Node's
  `createOracleApp` options with the same semantics: overrides are
  shallow-merged over a loaded plugin's manifest at boot (e.g.
  `{ portal: { visibility: 'always' } }`), unknown names are logged and
  ignored, the merged manifest is validated like an authored one.
- **Decisions**: `getDecisions(ctx)`, `ctx.decisions.evaluate` /
  `evaluateByName`, the seventh registry (`DecisionRegistry`, collision-checked
  in `warm()`), `createOracleWorker({ decisionAdapter })` = Node's
  `createOracleApp({ decisionAdapter })`, and the same `DECISION_PROVIDER` /
  `DECISION_MODEL` env (`openrouter-jev` reusing `OPEN_ROUTER_API_KEY`). The
  one Workers difference: `cloudflare-jev` runs through the Worker's `AI`
  binding when one is declared, so no Cloudflare account credentials are
  needed there. The capability router (`CAPABILITY_ROUTER=off|shadow|on`,
  `src/core/capability-router.ts`) is the first runtime consumer of Decisions
  on both runtimes, with identical semantics: the shared
  `capabilityRouteDecision` predicts the on-demand plugin a message needs,
  `on` preloads it for that turn only (never into `loadedPlugins`), `shadow`
  logs what it would have preloaded, and every failure preloads nothing.
- **Room threads are sessions**: a bare room message roots a thread, the
  reply is posted inside it, and the thread root's event id IS the session
  id (`src/matrix/ingest.ts`, `src/matrix/reply-chain.ts`) — Node's
  listener bridge rule. Messages inside the thread and quote-replies to it
  (resolved up the reply chain) continue that session; a reply typed inside
  a Portal session's thread continues the Portal session, whose id is its
  marker event. The main timeline of a room never carries a reply and is
  never a session, so a shared room stays readable and every conversation
  has its own transcript. `GET /sessions` lists the user's main oracle room
  only (Portal sessions and the threads opened there), as Node's
  `SessionsService.listSessions` does; threads in dedicated task rooms and
  task runs stay out of it. Files from the build that keyed room sessions as
  `matrix:<roomId>` / `thread:<root>` are renamed on boot
  (`src/do/session-id-migration.ts`).
- **Matrix group rooms** (`matrix-group-chats`, opt-in with
  `MATRIX_GROUP_ROOMS=gate` on the gateway — the default `silent` keeps the
  bot out of group rooms entirely): in a room with more than
  two members the oracle answers only when it is mentioned
  (`m.mentions`), quote-replied, or already in a thread it answered in
  within the last 30 minutes, and only when its power level lets it post;
  every message is still captured into the room's channel memory, which
  is compacted with the Node summarizer prompt into searchable chunks
  (FTS5, porter stemming, LIKE fallback) alongside pinned facts and the
  member roster; the four tools (`recall_channel_memory`,
  `search_channel_memory`, `pin_room_fact`, `unpin_room_fact`) are offered
  only in such rooms; a group message reaches the model as
  `[DisplayName]: …`. Node ran the gate as an agent middleware and kept
  the memory in a per-room SQLite file synced as room media; here the gate
  and the memory live in the gateway — see the divergences below, the
  plugin's own status and parity table
  (`src/plugins/matrix-group-chats/README.md`) and
  [operations](operations.md#rooms-group-chats).
- **Wire protocol**: `POST/GET /sessions`, `POST /messages/:id` (SSE events
  `message` / `reasoning` / `tool_call` / `action_call` / `error` / `done`),
  `GET /messages/:id`, `/messages/abort`, `/delegation`, `/health`,
  `/models`, and the socket.io realtime channel on `/socket.io/`. The SSE
  `error` payload carries Node's classification (`kind` / `source` /
  `provider` / `status` / `retryable` / `detail`), with platform-side billing
  and auth faults redacted before the wire.
- **Request validation** on `POST /messages/:id` mirrors Node's
  `ValidationPipe` and body parser: malformed JSON → 400, unknown top-level
  fields → 400, empty `message` → 400, oversized bodies → 413, unknown
  session → 404, transcript of an unknown session → `{ messages: [] }`. The
  body cap itself differs: 256 KiB here (`src/shell/turn-body-cap.ts`) against
  Express body-parser's 100 kb on Node. A Portal turn carries the browser-tool
  catalogue and the AG-UI action schemas (~92–98 KiB before the message
  text), so Node's default refuses ordinary turns; the Workers cap exists to
  bound memory per request, not to match Node.
- **Request metadata → agent state**: `metadata.editorRoomId`, `spaceId`,
  `sessionRunId` and `currentEntityDid` update the thread's checkpointed
  state by the Node agent-builder's rules (`src/do/turn-metadata.ts`): a
  request that names the editor room also defines its session run, an active
  editor context seeds the editor plugin into `loadedPlugins`.
- **Auth**: UCAN invocation (`Authorization: Bearer` + `X-Auth-Type: ucan`)
  with the `x-ucan-delegation` fallback; DID keys resolved through Blocksync.
  Header-less turns mint plugin invocations from the delegation deposited via
  `POST /delegation`, cached in the object; `POST`/`DELETE /delegation`
  update the object at once. `GET /delegation` additionally returns the
  stored delegation's `capabilities` (Node returns `authorized` and
  `expiration` only).
- **`GET /models`**: Node's `ModelListing` shape, priced from live OpenRouter
  list prices (cached an hour, catalog baselines on failure) times
  `MODEL_PRICE_MARKUP`.
- **Agent**: same graph state (including `loadedPlugins`), meta-tools
  (`load_capability` / `list_capabilities`), the ChatGPT-subscription history
  sanitizer, the summarization / capability-gate / tool-validation /
  repetition-guard middlewares, the host-gated page-context and
  safety-guardrail middlewares (`createOracleWorker({ hooks })` takes Node's
  `getRoomTitle` / `safetyModel` pair), OpenRouter per-role models.
- **Storage format**: `@ixo/sqlite-saver`'s exact schema — a `.db` written by
  the Node runtime loads here (tested against a legacy fixture).
- **Room state**: every `ixo.room.state` key this runtime touches
  (`ucan_delegation`, `user_prefs`) is written and read in the Node codec —
  `{ data: base64(zlib-deflate(superjson)) }` (`src/matrix/room-state-codec.ts`,
  proven against payloads from `@ixo/matrix`'s `MatrixStateManager`). Reads
  also accept the uncompressed legacy form.
- **Room replay of HTTP chats**: every HTTP/SSE turn is replayed into the
  user's oracle room as a thread under the session's root event, the user
  message as `**You:**`, the reply prefixed with the oracle name, markdown
  rendered like `@ixo/matrix`'s `formatMsg` (`src/matrix/replay-format.ts`).
  The turn never waits on it, as with Node's `MessagesService`; unlike Node
  it is queued per session and retried across a gateway restart (see the
  divergences below). Room-originated turns are answered in the room by the
  gateway; synthetic `$task-` sessions are skipped.
- **Session history → memory**: the previous session's transcript goes to
  the memory engine when a session is created and when a session is deleted;
  the watermark is the same `last_processed_count` column. A second trigger
  matches Node's `WsService.removeClientConnection`: the last authenticated
  socket of a session going away.
- **Per-room secrets**: the JWE scheme byte-compatible with
  `oracles-chain-client` (`ECDH-ES+A256KW` + `A256GCM`, PIN-locked account
  room key), served to plugins through the same secrets surface.
- **Matrix liveness**: the `work_status` card (`ixo.oracle.component`, edited
  in place: routing → Step n · … → delivering → done / superseded), quote-reply
  chains resolved to their thread (`src/matrix/reply-chain.ts`), and the
  throttled `ixo.oracle.delegation_required` room event when a Matrix turn
  has no usable delegation.

## Ported with a different implementation

| Surface                            | Node                                 | Workers                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled plugins                    | `BUNDLED_PLUGINS`                    | `BUNDLED_WORKERS_PLUGINS` (`src/plugins/`): memory, sandbox, firecrawl, domain-indexer, composio, vfs, tasks, editor, user-preferences; `FlowsPlugin` exported for opt-in wiring. MCP plugins drive the real `MultiServerMCPClient` inside workerd with per-user UCAN headers.                                                                                                                                                                       |
| Tasks                              | BullMQ / Redis                       | DO alarms; records live in the user's SQLite file; runs re-enter the agent as background sessions and deliver to the room, same preview → confirm → create and approval-gate contract; dedicated `[Task] <title>` rooms as on Node. Runs are at-most-once per occurrence (a run ledger in the user's file; Node's BullMQ jobs re-run after a worker restart) and deliveries are idempotent (fixed transaction id, retried across a gateway restart). |
| Editor / flows                     | JSDOM                                | linkedom DOM shim; the heavy chain is lazy-imported; a second, crypto-less bot device from the gateway (`ctx.matrix.botCredentials()`).                                                                                                                                                                                                                                                                                                              |
| Attachments                        | `src/attachments/` pipeline          | Same pipeline (classify → route by modality → native blocks or the helper model; SSRF blocklist, 25 MB per file / 50 MB per turn). No local PDF/office parser on workerd (those go to the helper model).                                                                                                                                                                                                                                             |
| Realtime channel                   | socket.io server                     | socket.io v4 wire protocol over Hibernatable WebSockets, one socket per tab, addressed by session; heartbeat from the object's alarm so an idle tab lets the object hibernate; websocket transport only (a polling handshake gets a 426). Chat events use Node's wire envelope (`event` → `{ eventName, payload }`); `browser_tool_call` / `action_call` are raw by name.                                                                            |
| Portal browser tools / AG-UI       | portal + agui plugins                | Same contract over the realtime channel (`ctx.frontend.callBrowserTool` / `callAgAction`, 15 s / 10 s timeouts); proven live with the Portal's `create_page_room`.                                                                                                                                                                                                                                                                                   |
| User preferences                   | `user_prefs` room state              | Same envelope; hydrated into `state.userPreferences` before every agent build (5-minute read cache, invalidated by the tool's own write).                                                                                                                                                                                                                                                                                                            |
| Matrix user id on non-Matrix turns | `didToMatrixUserId(did, homeServer)` | Same derivation (homeserver from the DID document via Blocksync, fallback to the oracle's server), cached in object storage (`meta:matrixUserId`).                                                                                                                                                                                                                                                                                                   |
| Session creation                   | marker event id = session id         | Same; the marker send is retried with the same transaction id across a gateway restart (`src/do/gateway-retry.ts`), never replayed blindly. If every attempt fails the create fails — no silent local id when the user has an oracle room.                                                                                                                                                                                                           |
| LLM                                | OpenRouter                           | OpenRouter or Nebius (`LLM_PROVIDER`), optional LangSmith tracing, the full BYO-LLM lane (catalog, per-user keys, ChatGPT OAuth — see the proxy note in [operations](operations.md#chatgpt-subscription-lane-needs-a-proxy)).                                                                                                                                                                                                                        |

## Deliberate divergences

- **Attachment payload retention.** Inline base64 blocks stay in a session's
  messages only for the newest 2 user turns (`ATTACHMENT_PAYLOAD_TURNS`,
  `src/attachments/retention.ts`). Older ones are rewritten in place to a
  text placeholder; the transcript metadata is unchanged and the bytes leave
  the database. The `view_attachment` tool (offered only in sessions with an
  offloaded payload) fetches one again through the same pipeline.
- **Owner copies are never written to Matrix.** The IXO VFS is the system of
  record; Matrix media is read once as legacy — streamed, never held whole,
  where Node buffered the file — and then redacted (see
  [architecture](architecture.md#self-sovereign-storage)). The user's
  delegation to the oracle therefore needs one capability Node never asked
  for: `{ can: '*', with: 'ixo:filesystem/.oracles', nb: { hidden: ['/.oracles'] } }`.
- **Blob compression.** A file written by this runtime is not readable by
  the Node runtime; the reverse direction works.
- **Per-turn step budget.** LangGraph `recursionLimit` is 600 here
  (`TURN_RECURSION_LIMIT`), three times Node's hard-coded 200: a tool-call round
  trip costs about 6 steps with the bundled middlewares, and long research
  turns were dying at the smaller budget.
- **Room turns survive a gateway reset.** Node keeps the inbound message in
  process memory for the length of the turn; here the gateway keeps a durable
  inbox row until the reply is in the outbox and re-dispatches survivors on
  the next start, replies carry an event-derived transaction id, and the user
  object's turn ledger makes a re-dispatch return the stored reply, attach to
  the running turn, or refuse — a turn never runs twice for one event
  ([operations](operations.md#turns-the-inbox)).
- **Best-effort room posts are retried.** The room mirror of HTTP turns, the
  `ixo.action.log` audit event and the `delegation_required` prompt are
  fire-and-forget on Node; here they are retried across a gateway restart,
  each under a fixed transaction id so a post whose response was lost lands
  once (the mirror's derived from session and request and serialised per
  session, the two custom events' minted once per post), the
  prompt's throttle is stamped only after a successful post, and a working
  copy left ahead of its last upload by an interrupted turn is marked dirty
  on boot ([operations](operations.md#best-effort-room-posts)).
- **Interrupted tool calls are answered.** A turn that dies between a
  tool call and its result (the user's abort, an object reset) leaves the
  checkpoint with an assistant message whose `tool_calls` have no
  `ToolMessage`. OpenRouter chat completions tolerate that; the
  ChatGPT-subscription lane (Responses API) rejects every later turn on the
  session with `400 No tool output found for function call …`. The
  `DanglingToolCallRepair` middleware (main agent and sub-agents) answers
  each such call, for the model request only, with a result saying it was
  interrupted; the checkpoint is untouched. Node has no equivalent.
- **Task schedule at the tool boundary.** `preview_task` / `create_task` /
  `update_task` take the schedule as one flat object (`kind` enum plus the
  optional per-kind fields) and convert it to the scheduler's discriminated
  union on parse (`src/tasks/schedule-input.ts`). Node exposes the union
  itself, which LangChain renders as JSON-schema `oneOf` + `const`; Gemini
  models answer that shape with a bare timestamp string, so every task
  creation failed on the default platform model. The store, the spec
  frontmatter and the scheduler are unchanged.
- **Internal model calls stay off the wire.** The summarization
  middleware's model and a sub-agent's inner turn stream through the same
  `streamEvents` pipe as the reply; the SSE stream drops model events
  tagged `lc_source: 'summarization'` or `internal` (and the summarizer's
  model is created with streaming off), so the condensed history never
  appears in a user's reply. Node's `sse-stream-runner` has the same gap.
- **Rejected tool calls are visible.** A call whose arguments fail the
  tool's schema is not retried (a `ToolInvocationError` gives the same
  answer every time), is logged (`[tool-retry] tool call rejected by the
tool schema: …`), and reaches the client as a `tool_call` frame with
  `status: 'error'` and the message, so the Portal renders it as failed
  instead of as a finished call.
- **Turn resume after an isolate reset** is not built: the in-flight turn
  dies with an SSE `error` and the user resends.
- **A user↔oracle room is always direct.** Node classified a room by the
  `is_direct` flag and the joined-member count alone; a user↔oracle room on
  an ixo homeserver also holds the rooms appservice bot and the
  memory-engine bot, so that rule would gate the oracle's own conversation
  with its user. Here a room whose canonical alias is a user↔oracle alias
  of this oracle is direct whatever its member count; the two Node rules
  apply to every other room.
- **Group rooms are gated in the gateway, not in a middleware.** Node
  dispatched every group-room message as a turn and let the plugin's
  `beforeAgent` middleware end it silently; here the gateway decides before
  a turn exists, so an ignored message never wakes the speaker's user
  object (and never fails a turn for a member who has no delegation). Two
  consequences: an ignored message is not appended to the speaker's own
  thread state (Node's per-user checkpoint kept it; cross-user context came
  from channel memory on both runtimes), and the "bot spoke in this thread"
  fallback after a restart reads the gateway's durable `group_bot_threads`
  table instead of scanning the room's last 100 messages. Channel memory is
  the gateway's SQLite (Durable Object storage survives deploys) rather
  than a per-room database uploaded to the room as media, so a Node-era
  `qiforge.channel_memory.v1` snapshot is not imported; the schema is
  Node's, so an importer is a small addition. Compaction runs at the 20-
  message threshold and just in time before an answer (3 s cap), as on
  Node; Node's 5-minute idle compaction has no equivalent — the buffer is
  durable, so a quiet room's messages are compacted at its next engagement.
  Node's weekly/monthly tier rollups were never scheduled on Node either
  and are not ported (the `tier` column stays at 1).

## Not ported

Measured against the Node runtime's `BUNDLED_PLUGINS` (Sep 2026):

- **Slack transport** (retired internally) and the **commerce lane**
  (oracle-payments).
- (Matrix group chats were ported in September 2026 — see
  [Identical](#identical).)

Everything else in the bundled set is here and exercised live against the
deployed devnet worker by the feature matrix described in
[testing](testing.md).
