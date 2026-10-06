---
'@ixo/oracle-runtime-workers': patch
---

Durable runs, channels, delivery and artefacts hardening:

- Messages of one session are admitted one at a time, so two messages arriving together can no longer start two graph runs on the same thread. A message superseded by a later one while it waited ends `aborted` without running; a run that does not wind down within the supersede grace keeps the new message queued behind it instead of running beside it.
- New `RunCoordinator.abortAllForSession(sessionId)`: ends the session's running, queued and recovering runs (and messages still being admitted) as `aborted`, and resolves once the running attempt ended or the grace elapsed.
- Every run now ends with the frames its subscribers need: an attempt that crashes, a recovering run that is aborted, or a run whose deferrals exhaust the recovery cap sends an `error` frame (for failures) and a `done` frame, and the response stream closes. A buffer that closes always ends its streams.
- A re-join no longer misses frames that were being written to a segment while it read the stored ones.
- A recovering or queued run aborted while it was being started is closed instead of attempted.
- Each attempt now says whether it was just admitted, dequeued or a recovery (`LiveRun.attemptSource`).
- A provider or tool error that mentions "abort" (a timeout) is reported as a failure with an `error` frame; only the turn's own abort signal makes a run `aborted`.
- Boot pruning of ended runs is set-based in one transaction, with the same retention (tombstones kept, receipts of tombstoned runs dropped, 410 for pruned ids), and no longer scans the whole tombstone table.
- `read_result` pages on UTF-8 character boundaries, so non-ASCII results page back exactly; `length` and `next` report where a page really ended.
- A stored result shared by two sessions survives the deletion of one of them (references in `tool_result_sessions`, migrated from existing rows on first boot).
- A result row whose R2 object could not be deleted is kept (marked expired) until a later sweep deletes the object, instead of leaking it.
- A channel poll of an admitted request no longer marks the database dirty or re-checks the session; the session is checked when a request is bound to it and before a request starts a run.
- The legacy transcript listing folds tool results in linear time.
- The artefact viewer parses headings, tables and inline Markdown in linear time; a crafted line can no longer freeze the reader's tab. A heading's closing `#`s are only dropped when a space sets them apart (`# C#` stays `C#`). The page script is one static text, so the bundled Worker serves exactly the script the CSP hash pins.
- New `sweepExpiredBlobs` deletes expired plugin blobs a bounded page at a time.
- Concurrent `getServiceDelegation` calls for the same user, resource and ability share one UCAN store look-up; a failed look-up is retried by the next call.
- `RunOutcome.usage` is stored with the run's terminal status in the same row update.
- The transcript (`GET /messages`, paged transcripts) shows a user message without the turn-time note the model was given with it; `visibleContent` / `visibleText` give other readers the same text.
- Stop (`POST /messages/abort`) also ends a message still waiting for the run it superseded, and one queued behind a run that outlived the supersede grace; messages enqueued behind the active run still start after it.
- A re-join that arrives as its run ends is answered like a re-join of an ended run (the stored status, reply and partial text in the closing frame) instead of a bare `done`.
- A run's end is one transaction (terminal row and segment cutover), and the coordinator no longer reads back rows it just wrote.
- Boot pruning of ended runs and old write claims uses new indexes on `turn_runs.updated_at` and `turn_write_claims.started_at` (built once, on the first boot after the upgrade).
- Storing and removing tool results is serialised, so a result stored again while it is being removed stays readable; an expired result is stored afresh rather than revived, and a failed R2 delete keeps only the rows of the failed batch.
- did.json and UCAN store look-ups time out after 10 s, so one hung look-up no longer holds every caller waiting on it.
