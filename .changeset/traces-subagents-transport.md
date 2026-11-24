---
'@ixo/oracle-runtime-workers': minor
---

IXO Traces: sub-agents nest under their tool call (in IXO Traces and LangSmith) and count in the turn's usage once; calls outside the graph (router, attachments, summarizer, safety) are sent as runs and counted once; the turn is always accepted (15 MiB inflated UTF-8 / 7.5 MiB gzip under the service's 16 / 8 MiB caps, every value serializable, nesting and the `$blob` key handled, numbers, times and ids clamped); delivery retries a 429 after Retry-After (at most 30 s), a 5xx/408/timeout once with jitter, takes 202 as sent, counts a 409 as a conflict, drops a 410 `gone` (and 404 `not_found`) and pauses that write key for 10 minutes, never retries other 4xx, never sends a run or trace id that is not a UUID, sends the contract version and pauses an isolate's sends for 10 minutes when the service refuses it; markers have their own lane. Plugin tools get `ctx.callbacks` for the models and agents they invoke.
