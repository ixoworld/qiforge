---
'@ixo/oracle-runtime-workers': patch
---

Matrix gateway: bot SDK 0.7.1. A restart of the gateway bot (planned recycle, send watchdog, token rejection) that a gateway call raced used to start a second bot beside the stop and leave its sync loop running for the life of the isolate, each with its own Matrix client and crypto machine. On the Yo mainnet gateway 9–15 of them piled up per isolate and it was killed four times for exceeding the 128 MB memory limit (IXO-6552). Starts and stops are now serialised in the SDK, a second loop is never left running, and `/matrix/status` shows `syncLoops` (1 while running).
