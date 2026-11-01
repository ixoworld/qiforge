---
'@ixo/oracle-runtime-workers': minor
---

The `ixo-chain` tools call people and things by name, from the shared IXO Names worker.

- **One `names` map per answer.** `get_account_balances`, `get_account_overview` and `chain_lookup` keep every raw address and DID and add `names: { [id]: { name, source, selfChosen } }` for the identifiers in the answer (`ixo1…` account and contract addresses, `did:ixo:ixo1…`, `did:ixo:wasm:ixo1…`, entity DIDs, `ixovaloper1…`, and claim collection ids as `collection:<id>`); at most 40 per answer, never the user's own. An answer with nothing named has no `names`.
- **The model is told** (operating guide and `chain_lookup` description): call people and things by their `names` entry; give an address or DID only when asked; beside a `selfChosen` name the user did not pick, also give the short address (first 12 … last 6 characters).
- **Bounded.** Names wait at most 4 s per call, never into the last 1 s of its 20 s budget; misses of concurrent calls are batched per isolate (10 ms window, at most 40 ids per POST, an id in flight never asked twice), answers are memoised per isolate for up to 10 min, and a 429 or 5xx pauses names requests for the worker's `Retry-After` (at most 5 min). Any failure leaves the answer without names. `names` counts toward the 12,000-character cap: rows are cut first.
- **Survives a dead actor.** State shared across Durable Objects (name batches, shared chain, denom and overview reads, read permits) recovers by age, noticed by the next caller, and a call that joined a read which died stops at its own deadline.
- **Config.** `IXO_NAMES_URL` (optional https origin; defaults per `NETWORK`) and `IXO_NAMES` (`on` by default, `off` disables names).
