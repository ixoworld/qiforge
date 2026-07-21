---
'@ixo/matrix': minor
---

Bump matrix-bot-sdk to ^0.8.0-ixo.14 and bootstrap cross-signing after the Matrix client starts. Brings MSC4268 encrypted history sharing (send and accept), the non-blocking room tracker (instant startup with a deferred background room scan), and a fail-closed encryption check on send. Cross-signing is required for key bundles in both directions; the identity is restored from Secret Storage when available.
