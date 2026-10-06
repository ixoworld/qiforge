---
'@ixo/oracle-runtime-workers': patch
---

User object hardening:

- The five-day idle wipe now runs. The alarm, flushes and debug or operator calls no longer count as user activity, and the R2 tier's next pass no longer keeps an idle, clean, verified copy alive (the wipe deletes the R2 prefix too).
- Flush, flush-retry, task, compaction and run deadlines armed between alarm ticks now lower the stored housekeeping deadline, so the heartbeat fast path no longer skips them while a socket is attached. A run's keep-alive deadline also boots the object after a reset to recover its runs.
- A boot no longer hashes the whole working copy unless a legacy Matrix copy may still need removing, and it checks for local turns with one existence query instead of repeated counts.
- A changed upstream file is no longer re-imported over local turns that were not uploaded yet. The local copy is kept and uploaded on the next flush.
- A new delegation flushes early only after a recorded flush failure. Two clients alternating their delegations no longer upload on every turn.
- A boot that fails after opening the database closes it and leaves the object re-bootable: one connection, and the alarm boots again. An owner copy that is not a database leaves the object empty instead of bricking it.
- Session titles are generated in the background, bounded by a 15 s timeout and by the turn's abort, so `done` and the Matrix reply no longer wait for them.
- Fewer storage writes per request and per turn. The last access is kept in memory and persisted at most hourly (the idle check reads both), the delegation is stored only when it changes, the dirty mark and flush deadline are written once per debounce window, and the user's Matrix id is cached in memory.
- A turn build that fails part-way no longer leaves its 10-minute deadline timer or an abort entry behind.
- Runs that no admission handler can see are recorded as agent turns from the start. The two run-row rewrites per turn are gone.
- The Blocksync homeserver lookup is bounded at 3 s.
- A channel direct read no longer mirrors from the object, so a gateway failure no longer surfaces as an unhandled rejection.
- A zero-turn copy remembers that no usable legacy copy exists, so later boots skip the gateway round trips.
- Deleting a session ends its running, queued and recovering runs before the rows go.
- Blob compaction marks the copy dirty when its closing vacuum rewrote the file.
- `POST /messages` validates the type of every field it reads (a wrong type is a 400, not a failed turn).
- The exact turn time rides on the user's message (recorded under `turn_time_note`) and the system prompt carries only the date. A supplied-context task's input stays exactly as supplied. Session titles and memory indexing read the user's own words without the note.
- The summariser's budget is bounded by its own (routing) model's window, the capability router gets its hidden set lazily plus the turn's capability check, and the OpenRouter catalogue refresh is kept alive with `waitUntil`.
- The alarm uses the next wake time the task tick reports. A failed recovery start on the heartbeat path no longer rejects the alarm, and expired `blob:` entries are swept a page per tick without delaying an idle wipe.
- Matrix media downloads stop when the turn's signal aborts. Text that `view_attachment` extracted is cached per session and deleted with the session.
- A channel turn no longer checks its binding twice, and only queued or recovered channel attempts check it again.
- A turn's usage is written with the run's terminal status, so a turn writes its run row twice: when it starts and when it ends.
- A legacy Matrix copy that could not be read is looked for again on the next boot instead of being recorded as absent.
- The expired-blob sweep starts at most hourly per object (it keeps paging while a sweep is under way).
- `POST /messages` treats `null` in an optional field as absent.
- `POST /debug/storage/reset` boots a user object that never booted, for the authenticated caller and with the delegation the request carries.
