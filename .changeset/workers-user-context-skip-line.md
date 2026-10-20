---
'@ixo/oracle-runtime-workers': patch
---

The first-contact prefetch line (`[user-context] first contact room=… session=… outcome=… waited=…ms`) is now printed for every first contact, including the ones that fetch nothing: a turn with no oracle room, the prefetch switched off or no `MEMORY_ENGINE_URL`, a Matrix group room, or a user whose delegation has no `ixo:memory` grant print `outcome=skipped reason=<no-room|disabled|not-booted|group-room|no-memory-grant> waited=0ms`; a `failed` or fetcher-level `skipped` outcome carries its reason the same way. The two info-level lines those cases printed before (`skipped: group room`, `skipped: the delegation grants no ixo:memory memory/*`) are replaced by it. Found on mainnet after 0.20.1, where the first turns after the deploy were users without a memory grant and showed no first-contact line at warn level. Task-run and supplied-context turns still print nothing.
