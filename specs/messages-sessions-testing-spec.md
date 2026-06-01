# Spec — High-Quality Test Coverage for messages + sessions modules

## 0. Context

The `packages/oracle-runtime/src/modules/messages/` and `…/sessions/` modules are
the core of the chat pipeline (SSE streaming, ref-counted active-user tracking,
fire-and-forget background tasks, AbortController lifecycle, Matrix replay,
attachment processing, session history processing). Today only the security-
adjacent modules (auth, secrets, subscription, ucan) have unit tests; the chat
pipeline is covered only indirectly by `test/integration/*.int.test.ts`.

Goal: add high-quality unit + integration tests focused on **bug-prone hotspots**
— write tests that would fail if the bug appeared, not happy-path duplication.

Sequenced into 3 waves so each is independently shippable and reviewable.

## 1. Goals / Non-goals

**Goals**

- Unit-heavy pyramid covering every dangerous branch in messages + sessions.
- Three integration tests proving the wire works end-to-end and survives abort.
- Match existing house style strictly (no deviations).
- Each wave is a separate PR; reviewer signs off before next wave starts.

**Non-goals**

- Coverage of thin transports (`messages.controller.ts`, `sessions.controller.ts`).
  Nest framework guarantees DI wiring; tests would only re-prove framework
  behavior. If a reviewer wants them, one test per branch (stream/non-stream/abort)
  is sufficient.
- Matrix listener bridge integration test (would need a live Synapse + 2nd test
  user). Unit coverage in Wave 3 is the chosen path.
- Refactoring production code to make tests easier. If a test needs a
  production-side change, stop and ask before changing source.

## 2. House Style + Memory Rules (binding)

### Test runner & config

- **Vitest**, ESM, native Node.
- Unit mode (default `vitest run`): excludes `*.int.test.ts`, 30s default timeout.
- Integration mode (`vitest run --mode int`): only `*.int.test.ts`, `fileParallelism: false`, 120s timeout, 60s hook timeout.
- Unit setup: `packages/oracle-runtime/test-setup.ts` (already loads `.env` placeholders).
- Integration setup: `src/testing/integration/setup.ts` (loads `.env.integration`, silences logs, adds `langchainMatchers`).

### SUT construction

- Direct `new Service(mockA, mockB, …)` — **never** `Test.createTestingModule(...)`.
- Templates to copy:
  - `src/modules/auth/auth-header.middleware.test.ts`
  - `src/modules/secrets/secrets.service.test.ts`
  - `src/modules/subscription/subscription.middleware.test.ts`
  - `src/modules/ucan/ucan.service.test.ts`

### Mocking

- Mock at the **external boundary only**. Mock `@ixo/matrix`, `@ixo/common` (selective via `importOriginal`), `@ixo/sqlite-saver`, `@ixo/oracles-chain-client` via `vi.mock(...)`.
- **Never** mock internal helpers — instantiate them.
- Inline factories per test file: `makeCache()`, `makeConfig()`, `makeReq()`.
- Shared factories in `src/modules/messages/__test-fixtures__/*` only when used in 3+ files.
- `beforeEach(() => vi.resetAllMocks())` to isolate.

### Naming

- `describe('ClassName')` → nested `describe('methodName + scenario group')` → `it('imperative outcome description')`.
- Examples: `it('clears the heartbeat interval in finally even when streamEvents throws', …)`.

### Memory rules (BINDING — re-read before each task)

1. **No `as any` / type assertions ever** — find the real type mismatch.
   - For test doubles where structural typing matters (e.g., `FakeResponse`),
     `implements Pick<Response, 'set' | 'flushHeaders' | …>` instead of casting.
2. **Integration tests throw on missing env** — top-level `throw new Error(...)`
   at file load, no `describe.skipIf`, no skip flags.
3. **Never loosen assertions to mask failures.** Litmus test: would the new
   assertion still fail when the bug it was meant to catch is present?
4. **Don't edit production code to make a test pass.** 2 test-side tweaks max,
   then stop and ask.
5. **Share one Tier B session across integration tests** — one `chatClient` in
   `beforeAll`, reused for every test in the describe. Only mint per-test
   sessions when the test is explicitly about session isolation.
6. **No wrappers around vitest/dotenv** — use them directly.
7. **No skip-real-services flags in integration tests.**
8. **Self-check while coding** — every task does a redundancy / dead-code sweep
   before reporting done. Quantity of tests ≠ quality.
9. **No task/spec metadata in source comments.** No `TASK-XX`, `§N.Y` etc. in
   `.ts` files — only in this spec / PR descriptions.
10. **Sub-agent must ask, not guess** — when stuck or task is unclear, stop and
    request clarification rather than blindly retrying.

## 3. Source Map (everything a subagent needs to know per file)

### messages module — `packages/oracle-runtime/src/modules/messages/`

#### `messages.service.ts` (orchestrator)

Owns AbortController registry, fire-and-forget Matrix replay, orchestrates
RequestPreparer → (SseStreamRunner | BatchInvoker) → PostMessageSyncer.

- **Public:** `sendMessage(req)`, `listMessages(params)`, `abortRequest(sessionId)`, `onModuleInit()`.
- **Deps:** `RequestPreparer`, `SseStreamRunner`, `BatchInvoker`, `FileProcessingService`, `UserMatrixSqliteSyncService`, `PostMessageSyncer`, `MatrixListenerBridge`, `SessionManagerService`, `ConfigService`.
- **Hotspots:**
  - `markUserActive`/`markUserInactive` ref-count balance across 3 sites (`listMessages`, `sendMessage`, `firePostSync`) + finally blocks.
  - AbortController per-session collision + cleanup on `abortRequest`.
  - Matrix replay fire-and-forget `.catch(logger.error)` — errors never surface to client.
  - `firePostSync` increments active count; `PostMessageSyncer.run()` owns the matching decrement (cross-component contract).
  - `onModuleInit` registers Matrix bridge deliverHandler that re-enters `sendMessage` with `clientType: 'matrix'`, `msgFromMatrixRoom: true`.

#### `messages.controller.ts` (thin transport — SKIP unit tests, covered by integration)

- Stream branch does not return body; non-stream branch returns JSON.
- Auth context extracted from `req.authData.{did, ucanDelegation}`.

