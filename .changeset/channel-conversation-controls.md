---
'@ixo/oracle-runtime-workers': minor
---

Channel conversations: `POST /channels/control` (stop, status, new, resume) with durable control receipts and cancellation reservations keyed by binding; a stop signals every named run and waits one shared grace, and a request whose run already finished still answers from it. `/resume` is bounded to the sessions the binding used at its current consent revision. Quoted WhatsApp replies reach the model as a note next to the person's words, never as their words: the note is stripped from transcripts, memory indexing and the action-proposal evidence, and says when the quoted message is from another conversation.

Channel sessions are indexed into the memory engine once quiet (`CHANNEL_HISTORY_INDEX_DEBOUNCE_MS`, default 3 min), reading only the unindexed tail in bounded chunks with a per-session backoff; a channel turn adopts a refreshed context only when the room cache is warm and never waits for one.

Opt-in, channel-only semantic routing (`CHANNEL_SEMANTIC_ROUTING=off|shadow|on`, default off) with binding allowlists and durable assignments; a classifier outage keeps the message in the current conversation, and an explicit `/new` or `/resume` that lands while a message is classified wins without cancelling it. Controls have their own rate-limit scope (`channel-control`).
