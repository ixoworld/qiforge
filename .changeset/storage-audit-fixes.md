---
'@ixo/oracle-runtime-workers': patch
---

Storage hardening for the user database, the R2 page tier and the owner copy.

- A cold-page read whose R2 response arrives after an eviction pass rewrote that segment now fetches the generation the map points at, instead of serving (and later persisting) stale or zeroed pages.
- Statements issued outside `transaction()` now wait for another chain's open transaction to commit or roll back instead of running inside it, so a rollback (including the retry after a cold miss) can no longer discard a write its caller already saw succeed. Nested transactions stay savepoints; `transaction()` inside `withoutTransactions()` no longer deadlocks; a failed COMMIT no longer corrupts the transaction depth.
- An eviction pass holds the database lock only for its short storage steps, never across R2 uploads, so a turn that starts mid-pass is no longer blocked for the rest of it. A segment is committed only if nothing changed under it (truncation, import, rename, delete, a snapshot opened); otherwise the pass stops and the next one starts over.
- Reading pages that a partial hot row already holds no longer goes to R2.
- The orphan sweep is scheduled from persisted state (at most weekly, one listing page per run), never runs while a pass has uploads in flight, and only deletes keys shaped like tier segments — it no longer deletes the result store's `<object id>/results/…` objects that share the prefix.
- Object deletes wait while a whole-file export or checksum is reading.
- The legacy-blob compactor bounds each step by bytes (8 MiB by default, always at least one row) as well as rows; the end result is unchanged.
- The checkpointer updates unchanged message rows in place (stable rowids) and reuses the compressed blob of a message object whose JSON did not change; a checkpoint's messages are still read back in array order, including after a summary is placed before the history it kept.
- Migration 002 drops the `idx_messages_thread_id` and `idx_messages_checkpoint_id` indexes; the one query that used the former runs the same `thread_id` range search on a remaining index.
- `SessionsStore.listSessions` reports the real total for a page past the last session (it reported 0).
- The VFS owner copy is replaced by moving the old file aside, moving the upload into place and only then deleting the old copy and leftovers of earlier flushes; when the move into place fails, the old file is moved back. Leftovers that may be the only complete copy are no longer deleted before a new file has landed.
- When the owner copy's path is empty because a swap failed after moving the previous file aside, `head()` and `load()` use the newest `.replaced-` copy instead of reporting no file. A retried move that the VFS already committed (its answer lost, the retry refused with 409) now counts as done.
- The compactor reads one legacy row at a time, so a step no longer loads every remaining candidate.
- A mid-turn summary's `turn_carry` (the tool calls of the turn it condensed) is kept when the checkpoint is saved, newest calls first up to 64 KiB.
