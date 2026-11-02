---
'@ixo/oracle-runtime-workers': minor
---

Long threads no longer reset the user object's isolate in a loop.

- **A run is recovered at most 8 times in all** (`RUN_RECOVERY_TOTAL_ATTEMPTS`, new; counted by the row's `generation`). Progress still resets the consecutive no-progress counter, but a turn that checkpoints once and resets the isolate again is no longer resumed until its client gives up: it ends `interrupted`, and the channel gateway, the Matrix room and the Portal stream each get their failure notice.
- **`redactSignedLinks`** walks a run's payload and serializes it only when a signed link can be in it.
