# @ixo/common

## 1.6.0

### Minor Changes

- [#321](https://github.com/ixoworld/qiforge/pull/321) [`f3e0da2`](https://github.com/ixoworld/qiforge/commit/f3e0da21f2608a837224479c3eb19a8ca7582315) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add Decision provider routing, applicability gating, judgment provenance and Final Decision Subject binding to the shared Decision module, and wire them into the Workers runtime.

  `@ixo/common/ai/decisions` adds `DecisionProviderRegistry` and `DecisionProviderRouter` (deterministic selection: caller `providerId`, exact per-Decision route, configured default, sole provider; an unresolvable multi-provider configuration is refused with `AmbiguousDecisionProviderError` instead of picking by registration order; no fallback or retry). `DecisionRuntime` accepts a router or a single adapter, refuses a request whose `applicability` declares it inapplicable or evidence-incomplete with `DecisionNotApplicableError` before any provider is called, and records `providerId`, `providerSelection`, `applicability` and a `judgment` block (method, optional calibration, `questionSetVersion`) on every evaluation. Adapter `provenance` is validated like the answers. A bare adapter is registered as the default provider `HOST_DECISION_PROVIDER_ID` (`host`), the same id the Workers runtime gives `decisionAdapter`. The Cloudflare-hosted Jev adapters declare `provider-native` / `typesafe-system-one` with no calibration claim when running the default `typesafe/jev` model, plain `provider-native` for any other model, in a fresh object per result. New: `canonicalizeFinalDecisionSubject` (`ixo-json-v1`; single read of the input, cycles and non-plain values rejected), SHA-256 `digestFinalDecisionSubject`, `createDecisionAuthorityReceipt`, `assertFinalDecisionSubjectUnchanged`, `createDecisionExecutionReceipt` (returns `{ receipt, subject }`, where `subject` is the deeply frozen value decoded from the hashed bytes; the side effect must run from it) and `StaleDecisionSubjectError` (asynchronous, on Web Crypto), and the `measureDecisionQuestionIsolation` conformance probe. The new `DecisionEvaluation` fields are optional in the type so existing hand-built evaluations still compile.

  `createOracleWorker` takes `decisionProviders` and `decisionProviderPolicy`. The `DECISION_PROVIDER` provider is registered under that id beside host providers and is the default unless the policy names another. A policy naming an unknown provider, a duplicate id, or `decisionProviders` together with `decisionAdapter` fails the boot; `decisionAdapter` alone is registered as provider `host`. The capability router treats an ambiguous configuration like a missing provider (preloads nothing, warns once) and names the error in its warning.

- [#316](https://github.com/ixoworld/qiforge/pull/316) [`1784717`](https://github.com/ixoworld/qiforge/commit/178471743ffb29423b4acd4b6ee58dc9881ffcc2) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Frontend bridge version 2: browser tools and AG-UI actions are scoped to one invocation, one socket and one result, and a missing answer is reported as an unknown outcome instead of a failure.

  - **Workers runtime.** Each call gets its own invocation id (`<caller id>:<uuid>`) and goes to one authenticated socket of its session, not to every tab: the tab with the latest client event, else the one that connected last. Only that socket's answer settles it: results from another tab, a reconnected tab, another session, or with a different `sessionId` are rejected. Duplicate and late results are rejected against a bounded record of finished calls (1,024 entries, 30 minutes). Pending calls are never evicted; past 256 in flight a new call is refused.
  - **Unknown outcomes.** When the deadline passes, or the executing socket goes, the call resolves with `{ success: false, code: 'FRONTEND_OUTCOME_UNKNOWN', outcome: 'unknown', invocationId, message }` and is never sent again. A call no socket can take fails at once. `mutate_topic` waits 120 s.
  - **Write claims.** An unknown outcome keeps the write claim, so an identical write in the same run is not repeated unverified.
  - **Abort.** The turn's abort signal reaches frontend calls (`FrontendCallParams.signal`): aborted before the call is sent, it is rejected as not sent; after, it resolves unknown at once.
  - **SSE.** An AG-UI action with an unknown outcome ends on the SSE stream as `action_call` `done` (not `error`). The AG-UI invocation frame is no longer copied to the SSE stream, so the stream shows no second card that spins forever.
  - **No socket relay.** The SSE stream's `action_call` frames and one-way `browser_tool_call` / `action_call` emits are no longer relayed to sockets.
  - **Ownership check.** A socket whose session ownership lookup fails is refused.
  - **Tool name collisions.** A request-time tool that shadows another tool of the turn is dropped for that turn with one warning, and duplicate names in `tools[]` / `agActions[]` keep their first descriptor.
  - **Logs.** The `ixo.action.log` room event records identifiers and status only, never arguments or result bodies.
  - **`GET /health`.** It now advertises `frontendTools: { protocolVersion: 2, execution: 'single-socket', timeoutOutcome: 'unknown' }`. See `docs/frontend-bridge.md`.
  - **`@ixo/common`.** The new `@ixo/common/ai/frontend-bridge` export holds the wire contract (`FRONTEND_BRIDGE`, `frontendOutcomeUnknown`, `frontendInvocationId`, `reportsUnknownOutcome`, `summarizeFrontendResult`). `callFrontendTool` uses it for the same behaviour: a unique invocation id, a listener attached before dispatch, results matched on session and invocation, and an unknown outcome on timeout. `callBrowserTool` / `callAgAction` accept `onInvocation`, and the parser tools' action logs drop raw arguments and results.
  - **`@ixo/oracles-client-sdk`.** `useWebSocketEvents` runs `browser_tool_call` / `action_call` only for its current session and connection, and runs AG-UI calls only while their status is `isRunning`. Browser tools registered after the socket connected are now honoured.

- [#328](https://github.com/ixoworld/qiforge/pull/328) [`dc0950a`](https://github.com/ixoworld/qiforge/commit/dc0950a28ba704af22fe3e127584845bba87b07d) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add provider-neutral PortableWorkDefinition and AgentWake contracts. Task adapters in both runtimes now expose reusable definition-only work and stable notify-only wake envelopes without carrying authority, approvals, credentials, or execution state. Portable definitions reject duplicate list entries and reserved authority, credential and execution-state keys in `configurationDefaults` (exported as `PORTABLE_WORK_RESERVED_CONFIGURATION_KEYS`, matching the Topic Protocol schema), and the Workers adapters validate their output with the schemas before returning it.

### Patch Changes

- [#339](https://github.com/ixoworld/qiforge/pull/339) [`77012a8`](https://github.com/ixoworld/qiforge/commit/77012a8ef4ba6f2c5b7403635a1e6d232510cc69) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - Decision timeouts and Workers AI cancellation.

  - **Workers AI cancellation.** `WorkersAiJevDecisionAdapter` hands the evaluation's `AbortSignal` to the Workers AI binding (`ai.run(model, inputs, { signal })`), so a decision that times out or is cancelled stops its inference instead of only releasing the caller. Without a signal the binding is called with two arguments, as before.
  - **Timeout validation.** `defineDecision` throws a `RangeError` when `timeoutMs` is not an integer from 1 to 2^31−1. `DecisionRuntime.evaluate` and `evaluateByName` reject with a `RangeError`, without calling the adapter, when the per-call `timeoutMs` or a hand-written registration's `timeoutMs` is outside that range. Visible to callers: a decision defined with such a value (0, a negative or fractional number, `NaN`, `Infinity`, or more than 2^31−1) now fails when it is defined or evaluated, where it used to time out on every evaluation.

- [#318](https://github.com/ixoworld/qiforge/pull/318) [`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Dependency updates. The LangGraph stack moves to `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/langgraph-checkpoint-sqlite` 1.0.4, `@langchain/langgraph-checkpoint-validation` 1.1.1 and `@langchain/mcp-adapters` 1.1.4. Both SQLite checkpoint savers now accept the `counters_since_delta_snapshot` metadata key that `langgraph-checkpoint` 1.1.5 adds for delta channels. Also updates `@tavily/core` 0.7.12, `mammoth` 1.12.3, `@digitalbazaar/http-client` 4.4.0, `@changesets/changelog-github` ^0.7.0, and lockfile-only bumps for `jose`, `@ixo/matrix-crdt`, `@nestjs/swagger` and `vitest`.

- [#323](https://github.com/ixoworld/qiforge/pull/323) [`e40dc1c`](https://github.com/ixoworld/qiforge/commit/e40dc1cfa5efd5c099b424ee10f8c9a30eddbf50) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Add authenticated request admission before agent preparation, durable direct-read disposition, deterministic titles, and request-scoped agent middleware. Preserve direct read transcripts and normal SSE and Matrix output without generative preparation. Require explicit sources for newly authored flow conditions and support a separate versioned semantic gate. Combine request and caller Decision cancellation and reject late provider success after cancellation.

  A refused or failed request admission now ends the run with an `error` frame (`kind: request_admission`, generic message) and `done`, and a user abort during admission ends it as `aborted`. Admission handlers receive a config without core credentials or other plugins' keys, the Matrix `roomKind`, `eventId` and `threadId`, and a per-handler time limit (`REQUEST_ADMISSION_TIMEOUT_MS`, default 2000 ms; a timeout counts as `pass`). Matrix group-room turns and scheduled task runs are never offered to admission handlers. A run recovered while its admission was in progress now runs the agent with the user's message instead of an empty graph input. `update_step` clears a semantic gate with `semanticGate: null`. Stored flow conditions without a source are read as `runtime_output`, so a read step is valid update input.

- [#237](https://github.com/ixoworld/qiforge/pull/237) [`3d8ad32`](https://github.com/ixoworld/qiforge/commit/3d8ad32de0a7040595f32298de442cd811bfc4ba) Thanks [@Zach-ixo](https://github.com/Zach-ixo)! - Update LangSmith to the patched 0.6 release line to address CVE-2026-45134.

- Updated dependencies [[`9bb456a`](https://github.com/ixoworld/qiforge/commit/9bb456a87f161d4fd787f91b16ea6cda13226a1c)]:
  - @ixo/matrix@1.2.34
  - @ixo/oracles-chain-client@2.1.3

## 1.1.0

### Minor Changes

- [#57](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/57) [`2a3bbd3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2a3bbd3267e1ce9a413eba4a30757e92ee8fa87b) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - # Live Agent: Ultra-Secure Voice & Video Calls

  This major release introduces **Live Agent Mode** - enabling real-time voice and video conversations with AI oracles through ultra-secure, end-to-end encrypted calls.

  ## ✨ Key Features
  - **Double Encryption Security**: Asymmetric key encryption + Matrix E2EE for maximum security
  - **Real-time Communication**: LiveKit integration for professional-grade WebRTC infrastructure
  - **Frontend-Controlled Keys**: True E2EE with user-generated encryption keys
  - **Zero-Trust Architecture**: Backend services cannot decrypt call content
  - **Per-Call Key Rotation**: Unique encryption keys for each call session

  ## 🏗️ New Components
  - `useLiveAgent` hook for voice chat integration
  - `useLiveKitAgent` for E2EE connection management
  - Complete call lifecycle with state validation
  - Enhanced Matrix integration for encrypted events

  ## 🛡️ Security Enhancements
  - ECIES-based encryption/decryption utilities
  - Cryptographically secure key generation
  - Live Agent authentication via API keys
  - Enhanced wallet generation with public key encoding

  ## 📡 New API Endpoints
  - `POST /calls/:callId/sync` - Sync call state from Matrix event
  - `GET /calls/:callId/key` - Get encrypted key for Live Agent
  - `PATCH /calls/:callId/update` - Update call status with validation
  - `GET /calls/session/:sessionId` - List user's call history

  ## ⚠️ Breaking Changes
  - **Backend only**: New environment variables required in your backend configuration:
    - `LIVE_AGENT_AUTH_API_KEY` - Authentication for Live Agent
    - `MEMORY_MCP_URL` - Memory management service URL
    - `MEMORY_MCP_API` - Memory management API endpoint
  - Updated dependencies for LiveKit and enhanced Matrix client

  ## 📚 Documentation
  - [Live Agent Architecture](./docs/architecture/calls.md) - Complete technical documentation
  - [Crypto Utilities](./packages/oracles-chain-client/docs/crypto.md) - Encryption implementation details

  This release represents a major milestone in secure, real-time AI communication, enabling truly private voice conversations with AI oracles through state-of-the-art encryption and professional-grade infrastructure.

### Patch Changes

- Updated dependencies [[`2a3bbd3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2a3bbd3267e1ce9a413eba4a30757e92ee8fa87b)]:
  - @ixo/matrix@1.1.0

## 1.0.2

### Patch Changes

- [#53](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/53) [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Upgrade packages and publish events package and preformance upgrades

- Updated dependencies [[`b723472`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b72347286054e037436a8be3da3cf840f75223ca), [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257)]:
  - @ixo/matrix@1.0.2

## 1.0.1

### Patch Changes

- [#44](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/44) [`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - use matrix spaces and reduce using user mx token

- Updated dependencies [[`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db)]:
  - @ixo/matrix@1.0.1
