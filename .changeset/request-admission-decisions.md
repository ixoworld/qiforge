---
'@ixo/oracle-runtime-workers': minor
'@ixo/common': patch
---

Add authenticated request admission before agent preparation, durable direct-read disposition, deterministic titles, and request-scoped agent middleware. Preserve direct read transcripts and normal SSE and Matrix output without generative preparation. Require explicit sources for newly authored flow conditions and support a separate versioned semantic gate. Combine request and caller Decision cancellation and reject late provider success after cancellation.

A refused or failed request admission now ends the run with an `error` frame (`kind: request_admission`, generic message) and `done`, and a user abort during admission ends it as `aborted`. Admission handlers receive a config without core credentials or other plugins' keys, the Matrix `roomKind`, `eventId` and `threadId`, and a per-handler time limit (`REQUEST_ADMISSION_TIMEOUT_MS`, default 2000 ms; a timeout counts as `pass`). Matrix group-room turns and scheduled task runs are never offered to admission handlers. A run recovered while its admission was in progress now runs the agent with the user's message instead of an empty graph input. `update_step` clears a semantic gate with `semanticGate: null`. Stored flow conditions without a source are read as `runtime_output`, so a read step is valid update input.
