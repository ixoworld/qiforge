---
'@ixo/oracle-runtime-workers': minor
---

Channel conversations: `POST /channels/control` (stop, status, new, resume, topics, rename) with durable control receipts and cancellation reservations keyed by binding; a stop signals every named run and waits one shared grace, and a request whose run already finished still answers from it. `/resume` is bounded to the sessions the binding used at its current consent revision. Quoted WhatsApp replies reach the model as a note next to the person's words, never as their words: the note is stripped from transcripts, memory indexing and the action-proposal evidence, and says when the quoted message is from another conversation.

Channel sessions are indexed into the memory engine once quiet (`CHANNEL_HISTORY_INDEX_DEBOUNCE_MS`, default 3 min), reading only the unindexed tail in bounded chunks with a per-session backoff; a channel turn adopts a refreshed context only when the room cache is warm and never waits for one.

Opt-in, channel-only semantic routing (`CHANNEL_SEMANTIC_ROUTING=off|shadow|on`, default off) with binding allowlists and durable assignments; a classifier outage keeps the message in the current conversation, and an explicit `/new` or `/resume` that lands while a message is classified wins without cancelling it. Controls have their own rate-limit scope (`channel-control`).

Controls also list and name topics: `topics` returns the binding's sessions (title, times, last user line and last reply) and is read-only for the conversation, dropping only the bookkeeping rows of deleted sessions; `rename` sets the bound session's title (the placeholder `Untitled` is refused). Titles and lines are normalised to one plain line and every length is in Unicode code points. Every control result carries `title`, and every turn response carries `sessionTitle`, so a gateway can name the session it picked or switched to.
