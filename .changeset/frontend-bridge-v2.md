---
'@ixo/oracle-runtime-workers': minor
'@ixo/common': minor
'@ixo/oracles-client-sdk': patch
---

Frontend bridge version 2: browser tools and AG-UI actions are scoped to one invocation, one socket and one result, and a missing answer is reported as an unknown outcome instead of a failure.

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
