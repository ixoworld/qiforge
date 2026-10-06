---
'@ixo/oracle-runtime-workers': minor
---

Hard storage caps on `ctx.kv`, the plugin key/value rows kept in the user's own SQLite file next to their checkpoints, sessions and transcript (and exported with it as the owner copy).

- **Caps.** One value at most `USER_KV_MAX_VALUE_BYTES` (256 KiB of UTF-8 JSON); one namespace at most `USER_KV_MAX_ENTRIES_PER_NAMESPACE` (10,000) entries; all namespaces together at most `USER_KV_MAX_TOTAL_ENTRIES` (50,000) entries and `USER_KV_MAX_TOTAL_BYTES` (32 MiB), counting the UTF-8 bytes of namespace, key and value JSON of every row, so long names cannot carry data past the cap. No write option lifts them, and both the SQLite store and `createMemoryUserKv()` enforce them.
- **Refusal.** A `set` / `update` that would break a cap rejects with the new exported `UserKvLimitError` (`limit`: `value`, `namespace-entries`, `entries` or `bytes`; `max`; `actual`; `namespace`). Nothing is written and nothing is evicted to make room: the previous value stays. Expired entries of every namespace are swept before a write is refused, a write's own `maxEntries` trim counts toward making room, and replacing a key counts only the difference in size. A store already above a cap can still shrink, replace in place and delete; deleting is never refused.
- **Breaking for out-of-range options.** A `maxEntries` above 10,000 now rejects with a `RangeError` instead of being accepted.
- **Schema.** `user_kv` gains a `bytes` column with the indexes `idx_user_kv_bytes` and `idx_user_kv_expiry`. Existing tables are upgraded in place on first use (column added and backfilled from the stored namespace, key and JSON in one transaction); no manual migration.
