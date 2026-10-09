---
'@ixo/oracle-runtime-workers': minor
'@ixo/oracles-client-sdk': minor
---

Every message in the chat history (`GET /messages/:id` and the paged `GET /sessions/:id/messages`) now carries `createdAt`: the ISO 8601 time the message was first saved (the saver's `additional_kwargs.timestamp`, also the listing's order key) — the turn's admission time for the user's message, the time its step was first checkpointed for a reply, unchanged by later saves. The client SDK's `IMessage` declares the optional field; the history path already passed it through.
