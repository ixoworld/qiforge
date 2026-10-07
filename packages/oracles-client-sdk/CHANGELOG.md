# @ixo/oracles-client-sdk

## 1.5.0

### Minor Changes

- [#212](https://github.com/ixoworld/qiforge/pull/212) [`a79a670`](https://github.com/ixoworld/qiforge/commit/a79a6700f037f5591ae82f104365d8a22ea6152e) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - `useAgAction` takes `exposeToAgent` (default `true`). An action registered with `exposeToAgent: false` is answered over the socket like any other but is not sent with the turn's `agActions`, so the model never sees or calls it — the oracle reaches it only from one of its own tools (the Portal wallet-signing action of `@ixo/ixo-transaction/react`). The context adds `registeredAgActions` (every registered action); `agActions` keeps only the ones offered to the agent.

- [#224](https://github.com/ixoworld/qiforge/pull/224) [`6031b56`](https://github.com/ixoworld/qiforge/commit/6031b56ce57c14cd0f464019daeef997664837da) Thanks [@ig-shaun](https://github.com/ig-shaun)! - Anonymous feedback on a completed Agent reply. The runtime adds `POST /messages/:sessionId/:messageId/feedback`: the text is screened for direct identifiers and secrets, the message is checked in the caller's own database, and one Linear issue per reply is created with keyed pseudonyms and allowlisted coarse context only — never the prompt, the reply, tool data, the DID, raw ids, the IP or the user agent, and the text is neither stored nor logged. Per-user and per-IP limits, idempotent retries and bounded Linear retries are built in. Off until `FEEDBACK_LINEAR_API_KEY` and `FEEDBACK_HMAC_SECRET` are set; the transcript routes then advertise `capabilities.anonymousMessageFeedback`. The SDK's `useChat` gains `submitMessageFeedback`, `isAnonymousMessageFeedbackSupported`, `submittingFeedbackMessageId` and `messageFeedbackError`; the control stays hidden against runtimes that do not advertise the capability, and submitting never changes or refetches the messages. Every refusal carries a machine-readable `code` and a `retryable` flag (e.g. `FEEDBACK_IN_FLIGHT`, `FEEDBACK_ALREADY_SUBMITTED`), which the SDK's `RequestError` now exposes as `code` and `retryable` for any runtime error body that has them.

- [#339](https://github.com/ixoworld/qiforge/pull/339) [`77012a8`](https://github.com/ixoworld/qiforge/commit/77012a8ef4ba6f2c5b7403635a1e6d232510cc69) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - Client SDK hardening.

  **Type change:** `ChatRunState['ended']` (the `run.ended` that `useChat` returns) and `StreamRunResult['ended']` have a new value, `'unauthorized'`. Code with an exhaustive `switch` over these values no longer compiles until it handles that value.

  - **Re-joining a running reply.** Each re-join of a durable run now sends credentials read at that moment, so a reply that outlives the UCAN invocation keeps streaming. When the oracle refuses a re-join (401/403), the SDK mints a new invocation once and tries again. If that is refused too, it stops instead of retrying a dozen times: `run.ended` is the new value `unauthorized` and the chat shows an error. The turn's POST is still never repeated.
  - **Realtime socket.** The socket handshake is built on every connect, so a reconnect after the invocation expired is accepted. A connect the server refused for its credentials is retried once with a new invocation (socket.io does not retry it by itself); any other refusal mints nothing. Browser tools registered after the socket connected now answer their calls.
  - **Account switches.** Sessions, transcripts, the oracle authz config and the "oracle in room" check are cached per user. After an account switch on the same page, the new user no longer sees the previous user's session titles or transcripts, and contracting uses the new user's authz config.
  - **Voice calls.** Connection details belong to the call they were issued for and are refreshed when their token is about to expire. An error from the token service is reported instead of being used as connection details. The call's encryption key is no longer written to the console. Leaving the page during a call leaves the room, marks the call ended and stops the encryption worker. Under React StrictMode the encryption worker is no longer stopped before the first call.
  - **Chat lifecycle.** Leaving the chat while a reply streams stops following it (the reply keeps running on the oracle and is re-joined on return) and no longer refetches afterwards. A message whose chat closes while its credentials are still being minted is not sent, and a reply that was still being re-attached when the chat closed is not opened. Under React StrictMode a session whose history is already cached now shows it. A message sent while a page reload was still re-attaching to the previous reply is no longer cut off. Stop now uses the current wallet and oracle.
  - **Credentials.** Concurrent requests share one delegation or invocation mint instead of each signing their own. A failed mint is not remembered, so the next request tries again. The oracle's authz config is fetched once per page instead of once for `useOraclesConfig` and again for `useContractOracle`, `useMemoryEngine` or `useLiveAgent`.
  - **Stream handling.** An exception thrown by a host callback (`onToolCall`, `onActionCall`, …) is now reported instead of being treated as a dropped connection. A frame the runtime sends twice is applied once.
  - **Tool and action schemas.** Browser tools and actions registered with `useAgAction` are now sent to the oracle with their real parameter schema. Their zod 4 schemas used to be converted with a zod 3 converter, which produced an empty schema, so the model saw every tool and action as taking no parameters. A browser tool's `schema` (`IBrowserToolParams.schema`, now the exported `ToolSchema` type) accepts a zod 4 schema, as the docs show; a `zod/v3` schema is still accepted and converted as before.
  - **Components.** A tool or component named like an `Object` prototype member (`constructor`, `toString`, …) renders with the `ToolCall` fallback instead of crashing the chat view.

- [#342](https://github.com/ixoworld/qiforge/pull/342) [`b4b395b`](https://github.com/ixoworld/qiforge/commit/b4b395ba8f1700f66d8fe7aa39081878cb63227e) Thanks [@Michael-Ixo](https://github.com/Michael-Ixo)! - Credentials refused by the oracle are renewed in two stages, everywhere.

  **Type change:** `IOraclesContextProps` has a new required member, `renewOracleAuth`. Code that builds the context object itself (a test double of `useOraclesContext`) no longer compiles until it provides one.

  - **Two stages.** When the oracle refuses a request for its credentials (401, or a 403 other than `VFS_AUTH_FAILED`), the SDK mints a fresh invocation and repeats the request; refused again, it mints a fresh delegation, then a fresh invocation, and repeats it a last time. The delegation stage, which asks the user for their key, runs only after a repeat with a fresh invocation was refused, never on a first refusal. A delegation that stage minted less than ten minutes ago is not replaced again; refusals that arrive together share one renewal; a caller whose refused credentials another caller already replaced repeats with the new ones without minting.
  - **Where.** `authedRequest` (every hook's REST calls) now renews and repeats; it used to throw on the first refusal. The turn's `POST /messages/:sessionId` is repeated while it is refused for its credentials (a refused POST was never processed) and never once accepted; it used to fail at once. Re-joins of a running reply and the realtime socket's CONNECT gain the second stage. The socket no longer renews for refusals new credentials cannot fix (a failed session check, a failed auth check, a token of another user).
  - **`run.ended === 'unauthorized'`** now means the re-join was refused after both stages. A POST still refused after both stages rejects `sendMessage` with a `RequestError` whose `status` is the refusal's (it used to carry only `statusCode`).
  - **API.** `getDelegation(oracleDid, { fresh: true })` replaces the cached delegation (dropped before the mint, so readers meanwhile get the new one). The context adds `renewOracleAuth(oracleDid, stage, refused?)`, the shared renewal for a host's own requests, and the provider takes `onDelegationRenewed(oracleDid, delegation)`, called after the delegation stage minted one (for example to deposit it with `POST /delegation`). New exported types: `AuthRenewalStage`, `RefusedCredentials`.
  - **`RequestError.status`** falls back to the HTTP status when the error body has no `statusCode`.

### Patch Changes

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

- [#297](https://github.com/ixoworld/qiforge/pull/297) [`d38f90a`](https://github.com/ixoworld/qiforge/commit/d38f90a06efaf641ae73d1e75e51464c187e3751) Thanks [@ig-shaun](https://github.com/ig-shaun)! - SSE parser follows the specification for framing: a frame's lines may arrive across any number of network reads (UTF-8 sequences included), `\r\n` line ends are accepted, several `data:` lines are joined, and a heartbeat comment never ends a frame in progress. Event ids, malformed-frame handling and abort behaviour are unchanged.

- Updated dependencies []:
  - @ixo/oracles-chain-client@2.1.3

## 1.4.0

### Minor Changes

- Durable runs: `streamRun` re-joins a reply after a dropped connection with its frame cursor, truncates to `partialLength` when a resumed attempt announces itself, and surfaces `partialText` from an early `done`; `useChat().run` (`ChatRunState`), `useSendMessage().resumeRun`, and an automatic re-join of an active run on session load (`GET /sessions/:id/run`). Frames are bound to the chat instance the turn started in, so switching sessions no longer leaks a stream.
- History paging: `useChat` loads a session one turn-aligned page at a time through `GET /sessions/:id/messages` (`hasEarlier`, `loadEarlier()`, `isLoadingEarlier`, `historyPageSize`), fetches only what a turn added after it, and keeps the newest page first so a remount refetch starts at the latest turns. A runtime without the paged route falls back to the legacy whole transcript. The 100-message store cap is gone.
- `streamingMode: 'throttled'` (`streamingThrottleMs`, default 50 ms) coalesces streamed chunks into a few renders a second; state changes flush at once, and a hidden tab delivers immediately and flushes on `visibilitychange`. The default `immediate` is unchanged.

### Patch Changes

- Streamed reasoning frames are filed under their own message (`<requestId>-reasoning`) instead of the answer's id, so a reply whose reasoning streams first (the ChatGPT lane) is visible while it streams.
- `tool_result` acknowledgements carry the session id; `sendMessage` clears a previous error before a new turn; a failed stream carries its `requestId`.

## 1.0.11

### Patch Changes

- [`c643779`](https://github.com/ixoworld/companion/commit/c6437794acd28c833074763449502daf61e40a4c) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - matrix fix

- Updated dependencies [[`c643779`](https://github.com/ixoworld/companion/commit/c6437794acd28c833074763449502daf61e40a4c)]:
  - @ixo/oracles-chain-client@1.1.3

## 1.0.10

### Patch Changes

- [`b5799ee`](https://github.com/ixoworld/companion/commit/b5799ee19a0957ad38e2374ae18e11278295a1ab) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Fix testnet signed mnemonics

- Updated dependencies [[`b5799ee`](https://github.com/ixoworld/companion/commit/b5799ee19a0957ad38e2374ae18e11278295a1ab)]:
  - @ixo/oracles-chain-client@1.1.2

## 1.0.9

### Patch Changes

- Updated dependencies [[`3117e8d`](https://github.com/ixoworld/companion/commit/3117e8d2f753811511de4eda8e99b18c3888e083)]:
  - @ixo/oracles-chain-client@1.1.1

## 0.2.0

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
  - @ixo/oracles-chain-client@1.1.0

## 0.1.23

### Patch Changes

- [`b723472`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b72347286054e037436a8be3da3cf840f75223ca) Thanks [@yousefhany77](https://github.com/yousefhany77)! - fix bugs and some preformace updates

- [#53](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/53) [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Upgrade packages and publish events package and preformance upgrades

- Updated dependencies [[`b723472`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b72347286054e037436a8be3da3cf840f75223ca), [`0a4a5a8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/0a4a5a84194acb851e3824e0b74eea54f60c8257)]:
  - @ixo/oracles-chain-client@1.0.15
  - @ixo/oracles-events@1.0.1

## 0.1.19

### Patch Changes

- [#48](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/48) [`0664938`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/06649385d7a4d9f3640fb21a316f18c61f94e185) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Add support for overriding WS url and support to invite user to mx room

## 0.1.16

### Patch Changes

- [#44](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/44) [`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - use matrix spaces and reduce using user mx token

- Updated dependencies [[`2b93cf8`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/2b93cf8ef3839c36f03249b9392606211a22a0db)]:
  - @ixo/oracles-chain-client@1.0.13

## 0.1.15

### Patch Changes

- [#42](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/42) [`27ddf3b`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/27ddf3b04d70604f856a55f537599626266c54b6) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - support metadata in chat

## 0.1.14

### Patch Changes

- [#40](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/40) [`78ddd3b`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/78ddd3b407dde28b7f6ca16c91ee7452f5491d73) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - enhance useChat and useOracleSessions hooks for improved performance and query handling

## 0.1.13

### Patch Changes

- [#38](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/38) [`e4c8f86`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/e4c8f866f6a51716e0c2074c9fe54d76beb4e92f) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - refactor: update Authz and Payments classes to improve authorization handling and integrate new settings resource utility

- Updated dependencies [[`e4c8f86`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/e4c8f866f6a51716e0c2074c9fe54d76beb4e92f)]:
  - @ixo/oracles-chain-client@1.0.12

## 0.1.12

### Patch Changes

- [#35](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/35) [`da24aae`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/da24aae97260c4fa186d3a2cc8f797c731d9cb98) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Fix for Using with FE React

- Updated dependencies [[`da24aae`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/da24aae97260c4fa186d3a2cc8f797c731d9cb98)]:
  - @ixo/oracles-chain-client@1.0.11

## 0.1.11

### Patch Changes

- [#33](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/33) [`c56f5c0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c56f5c0aff5867e300a7008c480bd76abd68557e) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - fix make package public

- Updated dependencies [[`c56f5c0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c56f5c0aff5867e300a7008c480bd76abd68557e)]:
  - @ixo/oracles-chain-client@1.0.10

## 0.1.10

### Patch Changes

- [#31](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/31) [`4b91a61`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/4b91a6140fba5d25d406a32e4254fcc2433cd391) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Make package public

## 0.1.9

### Patch Changes

- [#29](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/29) [`267de8c`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/267de8c8065387f69ae882920e101331fb93d2dd) Thanks [@youssefhany-ixo](https://github.com/youssefhany-ixo)! - Update interfacesand small fixes for FE clients

- Updated dependencies [[`267de8c`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/267de8c8065387f69ae882920e101331fb93d2dd)]:
  - @ixo/oracles-chain-client@1.0.9

## 0.1.8

### Patch Changes

- [`edc19e3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/edc19e39da21347af70f71432b297a6bfb135435) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`edc19e3`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/edc19e39da21347af70f71432b297a6bfb135435)]:
  - @ixo/oracles-chain-client@1.0.8

## 0.1.7

### Patch Changes

- [`bdff5e0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/bdff5e0fdee1b52bbdd84f6c68d6cd6679b9c05d) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - Dockerfile

- Updated dependencies [[`bdff5e0`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/bdff5e0fdee1b52bbdd84f6c68d6cd6679b9c05d)]:
  - @ixo/oracles-chain-client@1.0.7

## 0.1.6

### Patch Changes

- [`6505d49`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/6505d4907e0a0f27656a72e5f334cfeba08a22b9) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`6505d49`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/6505d4907e0a0f27656a72e5f334cfeba08a22b9)]:
  - @ixo/oracles-chain-client@1.0.6

## 0.1.5

### Patch Changes

- [`c050676`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c050676976a8f2bf90d9ecc55be115614639c253) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`c050676`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/c050676976a8f2bf90d9ecc55be115614639c253)]:
  - @ixo/oracles-chain-client@1.0.5

## 0.1.4

### Patch Changes

- [`53d6155`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/53d61558d5054d74288b38d4af47a60d15a066a6) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`53d6155`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/53d61558d5054d74288b38d4af47a60d15a066a6)]:
  - @ixo/oracles-chain-client@1.0.4

## 0.1.3

### Patch Changes

- [`b877474`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b877474ee6d45e211212df15fbea337b338b8850) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`b877474`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/b877474ee6d45e211212df15fbea337b338b8850)]:
  - @ixo/oracles-chain-client@1.0.3

## 0.1.2

### Patch Changes

- [`26d8444`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/26d84448ac92b038df0330758f978d6be352b115) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - bump

- Updated dependencies [[`26d8444`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/26d84448ac92b038df0330758f978d6be352b115)]:
  - @ixo/oracles-chain-client@1.0.2

## 0.1.1

### Patch Changes

- [#16](https://github.com/ixoworld/ixo-oracles-boilerplate/pull/16) [`745991a`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/745991a3fc7fb9ac640dc6fd2aad5a17781df9b7) Thanks [@LukePetzer-ixo](https://github.com/LukePetzer-ixo)! - Init

- Updated dependencies [[`745991a`](https://github.com/ixoworld/ixo-oracles-boilerplate/commit/745991a3fc7fb9ac640dc6fd2aad5a17781df9b7)]:
  - @ixo/oracles-chain-client@1.0.1
