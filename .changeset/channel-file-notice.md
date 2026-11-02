---
'@ixo/oracle-runtime-workers': minor
---

Blocked files: the oracle learns why a chat gateway blocked a file it sent, and sends a corrected one.

- Every channel turn result (submit and every poll, whatever the status) carries `features: ["delivery_notice"]`.
- `ChannelTurnBody.notice` (`{ kind: "file_blocked", partId, filename, reason, detail, originalRequestId }`) is a turn the gateway sends in place of a message when it blocked a file for a content reason. It needs `sessionId` and `sessionPolicy: "continue"`, refuses `attachments` and `replyTo`, and is otherwise a turn: same admission, idempotent by `requestId`, same queue, recovery and Reply Plan. The model reads it as a note that is clearly not from the user, with the gateway's filename and detail quoted as data. The note is hidden wherever user messages are shown (Portal transcript and pages, history indexing, `topics` last lines, titles, quotes, routing, the oracle room mirror). The runtime downloads and checks no file.
- Where a gateway delivers the file, the `send_file` description, its result and the chat surface bullet say what the gateway blocks and tell the model to say it is sending the file, never that it is attached or delivered. The Portal, scheduled tasks and Matrix rooms are unchanged.