#### `agent-builder.ts` (lazy agent factory)

- **Public:** `build(args, abortController?)` → `BuiltAgent`.
- **Deps:** `OracleRuntimeBundleHolder`, `UserContextFetcher`, `Cache`.
- **Hotspots:**
  - `userContext` + `userPreferences` fetch errors caught silently (falls back to checkpoint).
  - `langGraphConfig.version = 'v2'` REQUIRED for `streamEvents` — v1 default hangs the client.
  - On first-ever thread, prior tuple is `null` (caught, continues empty) — idempotent.
  - UCAN delegation capabilities mapped `{can, with}` → `{action, resource}`.
  - Missing payload `ucanDelegation` → `{raw: ''}` (Matrix bot path).
  - Payload `metadata.editorRoomId` wins over `priorState.editorRoomId`.

#### `batch-invoker.ts` (single invoke, non-stream)

- **Public:** `invoke(input)` → `BatchInvokeResult { message, sessionId, transcript? }`.
- **Deps:** `AgentBuilder` only.
- **Hotspots:**
  - Config stripping: must drop `streamMode` + `version` before `agent.invoke`, preserve `recursionLimit` + `configurable` + `context` + `signal`.
  - Throws `BadRequestException` when `result.messages` empty.
  - `payload.returnAllMessages = true` returns transcript.

#### `sse-stream-runner.ts` (SSE orchestrator — HIGHEST RISK)

