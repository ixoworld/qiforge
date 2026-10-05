---
'@ixo/oracle-runtime-workers': patch
'@ixo/oracles-client-sdk': patch
---

A browser action now runs once per call.

- **No mirrored turn frames.** A turn's `tool_call`, `action_call` and `router.update` frames stay on its SSE stream and are no longer copied to the session's sockets. The copies made the SDK run an AG-UI action's browser handler three times per call. A second tab still sees a running turn by re-joining it through `GET /sessions/:id/run`.
- **Frontend calls go to the socket only.** `browser_tool_call` and `action_call` reach the session's sockets once and no longer appear on the SSE stream, where the action showed as a card that never finished.
- **SDK.** Removed two orphan index files that pointed at missing modules, and the docs for a `present_files` action that does not exist.
