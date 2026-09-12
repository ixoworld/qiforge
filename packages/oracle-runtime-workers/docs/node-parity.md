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
  Fire-and-forget, exactly as Node's `MessagesService`. Room-originated turns
  are answered in the room by the gateway; synthetic `$task-` sessions are
  skipped.
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
- **Interrupted tool calls are answered.** A turn that dies between a
  tool call and its result (the user's abort, an object reset) leaves the
  checkpoint with an assistant message whose `tool_calls` have no
  `ToolMessage`. OpenRouter chat completions tolerate that; the
  ChatGPT-subscription lane (Responses API) rejects every later turn on the
  session with `400 No tool output found for function call …`. The
  `DanglingToolCallRepair` middleware (main agent and sub-agents) answers
  each such call, for the model request only, with a result saying it was
  interrupted; the checkpoint is untouched. Node has no equivalent.
- **Turn resume after an isolate reset** is not built: the in-flight turn
  dies with an SSE `error` and the user resends.

## Not ported

Measured against the Node runtime's `BUNDLED_PLUGINS` (Sep 2026):

- **Slack transport** (retired internally) and the **commerce lane**
  (oracle-payments).
- **Matrix group chats** (`matrix-group-chats`): the gated multi-user room
  lane with its own channel-memory store, summariser and power-level guard
  (~2.3k lines). The gateway ingests user ↔ oracle rooms and dedicated task
  rooms only.

Everything else in the bundled set is here and exercised live against the
deployed devnet worker by the feature matrix described in
[testing](testing.md).
