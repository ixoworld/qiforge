---
'@ixo/oracle-runtime-workers': minor
---

Add a default-off (`TOPIC_DELIVERABLES_ENABLED`), signed-invocation-only Topic deliverable API using the existing Workers task scheduler. Start retries bind to one immutable request (the JSON of the parsed body, keys in schema order, no Unicode normalization), reads return exact persisted Markdown with a digest, and cancellation is accepted only until execution finishes: once the result is stored, cancel returns `409`, the result is final and delivery continues. Late work after a cancellation never becomes ready. Cancellation requires the same full request and durably prevents a delayed Start from creating active work, even when cancellation arrives first.

- One operation ID is one attempt: a reset mid-turn is recovered by the durable run, a turn that ends without a result leaves the deliverable `failed` and is never retried.
- The turn runs without a room and its result is stored first; delivery to the user's main room is best-effort in the scheduler's delivery rounds, so a gateway outage delays only the delivery.
- Topic tasks are hidden from the generic task surface (`list_my_tasks`, `get_task`); `cancel_task` refuses them and names the dedicated cancel route; pause, resume and edits stay refused for them.
- Start and cancel mark the owner copy dirty, so their writes are uploaded and the object can still evict; the RPC waits for an idle eviction in progress like any request.
- Known limit: the invocation (`can: '*'` on `ixo:oracle`) is not bound to method, path or body and replay tracking is per isolate, so a captured invocation can read the Markdown within its lifetime.
