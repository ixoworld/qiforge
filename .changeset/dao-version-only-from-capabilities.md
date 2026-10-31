---
'@ixo/oracle-runtime-workers': patch
---

Only the capabilities read decides the Hub protocol version. An options or status read that Auth Hub refuses at the settled version no longer walks 7 → 6 → 5 and remembers the lower version (which sent the next prepare at version 5 on devnet when the options route refused 7 and 6): the capabilities read settles the version again, the read is retried once only if that changed it, and otherwise the read fails on its own in plain words.
