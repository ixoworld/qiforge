---
'@ixo/oracle-runtime-workers': patch
---

Sub-agent results are no longer reported to the model as interrupted, and `read_result` no longer invites reading a saved result to the end.

- A sub-agent with `forwardTools` hands back its forwarded messages before the parent call's own result (with parallel calls, also before the other calls' results). The dangling-call repair only looked at the results right after a call, so it answered every such call with "was interrupted … nothing from it was recorded. Call it again", and a model re-ran POD specialists that had already recorded their sections. The repair now moves a result that arrived later in the turn up to its call; only a call with no result anywhere in the turn is still answered as interrupted.
- Messages a sub-agent forwards into the chat (`forwardTools`) are now marked (`forwardedFrom`) and left out of the parent's model requests: they are for the UI. Shown to the model, a forwarded call read as one of its own (a model called a specialist's `submit_section` itself) and its arguments were resent on every model call.
- A sub-agent that ends on an empty reply now hands the parent its last tool result, labelled as such (at most 2,000 characters), instead of an empty string.
- POD Creator specialists forward only `submit_section`: their full-section `read_blueprint` reads (often over 60 KB) no longer land in the conductor's thread to be capped and paged through.
- The result-cap footer and `read_result`'s description now say to read only the part a task needs and never to read a result back to check that a call worked. A turn may make at most six `read_result` reads (parallel reads each count); a read is at least 2,000 characters and by default the largest chunk.
