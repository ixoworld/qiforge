---
'@ixo/oracle-runtime-workers': patch
---

Matrix gateway: bot SDK 0.7.2. A device rotation (one-time-key conflict loop, store-size limit, `POST /debug/matrix/rotate-device`) requested while the gateway bot was still starting took the half-started device apart and waited for that same start; the start finished on the old device, the rotation reported it as both retired and serving, and the real new device came up later with nothing left to log the old one out, so the old device stayed on the homeserver with its keys (IXO-6553). A rotation now waits for a start or stop in progress and then rotates the started device.
