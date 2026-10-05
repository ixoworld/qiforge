---
'@ixo/oracle-runtime-workers': patch
---

Prune expired Composio tool-definition cache entries on every lookup, not only after a successful write, so one-off tenants' schemas no longer stay resident when the replacement session open fails.
