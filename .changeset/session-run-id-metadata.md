---
'@ixo/oracle-runtime': minor
---

Forward `metadata.sessionRunId` from `POST /messages/:sessionId` into agent state next to `editorRoomId`. Flow documents keep runtime state per session run, so plugin tools that write runtime output (for example flow-manager's domain-card preview) need the run the client has open, not just the room.
