---
'@ixo/oracle-runtime-workers': minor
---

Identity checks and channel turns on WhatsApp, from the Yo mainnet review of 13 Nov 2026.

- `credentials_request_action` (`self.identity-check`) is state-aware: it reads the person's newest link at Self first and makes a new one only when that one ended (passed, failed, expired, stopped), is about to end, or cannot be read. While it is open it answers it instead: the same link and button again while nobody opened it (`status: "sent"`, `again: true`), "go back to the page you opened" once it was opened, or the check's progress. Both tool descriptions point "is it done?" and "how is it going?" at `credentials_action_status`, whose `ref` may now be left out for the newest link. The link is created with an optional `channel` field (`whatsapp` on a WhatsApp turn) so Self's pages can say "go back to your chat" only for chat links; a Self that does not read it ignores it.
- A person who asks again while their check is in review is told it is still being checked, that there is nothing more to do and that a person looks at it within 48 hours, instead of the first "Thanks, your identity check is sent" notice again.
- A channel turn whose reply came out empty (no text, no rich part) is never silent: the model is asked once more with a hidden note, and if that is empty too the person gets the oracle's short line (`channelFailureReply` told `kind: "empty_reply"`, else `CHANNEL_BUSY_REPLY`, else a default), logged as `empty_reply`.
- Each user Durable Object gets its own LangSmith client (`resolveLangsmithTracing` takes an optional `owner`): a client shared across the isolate's objects failed with "Cannot perform I/O on behalf of a different Durable Object" and lost that turn's trace.