- **Public:** `run({ payload, prepared, inputMessages, res, abortControllers, onComplete })`.
- **Deps:** `AgentBuilder`.
- **Hotspots (every `res.write` is a landmine):**
  - All writes guarded by `res.writableEnded`.
  - Heartbeat (15s `setInterval`) MUST be `clearInterval`ed in `finally`.
  - AbortController per-session collision: aborts existing controller first, then registers new one. `finally` deletes from map.
  - `res.on('close')` listener cleanup in `finally` (memory leak risk).
  - Tool start/end pairing keyed by `run_id`; orphans stay in map forever (no timeout cleanup — DOCUMENT, don't add cleanup unless asked).
  - SSE event headers set inside runner (NOT in controller) so `X-Request-Id` is included in headers + `Access-Control-Expose-Headers`.
  - `on_chat_model_stream` chunks: `content` → message events (accumulate text), `reasoning_details` → ReasoningEvent.
  - Terminal sequence on clean finish: ReasoningEvent(complete=true) → `done`.
  - Abort: emits `done` only (no `error`).
  - Non-abort error: emits `error` then `done`.
  - `onComplete(assistantText)` called only on clean finish (NOT on abort/error).

#### `sse.utils.ts` (pure helpers)

- **Public:** `formatSSE`, `setSSEHeaders`, `startSSEHeartbeat`, `sendSSEDone`, `sendSSEError`, `runWithSSEContext`, `emitSSEEvent`, `getSSEContext`, `getSSEabortController`, `isSSEAborted`.
- **Hotspots:**
  - `formatSSE`: emits `event: <name>\ndata: <json>\n\n`.
  - `setSSEHeaders`: includes `X-Request-Id` + `Access-Control-Expose-Headers` when `requestId` given.
  - Heartbeat is `': heartbeat\n\n'` every 15s.
  - All `send*` helpers no-op when `res.writableEnded`.
  - `runWithSSEContext` binds res + abortController via AsyncLocalStorage. `emitSSEEvent` no-ops when called outside context.

#### `request-preparer.ts` (pre-build validation + resolution)

- **Public:** `prepare(payload)` → `PreparedRequest { sessionId, langchainThreadId, roomId, targetSession, runnableConfig, … }`, `validateSessionId(sessionId, did)`.
- **Deps:** `SessionManagerService`, `UserMatrixSqliteSyncService`, `HomeServerCache`, `ConfigService`.
- **Hotspots:**
  - `validateSessionId` throws `BadRequestException` when sessionId or did missing.
  - HomeServer resolved from `payload.homeServer` first, else `HomeServerCache.get(did)`.
  - `sessionManager.getSession` returning null → `NotFoundException`.
  - RoomId from `targetSession.roomId` first, else `matrixManger.getOracleRoomIdWithHomeServer` fallback. Both null → `NotFoundException`.
  - `overrideLangchainThreadId` overrides default thread_id.
  - Timezone resolved from `payload.timezone` first, then `x-timezone` header; invalid tz → UTC fallback (silent).
  - Fresh `requestId` generated when `stream=false`.

#### `file-processing.service.ts` (multi-stage attachment handler — SECURITY + COST surface)

- **Public:** `processAttachments(attachments, roomId, userDid)` → `{ texts, metadata, totalUsage }`, `downloadAndProcessFile(source, hints)`, `processFileFromUrl(url, hints)`, `processFileFromEventId(roomId, eventId, hints)`.
- **Deps:** `ConfigService`, `UcanService`, `FileProcessingCreditSink` (optional).
- **Provider:** module-level `setFileProcessingProvider(fn)` — set in `beforeAll` of unit tests, reset in `afterAll`. Production wires this in `create-oracle-app.ts:307`.
- **Constants:** `MAX_FILE_SIZE = 25MB`, `MAX_TOTAL_SIZE = 50MB`, `MATRIX_DOWNLOAD_TIMEOUT_MS = ?`, `MAX_REDIRECT_COUNT = ?` (subagent reads constants from source).
- **Hotspots:**
  - Sequential processing enforces total budget — `Promise.all` would blow it by N×.
  - SSRF: blocks `127.0.0.1`, `169.254.169.254`, `::1`, `metadata.google.internal`, non-http(s) schemes; redirect chain re-validates each hop; rejects after `MAX_REDIRECT_COUNT`.
  - Per-attachment errors caught → emit error-text placeholder, no throw.
  - Credit deduction (`creditSink.deductForFileProcessing`) called only when `aiCallsMade > 0`; errors swallowed (warn only); skipped when `userDid` undefined.
  - Sandbox upload soft-fails (after AI tokens already spent) — primary text still returned.
  - `analysis.md` upload soft-fails without dropping primary text.
  - `sanitizeSandboxPath` strips `..` segments + bad chars.
  - `verifyMagicBytes` throws on claimed-image-but-PDF-bytes mismatch; skips for plain-text mimetypes; warn-only on unrecognized bytes.
  - Download abort on timeout, on size overflow mid-stream, on `content-length` over limit.

#### `post-message-syncer.ts` (fire-and-forget, ref-counted)

- **Public:** `run(input)` returns `void`, schedules microtask.
- **Deps:** `UserMatrixSqliteSyncService`, `SessionManagerService`, `ConfigService`.
- **Hotspots:**
  - All errors silently swallowed (no caller knows).
  - `markUserInactive` ALWAYS called in `finally` (matches `firePostSync`'s increment in `MessagesService`).
  - Reads from `getUserDatabaseNoSync` (cached connection — NOT `getUserDatabase`).
  - `targetSession.lastProcessedCount ?? 0` coalesce on missing.
  - Race window between checkpoint write and this read (extremely unlikely with same-session sequential turns).

#### `matrix-listener-bridge.ts` (Matrix → chat bridge)

- **Public:** `setDeliverHandler(callback)`, `onModuleInit`, `onModuleDestroy`.
- **Deps:** `SessionManagerService`, `ConfigService`, `MatrixManager` (from `sessions.matrixManger`).
- **Hotspots:**
  - Filter: ignores `sender == ORACLE_DID`, ignores 'INTERNAL' in content, ignores msgtypes outside `m.text` + file types.
  - Thread root resolution: walks `m.in_reply_to` chain to root; cache + visited set prevents infinite loop on cycle.
  - Debounce 500ms per thread; resets on new event; flush merges text + attachments into one `MatrixIncomingMessage`; flush builds `'User shared a file'` synthetic message when text absent.
  - `deliverHandler` missing → warn + drop.
  - Session bootstrap on first message (`createSession` when `getSession` returns undefined).
  - `normalizeDid` throws on malformed `@did-<ns>-<id>:server`.
  - `onModuleDestroy` clears all pending timers + unsubscribes.

#### `user-context-fetcher.ts` (cached Memory Engine fetch, best-effort)

- **Public:** `fetch(params)` → `UserContextRecord | undefined`.
- **Deps:** `Cache`, `MemoryEngineService` (optional), `UcanService`, `ConfigService`.
- **Hotspots:**
  - Returns `undefined` when `memoryEngine` null (MEMORY_ENGINE_URL unset).
  - Returns `undefined` when `ucanService.hasSigningKey() === false`.
  - Cache key: `sessionId` (NOT `roomId` — regression check).
  - `createServiceInvocation` throw → undefined (no rethrow).
  - `gatherUserContext` throw → undefined; result NOT cached.
  - No timeout (can hang 30s+).

#### `homeserver-cache.ts` (TTL cache)

- **Public:** `get(userDid)` → `string`.
- **Deps:** none (calls `getMatrixHomeServerCroppedForDid` from `@ixo/oracles-chain-client`).
- **Hotspots:**
  - 1h TTL.
  - Concurrent `get()` on same DID can double-fetch (no locking). DOCUMENT as known behavior.

#### `oracle-runtime-bundle.ts` (registry holder, single-shot)

- **Public:** `populate(bundle)` (one-time), `get()` → `OracleRuntimeBundle`, `isReady()`.
- **Hotspots:** `get()` throws if `populate` never called; `populate` guards double-call.

### sessions module — `packages/oracle-runtime/src/modules/sessions/`

#### `sessions.service.ts`

- **Public:** `createSession(data)`, `listSessions(data)`, `deleteSession(data)`, `processPreviousSessionHistory(data)` (private-ish).
- **Deps:** `SessionManagerService`, `ConfigService`, `SessionHistoryProcessor`, `UserMatrixSqliteSyncService`, `UcanService` (optional).
- **Hotspots:**
  - Dual ref-count pairs in `createSession` + `deleteSession` (entry + before-background-task).
  - Assumes `sessions[0]` is most recent — invariant to assert.
  - HomeServer resolution failure fails entire `listSessions` (no graceful fallback).
  - Task-room filtering: `listSessions` only returns sessions matching `mainRoomId` (passed as `roomId` to `sessionManager.listSessions`).
  - Errors wrapped in `BadRequestException` with original message.

#### `sessions.controller.ts` (thin transport — SKIP unit tests)

#### `session-history-processor.service.ts`

- **Public:** `processSessionHistory(params)` → void.
- **Deps:** `MessagesService`, `MemoryEngineService`, `SessionManagerService`, `ConfigService`, `Cache` (CACHE_MANAGER), `UcanService` (optional).
- **Hotspots:**
  - Cache lock with 5min TTL; cleared in `finally` so failed processing doesn't block retry indefinitely.
  - Retry: 3 attempts, 10s delay between.
  - Early return when lock already held (no double processing).
  - Internal flow: getSession → resolve room → list messages → skip by `lastProcessedCount` → transform → mint UCAN invocation → send to memory engine → update `lastProcessedCount`.
  - Transform: `human → user`, `ai → assistant`, `tool → assistant`, `system → system`; `name` field becomes graphiti entity.
  - Display name cascade: `prefs.userName` → Matrix `getDisplayName` → `'Me'`.
  - UCAN missing (`hasSigningKey()===false`) → silent skip (no error).
  - Slice boundary: `lastProcessedCount` to end — test with boundary values 0, mid, equal-to-length.

### Related — `UserMatrixSqliteSyncService`

Path: `packages/oracle-runtime/src/matrix/checkpointer/user-matrix-sqlite-sync-service.service.ts`

- `markUserActive(did)`: `count = (map.get(did) ?? 0) + 1; map.set(did, count)`.
- `markUserInactive(did)`: `count <= 1` deletes the key; else decrements.
- `isUserActive(did)`: **private** today. `activeUsers` map is **private**.

**Decision needed**: for the session-lifecycle integration test to assert
ref-count balance, we'd need a public read accessor. Decision in this spec:
**don't expose it** for Wave 1; rely on unit-test `vi.fn().mock.calls`. If the
user later wants integration-level introspection, add
`public getActiveCount(did: string): number` as a tiny production-side change.

### Integration testing harness — `packages/oracle-runtime/src/testing/integration/`

- `createIntegrationOracle()` — full Nest boot.
- `createIntegrationRuntime()` — runtime-only (no HTTP).
- `ChatClient` (`chat-client.ts`) — wraps HTTP; `.send(sessionId, msg)` (non-stream), `.stream(sessionId, msg)` (async iterator of typed SSE events), `.abort(sessionId)`.
- `mintUserDelegation()` — real UCAN delegation creation.
- `waitForMatrixLoaded()` — waits for Matrix client ready.
- `sse-parser.ts` — typed SSE event parsing.

Existing reference tests: `test/integration/runtime-boot.int.test.ts`,
`hello-world.int.test.ts`, `meta-tools.int.test.ts`, `error-paths.int.test.ts`.

## 4. Shared Fixtures to Create

**Location:** `packages/oracle-runtime/src/modules/messages/__test-fixtures__/`

(Only create if used in 3+ test files — confirmed below.)

### `fake-response.ts`

A structurally-typed Express `Response` double. Used by: sse-stream-runner, messages.service, sse.utils tests.

Shape (TypeScript, no `as any`):

```ts
import { EventEmitter } from 'node:events';
import type { Response } from 'express';

type ResponseSurface = Pick<
  Response,
  | 'set'
  | 'flushHeaders'
  | 'write'
  | 'end'
  | 'on'
  | 'off'
  | 'headersSent'
  | 'writableEnded'
  | 'status'
  | 'json'
>;

export class FakeResponse extends EventEmitter implements ResponseSurface {
  writes: string[] = [];
  headersSent = false;
  writableEnded = false;
  setHeaders: Record<string, string> = {};
  statusCode = 200;
  jsonBody: unknown;
  set(field: Record<string, string>): this {
    this.setHeaders = { ...this.setHeaders, ...field };
    return this;
  }
  flushHeaders(): void {
    this.headersSent = true;
  }
  write(chunk: string | Buffer): boolean {
    if (this.writableEnded) return false;
    this.writes.push(String(chunk));
    return true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(body: unknown): this {
    this.jsonBody = body;
    this.writableEnded = true;
    return this;
  }
}
```

Note: `EventEmitter.on/off` already match `Response.on/off`'s signatures structurally for our usage. The fixture must NOT use `as any`; if a structural mismatch shows up, narrow the `ResponseSurface` type instead.

### `fake-agent.ts`

Drives `streamEvents` from a fixed event list. Used by: sse-stream-runner, messages.service, batch-invoker (via stateInput shape).

```ts
import type { StreamEvent } from '@langchain/core/tracers/log_stream';

export function makeFakeAgent(events: StreamEvent[]) {
  return {
    streamEvents(_input: unknown, _cfg: unknown): AsyncIterable<StreamEvent> {
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    async invoke(_input: unknown, _cfg: unknown) {
      return { messages: [] };
    },
  };
}
```

For abort-mid-stream tests, expose a generator that yields with `await new Promise(r => setTimeout(r, 0))` between events so the test can call `abortController.abort()` and observe the loop break at the next iteration.

### `deps.ts`

Dependency factories for `MessagesService`, `SseStreamRunner`, `PostMessageSyncer`. Used by: 3+ files.

```ts
import { vi } from 'vitest';

export function makeCheckpointSync() {
  return {
    markUserActive: vi.fn(),
    markUserInactive: vi.fn(),
    getUserDatabase: vi.fn(),
    getUserDatabaseNoSync: vi.fn(),
  };
}

export function makeSessionManagerStub() {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    getSession: vi.fn(),
    updateLastProcessedCount: vi.fn(),
    syncSessionSet: vi.fn(),
    matrixManger: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getOracleRoomIdWithHomeServer: vi.fn(),
      getDisplayName: vi.fn(),
      getEventById: vi.fn(),
      onMessage: vi.fn(() => () => undefined),
      init: vi.fn().mockResolvedValue(undefined),
    },
  };
}

export function makePrepared(overrides = {}) {
  return {
    sessionId: 'sess-1',
    langchainThreadId: 'sess-1',
    roomId: '!room:home',
    targetSession: {
      sessionId: 'sess-1',
      lastProcessedCount: 0,
      roomId: '!room:home',
    },
    runnableConfig: { configurable: { thread_id: 'sess-1' } },
    requestId: 'req-1',
    homeServer: 'home.server',
    timezone: 'UTC',
    currentTime: '2026-05-21T00:00:00Z',
    ...overrides,
  };
}
```

**Do NOT extract** per-call `vi.fn().mockResolvedValue(x)` — inline is clearer.

## 5. Per-File Test Cases (every test, by wave)

### WAVE 1 (highest ROI — ship first)

#### `src/modules/messages/sse-stream-runner.test.ts`

```
describe('SseStreamRunner')
  describe('headers + lifecycle')
    - sets SSE headers via setSSEHeaders + flushHeaders when !headersSent
    - skips setSSEHeaders when controller already sent headers
    - starts the 15s heartbeat
    - clears heartbeat in finally on clean finish
    - clears heartbeat in finally on throw
    - calls res.end() in finally when !writableEnded
    - does NOT call res.end() when writableEnded=true (idempotency)
    - removes the 'close' listener in finally
  describe('AbortController registry')
    - registers controller under sessionId in abortControllers map
    - aborts any existing controller for same sessionId before registering
    - deletes controller from map in finally
    - res 'close' event aborts the controller
  describe('event loop translation')
    - emits initial thinking ReasoningEvent before streamEvents iterates
    - on_tool_start (non-action) emits ToolCallEvent isRunning keyed by run_id
    - on_tool_start matching agActions name emits ActionCallEvent isRunning
    - on_tool_end same run_id emits matching ToolCallEvent done
    - on_tool_end for action with success:false sets status=error + error message
    - on_tool_end for unknown run_id silently ignored (orphan tolerance)
    - on_chat_model_stream content chunks emit message events + accumulate text
    - on_chat_model_stream reasoning_details emits ReasoningEvent (chunk)
    - terminal ReasoningEvent(complete=true) + done emitted on clean finish
    - calls onComplete with assembled assistantText on clean finish
    - skips onComplete + completion event when controller aborted mid-stream
  describe('writableEnded guards')
    - skips res.write once writableEnded becomes true mid-stream
    - skips res.write when abortController already aborted
  describe('error handling')
    - AbortError caught -> emits done only (no error)
    - non-abort error caught -> emits error then done
    - error AFTER res.writableEnded -> emits nothing (no double-end)
```

**Mocks:**

- `agentBuilder`: `{ build: vi.fn().mockResolvedValue({ agent: makeFakeAgent(events), stateInput: {}, langGraphConfig: { version: 'v2' } }) }`.
- Real `sse.utils.ts` — instantiate, don't mock.
- `FakeResponse` from fixtures.
- `vi.useFakeTimers()` for heartbeat tests; `vi.advanceTimersByTime(15000)` to trigger.

#### `src/modules/messages/messages.service.test.ts`

```
describe('MessagesService')
  describe('listMessages')
    - validates sessionId via preparer.validateSessionId
    - calls markUserActive once + markUserInactive in finally (success path)
    - calls markUserInactive in finally when SqliteSaver throws
    - reads tuple via SqliteSaver.fromDatabase and returns transformed messages
    - returns empty messages list when checkpoint has no channel_values.messages
  describe('sendMessage (streaming branch)')
    - delegates to SseStreamRunner.run when stream=true && res present
    - increments active count once on entry; matching decrement in finally
    - skips Matrix user-text replay when msgFromMatrixRoom=true
    - fires Matrix user-text replay when msgFromMatrixRoom=false (not awaited)
    - logs but does NOT throw when Matrix user-replay rejects
    - onComplete callback fires AI replay to Matrix when !msgFromMatrixRoom
    - onComplete fires firePostSync which calls markUserActive (handoff to PostMessageSyncer)
    - onComplete skips AI replay when assistantText is empty
  describe('sendMessage (non-stream branch)')
    - invokes BatchInvoker.invoke when stream=false
    - fires AI Matrix replay with result.message.content when !msgFromMatrixRoom
    - fires firePostSync after batch reply
    - returns BatchInvokeResult
  describe('sendMessage (attachments)')
    - calls fileProcessing.processAttachments when attachments present
    - assembles AIMessage per attachment with eventId or mxcUri source ref
  describe('abortRequest')
    - returns false when no controller registered for sessionId
    - calls controller.abort() and removes from map when present, returns true
  describe('onModuleInit')
    - registers a deliverHandler on matrixBridge
    - registered handler invokes sendMessage with clientType=matrix, msgFromMatrixRoom=true
```

**Mocks:**

- All deps via `vi.fn()` factories (see `deps.ts`).
- `vi.mock('@ixo/sqlite-saver', () => ({ SqliteSaver: { fromDatabase: vi.fn(() => ({ getTuple: vi.fn() })) } }))`.
- `vi.mock('@ixo/common', async (importOriginal) => ({ ...await importOriginal<typeof import('@ixo/common')>(), transformGraphStateMessageToListMessageResponse: vi.fn((msgs) => msgs) }))`.

#### `src/modules/sessions/sessions.service.test.ts`

```
describe('SessionsService')
  describe('createSession')
    - markUserActive called twice (entry + before background task)
    - markUserInactive called twice in finally chains
    - background processPreviousSessionHistory invoked (not awaited)
    - returns CreateChatSessionResponseDto from sessionManager
    - wraps thrown errors in BadRequestException preserving original message
  describe('listSessions')
    - resolves homeServer via getMatrixHomeServerCroppedForDid when payload omits it
    - uses data.homeServer when provided (no chain lookup)
    - filters by mainRoomId resolved from matrixManger.getOracleRoomIdWithHomeServer
    - wraps thrown errors in BadRequestException
    - markUserInactive called in finally on both success and error
  describe('deleteSession')
    - markUserActive called twice (entry + before background)
    - markUserInactive called twice (matching) in finally
    - background processSessionHistory fired for the deleted sessionId
    - sessionManager.deleteSession awaited
    - returns success message
  describe('processPreviousSessionHistory (via createSession)')
    - picks sessions[0] (most recent) for background processing
    - no-op when sessions list is empty
    - markUserActive/Inactive paired around the fire-and-forget
```

**Mocks:**

- `sessionManager`: `makeSessionManagerStub()`.
- `configService`: `makeConfig({ ORACLE_ENTITY_DID, ORACLE_NAME, ORACLE_DID })`.
- `syncService`: `makeCheckpointSync()`.
- `sessionHistoryProcessor`: `{ processSessionHistory: vi.fn().mockResolvedValue(undefined) }`.
- `vi.mock('@ixo/oracles-chain-client', () => ({ getMatrixHomeServerCroppedForDid: vi.fn() }))`.

#### `src/modules/messages/file-processing.service.test.ts`

```
describe('FileProcessingService')
  describe('processAttachments — size enforcement')
    - rejects when reportedTotal > MAX_TOTAL_SIZE before any download
    - rejects mid-batch when cumulative downloaded > MAX_TOTAL_SIZE
    - processes attachments sequentially (asserts call ORDER, not Promise.all)
    - per-attachment errors caught + emit error-text placeholder (no throw)
  describe('processAttachments — SSRF')
    - rejects 127.0.0.1
    - rejects 169.254.169.254
    - rejects ::1
    - rejects metadata.google.internal
    - rejects non-http/https schemes
    - redirect loop re-validates each hop's host
    - rejects after MAX_REDIRECT_COUNT redirects
  describe('processAttachments — credit deduction')
    - calls creditSink.deductForFileProcessing only when aiCallsMade > 0
    - swallows creditSink errors (warn, returns successfully)
    - skips credit deduction when userDid undefined
  describe('processAttachments — sandbox upload')
    - returns undefined sandboxConfig when SANDBOX_MCP_URL unset
    - returns undefined when UCAN invocation null
    - text is returned even if sandbox upload fails after AI spend
    - analysis.md upload soft-fails without dropping primary text
    - sanitizeSandboxPath strips '..' segments and bad chars
  describe('verifyMagicBytes')
    - throws on claimed image but PDF magic bytes
    - skips check for plain-text mimetypes
    - tolerates unrecognized magic bytes (warn, no throw)
  describe('downloadFromUrl')
    - aborts on MATRIX_DOWNLOAD_TIMEOUT_MS
    - aborts when reader exceeds MAX_FILE_SIZE mid-stream
    - rejects when content-length header exceeds MAX_FILE_SIZE
```

**Mocks:**

- `vi.mock('@ixo/matrix', () => ({ MatrixManager: { getInstance: vi.fn(...) } }))` — mock `downloadContent`, `getEvent`, `crypto.decryptMedia`.
- `vi.mock('@ixo/common', () => ({ loadFileFromBuffer: vi.fn() }))`.
- `vi.spyOn(globalThis, 'fetch')` for AI/sandbox/URL downloads.
- `ucanService`: `{ createServiceInvocation: vi.fn() }`.
- `creditSink`: `{ deductForFileProcessing: vi.fn() }`.
- `beforeAll(() => setFileProcessingProvider(() => ({ apiKey: 'test', baseURL: 'https://x', headers: {}, model: 'test' })))`; `afterAll` resets.

#### Shared fixtures (this wave)

Create `src/modules/messages/__test-fixtures__/{fake-response.ts, fake-agent.ts, deps.ts}` as specified in §4.

#### `test/integration/sse-happy-path.int.test.ts`

```
describe('SSE happy path (integration)')
  beforeAll:
    - assert required env or throw at file load (TEST_USER_MNEMONIC, ORACLE_DID, ORACLE_ENTITY_DID, MATRIX_BASE_URL, OPENROUTER_API_KEY)
    - createIntegrationOracle() once
    - mintUserDelegation(); cacheDelegation
    - new ChatClient(...) once
    - create one session in beforeAll; reuse for all tests in this file
  tests:
    - response carries x-request-id header
    - stream yields exactly one terminal `done` event
    - final assistantText is non-empty
    - no `error` events emitted on happy path
```

**Why this test:** catches `version='v2'` regressions (stream hangs without it), `X-Request-Id` header wiring, heartbeat blocking events, AgentBuilder↔SseStreamRunner contract drift.

### WAVE 2

#### `src/modules/messages/sse.utils.test.ts`

```
describe('formatSSE')
  - emits "event: <name>\ndata: <json>\n\n"
describe('setSSEHeaders')
  - includes X-Request-Id + Access-Control-Expose-Headers when requestId given
  - omits X-Request-Id when requestId absent
describe('heartbeat')
  - startSSEHeartbeat sends ': heartbeat\n\n' every 15s (vi.useFakeTimers)
  - sendSSEHeartbeat is a no-op when res.writableEnded
  - clearInterval(returned) stops further writes
describe('sendSSEDone / sendSSEError')
  - both no-op when writableEnded
  - sendSSEError serializes Error.message vs string verbatim
describe('AsyncLocalStorage context')
  - runWithSSEContext binds res + abortController for the callback duration
  - getSSEContext returns the bound res, undefined outside the callback
  - emitSSEEvent writes through bound res; no-op when no context
  - isSSEAborted reflects abortController.signal.aborted
```

#### `src/modules/messages/request-preparer.test.ts`

```
describe('RequestPreparer')
  describe('validateSessionId')
    - throws BadRequestException when sessionId missing
    - throws BadRequestException when did missing
  describe('prepare')
    - resolves homeServer from cache when payload.homeServer absent
    - skips cache when payload.homeServer provided
    - throws NotFoundException when sessionManager.getSession returns null
    - resolves roomId from session when targetSession.roomId present
    - falls through to matrixManger.getOracleRoomIdWithHomeServer on missing
    - throws NotFoundException when matrix fallback returns no roomId
    - reuses sessionId as langchain thread_id by default
    - honors overrideLangchainThreadId for runnableConfig.thread_id
    - resolves timezone from payload.timezone first, then x-timezone header
    - formatTimeInTimezone falls back to UTC when zone invalid
    - generates a fresh requestId when stream=false
```

#### `src/modules/messages/post-message-syncer.test.ts`

```
describe('PostMessageSyncer.run')
  - run() returns synchronously (void) and schedules a microtask
  - markUserInactive ALWAYS called in finally (success path)
  - markUserInactive called when getUserDatabaseNoSync throws
  - markUserInactive called when sessions.syncSessionSet throws
  - calls sessions.syncSessionSet with messages mapped from transformed list
  - reads from cached connection via getUserDatabaseNoSync (NOT getUserDatabase)
  - uses targetSession.lastProcessedCount ?? 0
```

Use `await vi.waitFor(() => expect(checkpointSync.markUserInactive).toHaveBeenCalled())` to drain the microtask before assertions.

#### `src/modules/messages/agent-builder.test.ts`

```
describe('AgentBuilder.build')
  - throws when bundleHolder.get() throws (populate never ran)
  - reads priorState via checkpointer.getTuple when hooks.checkpointerForUser present
  - swallows getTuple errors (fresh thread) and continues with empty priorState
  - skips checkpointer fetch entirely when hooks.checkpointerForUser absent
  - userContextFetcher rejection -> falls back to priorState.userContext (no throw)
  - userPreferences rejection -> falls back to priorState.userPreferences
  - payload.metadata.editorRoomId wins over priorState.editorRoomId
  - ucanDelegation.capabilities mapped from {can,with} to {action,resource}
  - missing payload.ucanDelegation -> {raw:''} (Matrix bot path)
  - langGraphConfig has version='v2' and signal when abortController passed
```

#### `src/modules/messages/batch-invoker.test.ts`

```
describe('BatchInvoker.invoke')
  - strips streamMode + version from langGraphConfig before agent.invoke
  - preserves recursionLimit + configurable + context + signal
  - throws BadRequestException when result.messages empty
  - returns { message, sessionId } from last assistant message
  - includes transcript when payload.returnAllMessages=true
```

#### `src/modules/sessions/session-history-processor.test.ts`

```
describe('SessionHistoryProcessor')
  describe('processSessionHistory (locking)')
    - acquires cache lock on entry, releases in finally on success
    - releases lock in finally on failure (next request can retry)
    - early-return when lock already held (no double processing)
  describe('processSessionHistoryWithRetry')
    - retries 3 times with retryDelay between attempts
    - throws on 3rd failure
  describe('processSessionHistoryInternal')
    - no-op when sessionManager.getSession returns null
    - no-op when matrix.getOracleRoomIdWithHomeServer returns no roomId
    - no-op when messagesResponse.messages empty
    - slices newMessages by lastProcessedCount (boundaries: 0, mid, equal-to-length)
    - no-op when ucanService.hasSigningKey()===false (silent skip)
    - skips when memory invocation throws / null
    - updateLastProcessedCount called with prior + newMessages.length
  describe('resolveUserDisplayName cascade')
    - returns prefs.userName when non-empty
    - falls back to Matrix displayName when prefs.userName blank
    - falls back to 'Me' when Matrix lookup throws or returns blank
```

#### `test/integration/sse-abort.int.test.ts`

```
describe('SSE abort mid-stream (integration)')
  beforeAll:
    - assert env or throw
    - createIntegrationOracle()
    - one ChatClient + one sessionId shared
  tests:
    - start stream; after first message event call chatClient.abort(sessionId)
    - stream iterator terminates within ~500ms
    - last event before termination is `done` (no `error`)
    - second chatClient.abort(sessionId) returns { success: false } (controller gone)
    - subsequent chatClient.stream(sessionId, ...) succeeds (no leaked state)
```

**Why this test:** catches AbortController collision logic, controller registry cleanup, writableEnded race.

### WAVE 3

#### `src/modules/messages/matrix-listener-bridge.test.ts`

```
describe('MatrixListenerBridge')
  describe('filtering')
    - ignores oracle's own messages (sender == ORACLE_DID)
    - ignores events with 'INTERNAL' in content
    - ignores msgtypes outside m.text + file types
  describe('thread root resolution')
    - returns event's own id when no m.in_reply_to
    - walks the reply chain to the root and caches every visited id
    - cycle in reply chain breaks out via visited set
    - getEventById errors propagate (caught at caller)
  describe('debouncing')
    - first event sets a 500ms timer, second within window resets it
    - flush merges text + attachments into one MatrixIncomingMessage
    - flush builds 'User shared a file' synthetic message when text absent
    - flush drops the buffer entry before calling deliverHandler
  describe('deliverHandler missing')
    - flush logs warn and drops the message when setDeliverHandler never called
  describe('ensureSession')
    - createSession called when sessions.getSession returns undefined
    - createSession NOT called when session exists
  describe('normalizeDid')
    - throws on input missing '@did-<ns>-<id>:server' shape
    - parses 'did:ixo:abc' from '@did-ixo-abc:home.server'
  describe('onModuleDestroy')
    - clears every pending buffer timer and unsubscribes the listener
```

Use `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` for debounce tests.

#### `src/modules/messages/user-context-fetcher.test.ts`

```
describe('UserContextFetcher.fetch')
  - returns undefined when memoryEngine null
  - returns undefined when ucanService.hasSigningKey()===false
  - cache hit short-circuits engine call
  - cache miss -> mints invocation -> gatherUserContext -> caches result
  - createServiceInvocation throw -> returns undefined (no rethrow)
  - createServiceInvocation null -> returns undefined
  - gatherUserContext throw -> returns undefined and does NOT cache
  - cache key uses sessionId (NOT roomId — regression check)
```

#### `src/modules/messages/homeserver-cache.test.ts`

```
describe('HomeServerCache')
  - first get() calls getMatrixHomeServerCroppedForDid and caches
  - second call within 1h reuses cache (no second chain call)
  - expired entry re-fetches
  - DOCUMENT current behavior: concurrent gets for same DID may double-fetch
```

#### `src/modules/messages/oracle-runtime-bundle.test.ts`

```
describe('OracleRuntimeBundleHolder')
  - get() throws when populate never called
  - populate twice throws ('single-shot')
  - isReady() reflects populated state
```

#### `test/integration/session-lifecycle.int.test.ts`

```
describe('Session lifecycle (integration)')
  beforeAll:
    - assert env or throw
    - createIntegrationOracle()
    - one ChatClient
  tests:
    - createSession returns CreateChatSessionResponseDto with sessionId + roomId
    - listSessions returns the freshly-created session
    - chatClient.send(sessionId, 'hello') returns 200 + non-empty response
    - listMessages(sessionId) returns the human + AI message pair
    - deleteSession(sessionId) returns success
    - listSessions no longer returns the deleted session
```

**Ref-count assertion option:** per §3 decision, this integration test does NOT
directly inspect `activeUsers`. The unit tests cover ref-count balance with
`vi.fn().mock.calls.length`. If integration-level introspection is later
required, add `public getActiveCount(did: string): number` to
`UserMatrixSqliteSyncService` and assert it returns 0 after each operation
settles.

## 6. Subagent Automation Guidance

This spec is for a fresh session that spawns subagents to execute the waves.
Rules for the orchestrator and subagents:

### Wave coordination (orchestrator)

- **One wave at a time.** Spawn subagents for the wave's files in parallel, then
  STOP after the wave completes for user review. Do NOT auto-chain into the
  next wave.
- Within a wave, group subagents by independent file. E.g., Wave 1 can spawn:
  - Subagent A: `sse-stream-runner.test.ts` + shared fixtures
  - Subagent B: `messages.service.test.ts`
  - Subagent C: `sessions.service.test.ts`
  - Subagent D: `file-processing.service.test.ts`
  - Subagent E: `sse-happy-path.int.test.ts` (gated on fixtures landing)
- After each wave, run `pnpm --filter @ixo/oracle-runtime test` (unit) and report
  failures before asking for the next wave.

### Subagent task template

Each subagent gets:

- Path to this spec
- The exact section to read (e.g., "§5 Wave 1, sse-stream-runner.test.ts")
- The exact source file to test
- The exact fixtures to use
- Memory rules (re-read §2 before writing)
- Stop conditions: "if a test needs you to modify production code, stop and ask
  before making the change. 2 test-side tweaks max per failing assertion."
- Acceptance criteria: all listed tests present, all pass on first `pnpm test`,
  no `as any`, no `vi.mock` of internal helpers, no skipped tests, every test
  case maps to a behavior that would actually fail under the bug it describes.

### Subagent self-check (run before reporting done)

- Grep for `as any` / `as unknown as` / `// @ts-` — must be zero in test files.
- Grep for `it.skip`, `describe.skip`, `xit`, `xdescribe` — must be zero.
- Grep for `expect(.*).toBeDefined()` standalone — must justify or replace with
  specific matcher.
- Re-read each `it(...)` description and ask: "if I delete the behavior this
  describes, does this test fail?" If no, the test is dead weight — delete it.
- No `console.log` left in test files.
- No new comments narrating obvious behavior.

## 7. Verification

### Per-wave

```bash
# Unit
pnpm --filter @ixo/oracle-runtime test

# Integration (Wave 1 +)
pnpm --filter @ixo/oracle-runtime test --mode int

# Format + lint (required pre-commit)
pnpm format
pnpm lint
```

### Coverage targets (informational, not enforced)

- Wave 1: ~70% line / ~80% dangerous-branch coverage on messages + sessions modules.
- Waves 1+2: ~85% line / ~95% dangerous-branch.
- All three waves: ~95% line on everything except thin transports.

### Smoke test after each wave

- Spin up the dev server (`pnpm dev`) and send one chat message via portal/CLI.
  If the message round-trips and SSE renders, the test suite hasn't regressed
  the real path.

## 8. Wave Sequencing (ordered)

| Wave | Files                                                                                                                     | Tests added | Ship gate              |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------- |
| 1    | sse-stream-runner, messages.service, sessions.service, file-processing.service + 3 shared fixtures + sse-happy-path.int   | ~65         | User reviews, CI green |
| 2    | sse.utils, request-preparer, post-message-syncer, agent-builder, batch-invoker, session-history-processor + sse-abort.int | ~55         | User reviews, CI green |
| 3    | matrix-listener-bridge, user-context-fetcher, homeserver-cache, oracle-runtime-bundle + session-lifecycle.int             | ~30         | User reviews, CI green |

Total: ~150 tests across 13 unit files + 3 integration files + 3 shared fixtures.

## 9. Open Questions / Decisions Made

| #   | Question                                                 | Decision                                                                                                                                                       |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope to ship                                            | Spec covers all 3 waves; subagents execute one wave at a time per §6                                                                                           |
| 2   | Which integration tests                                  | SSE happy-path + SSE abort + Session lifecycle (no Matrix bridge integration)                                                                                  |
| 3   | FileProcessing provider                                  | `setFileProcessingProvider` in `beforeAll` (matches production wiring at `create-oracle-app.ts:307`)                                                           |
| 4   | Ref-count introspection in session-lifecycle integration | Skip introspection; rely on unit-test `vi.fn().mock.calls` for ref-count balance. Revisit later if needed (would require `public getActiveCount(did)` getter). |
| 5   | `ChatClient` vs supertest                                | Use existing `ChatClient.stream()` / `.send()` / `.abort()` — already typed and proven by existing integration tests.                                          |
| 6   | Matrix listener integration                              | Skipped — would need live Synapse + 2nd test user. Unit coverage in Wave 3.                                                                                    |

## 10. Critical Files

### Source files under test

- `packages/oracle-runtime/src/modules/messages/sse-stream-runner.ts`
- `packages/oracle-runtime/src/modules/messages/messages.service.ts`
- `packages/oracle-runtime/src/modules/messages/file-processing.service.ts`
- `packages/oracle-runtime/src/modules/messages/sse.utils.ts`
- `packages/oracle-runtime/src/modules/messages/request-preparer.ts`
- `packages/oracle-runtime/src/modules/messages/post-message-syncer.ts`
- `packages/oracle-runtime/src/modules/messages/agent-builder.ts`
- `packages/oracle-runtime/src/modules/messages/batch-invoker.ts`
- `packages/oracle-runtime/src/modules/messages/matrix-listener-bridge.ts`
- `packages/oracle-runtime/src/modules/messages/user-context-fetcher.ts`
- `packages/oracle-runtime/src/modules/messages/homeserver-cache.ts`
- `packages/oracle-runtime/src/modules/messages/oracle-runtime-bundle.ts`
- `packages/oracle-runtime/src/modules/sessions/sessions.service.ts`
- `packages/oracle-runtime/src/modules/sessions/session-history-processor.service.ts`

### Reference / templates

- House-style unit test templates:
  - `packages/oracle-runtime/src/modules/auth/auth-header.middleware.test.ts`
  - `packages/oracle-runtime/src/modules/secrets/secrets.service.test.ts`
  - `packages/oracle-runtime/src/modules/subscription/subscription.middleware.test.ts`
  - `packages/oracle-runtime/src/modules/ucan/ucan.service.test.ts`
- Integration test templates:
  - `packages/oracle-runtime/test/integration/hello-world.int.test.ts`
  - `packages/oracle-runtime/test/integration/runtime-boot.int.test.ts`
  - `packages/oracle-runtime/src/plugins/memory/memory.plugin.int.test.ts` (Tier B pattern)
- Vitest config + setup:
  - `packages/oracle-runtime/vitest.config.ts`
  - `packages/oracle-runtime/test-setup.ts`
  - `packages/oracle-runtime/src/testing/integration/setup.ts`
  - `packages/oracle-runtime/src/testing/integration/index.ts` (exports)
- Integration harness:
  - `packages/oracle-runtime/src/testing/integration/chat-client.ts`
  - `packages/oracle-runtime/src/testing/integration/harness.ts`
  - `packages/oracle-runtime/src/testing/integration/ucan.ts`
  - `packages/oracle-runtime/src/testing/integration/sse-parser.ts`

### Files to create

- `packages/oracle-runtime/src/modules/messages/__test-fixtures__/fake-response.ts`
- `packages/oracle-runtime/src/modules/messages/__test-fixtures__/fake-agent.ts`
- `packages/oracle-runtime/src/modules/messages/__test-fixtures__/deps.ts`
- 13 `*.test.ts` files mirroring source layout (see §5)
- 3 `test/integration/*.int.test.ts` files (see §5)

## 11. Next Action

1. In a fresh session, point the orchestrator at this spec.
2. Ask the orchestrator to execute Wave 1 per §6 (subagent automation guidance).
3. Review Wave 1 PR. On approval, execute Wave 2. Repeat for Wave 3.
