---
'@ixo/oracle-runtime-workers': patch
---

`ixo-chain` names wait up to 6 s instead of 4 s, and a slow batch now keeps the names that were ready. Each request sends the IXO Names worker's `options.budgetMs` (5 s): the worker answers with what it has, the rest come back `partial`, and it finishes them in the background for the next call. Before, a batch that took longer than the wait got no names at all.
