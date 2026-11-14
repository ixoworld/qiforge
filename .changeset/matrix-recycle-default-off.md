---
'@ixo/oracle-runtime-workers': minor
---

Matrix gateway: the planned recycle after a number of sends is off by default (`MATRIX_RECYCLE_AFTER_SENDS` default 0, was 300). It was added against a fake-indexeddb leak of ~250 KB per encrypted send, which the bot SDK has pruned since its first release (`cryptoStoreTransactions` in `/matrix/status` stays at a handful). The recycle restarts the bot in the same isolate, so it never returned the crypto WASM's memory, and under steady load it fired every few minutes, cancelling sends still waiting in the scheduler and holding every gateway call until the bot was back. Set `MATRIX_RECYCLE_AFTER_SENDS` to a positive count to opt back in; other restarts (send watchdog, device rotation, Cloudflare resets) are unchanged.
