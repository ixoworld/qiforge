---
'@ixo/oracle-runtime-workers': minor
---

Add an immutable supplied-context Markdown execution profile for one-shot tasks. The existing durable task path excludes tools and unrelated context, preserves the profile on recovery, and retains model budgets and checkpoints. Around the turn, a restricted task's session is never titled by the title model, indexed into the memory engine or traced to LangSmith; the task tools show it as restricted with metadata only and refuse to edit, pause or resume it (cancel still works). The one-shot, no-approval policy is re-checked on every turn, not only at creation. Task-run sessions are no longer sent to the memory engine at all; a session create indexes the latest conversation instead. A task row with an execution profile this runtime does not know is skipped instead of failing the whole task store. Cancel or drain restricted tasks before rollback to an older runtime.
