---
'@ixo/oracle-runtime-workers': patch
---

A first turn now waits up to 4 s for the memory prefetch (`USER_CONTEXT_PREFETCH_CAP_MS`, default 3000 before). The memory engine now lets its reranker use 2 s inside a prefetch batch instead of 1.5 s, because a slow reranker call is late, not lost, so a slow batch can take half a second longer. Only a slow prefetch waits longer: on mainnet 15 of 4,718 first turns in four days reached the 3 s cap, and 13 of those prefetches finished within 4 s. An oracle that sets `USER_CONTEXT_PREFETCH_CAP_MS` keeps its own value.
