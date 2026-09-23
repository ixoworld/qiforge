# Frontend command bridge dependency

This change supports Portal PR #1819. It does not enable Topic conversational writes or change Topic Protocol 1.x persistence.

Each invocation gets a unique ID. The caller subscribes before dispatch and accepts only a matching authenticated session and invocation. The active runtime verifies session ownership before joining a socket, selects one socket per invocation, and accepts a result only from that socket and principal. Browser and AG-UI calls share this path. Disconnects never trigger automatic redispatch.

A deadline returns `FRONTEND_OUTCOME_UNKNOWN`, since it cannot prove whether a frontend write persisted. Topic mutation calls receive a longer settlement window. Portal must recover the original command ID instead of issuing a replacement mutation. Ordinary explicit AG-UI errors keep their existing rejection behavior. Diagnostic Matrix action logs omit raw argument/result content.

The SDK listener checks its bound session, ignores late events after cleanup, and handles browser tools registered after connection. SDK source changes do not update the published package automatically. Portal retains its 1.4.0 pin and needs acceptance against the actual deployed contract.

## Required rollout checks

- [ ] Deploy the corrected active runtime, then prove the bridge contract against Portal's pinned SDK. The static `/health` advertisement is a version signal, not deployment acceptance evidence.
- [ ] Exercise two Topic sessions alongside HomeChat, account/session changes, reconnects, delayed results, lost responses and AG-UI actions.
- [ ] Verify executor readiness when multiple tabs share a session. Current routing selects one connected authenticated socket, without a capability/foreground advertisement. It does not redispatch to another socket when that selection cannot execute the tool.
- [ ] Verify ownership for existing session records, multiple oracle identities and encrypted Matrix history synchronization.
- [ ] Verify multi-instance deployment routing. The invocation registry is process-local; it is not a claim of global serialization or distributed deduplication.
- [ ] Keep Portal writes disabled until identity, recovery, full adapter coverage and signed-in acceptance gates also pass.

## Local evidence

- Frontend caller regressions cover immediate responses, distinct invocation IDs, wrong sessions, unknown deadlines and ordinary explicit failure compatibility for browser and AG-UI calls.
- Runtime tests cover authenticated result routing, single-executor dispatch, replay rejection, capacity recovery, session ownership and a real caller-to-GraphEventEmitter bridge round trip.
- SDK tests cover late tool registration, session switching, wrong-session calls and completed AG-UI replays.
- Runtime lint and build pass. The full runtime suite has 13 failures that reproduce on base `85d94ae43a139fedb01c06074dc716f51dfc0a90` with the same installed dependencies: environment schema (1), model defaults (2), middleware ordering (1), model routing (1), Matrix message supersede (3), memory MCP mocks (4) and sandbox tool listing (1).

No backend deployment, package publication or signed-in Portal acceptance is performed by this change.
