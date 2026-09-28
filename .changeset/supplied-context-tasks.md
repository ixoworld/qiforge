---
'@ixo/oracle-runtime-workers': minor
---

Add an immutable supplied-context Markdown execution profile for one-shot tasks. The existing durable task path excludes tools and unrelated context, preserves the profile on recovery, and retains model budgets and checkpoints. Cancel or drain restricted tasks before rollback to an older runtime.
