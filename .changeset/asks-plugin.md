---
'@ixo/oracle-runtime-workers': minor
---

asks.world plugin (`AsksPlugin`), moved from IXO Companion without changing its behaviour, and added to `BUNDLED_WORKERS_PLUGINS`. It is off unless `ASKS_TOKEN_KEY` and `ORACLE_PUBLIC_URL` are set. `NETWORK` picks the connector (mainnet `asks.world`, testnet `test.asks.world`, devnet `dev.asks.world`); when `NETWORK` is missing or unknown, the plugin stays off and logs why. `ASKS_WHATSAPP_RETURN_URL` and `ASKS_ALLOWED_DIDS` are optional. Each person's sign-in lives in `AsksConnectionDO`, which the package now exports. An oracle that turns the plugin on binds it as `ASKS_CONNECTIONS`, adds a `new_sqlite_classes` migration and re-exports the class from its worker entry. The sign-in routes are under `/asks/oauth/*`, without auth. The client name asks shows comes from `ORACLE_NAME`. See `docs/asks.md`.
