---
'@ixo/oracle-runtime-workers': patch
---

A user object whose owner-copy upload fails because the user has no delegation to the oracle (or one without `ixo:filesystem` on `/.oracles`) no longer retries every 10 minutes. It logs once, keeps the working copy (never evicted while it waits) and uploads as soon as a delegation arrives: `POST /delegation`, a request's delegation header, or the room-state deposit a header-less turn reads. `GET /debug/storage` shows `flushWaitsForDelegation`. Before, such users were retried indefinitely: thousands of `owner-store flush failed (N in a row)` errors each on mainnet.
