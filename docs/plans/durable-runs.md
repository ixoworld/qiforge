# Durable runs for the Workers runtime

Agreed with Michael on 2026-09-13. Every turn becomes a **run** the user
object records before it starts, keeps notes on while it runs, and can pick
up again after a platform reset — without ever repeating a side effect. A
browser that leaves does not stop the run; a client that comes back re-joins
the stream where it left off.

## Guarantees

1. A run survives the client disconnecting. Only `POST /messages/abort` or a
   superseding message on the same session stops it.
2. A run survives a reset of the user object. The object is woken by its
   alarm (20 s keep-alive), finds the run still marked running, restores the
   partial output from the packed segments and continues from the last
   checkpoint. Four consecutive attempts without progress (a new checkpoint)
   with delays 5 s, 15 s, 30 s, 60 s; then the run is closed as interrupted
   with the friendly notice. Progress resets the counter.
3. A side-effecting tool call is executed at most once. Every tool call is
   marked in SQLite before it runs. On resume a started-but-unfinished call
   is never re-executed: the model receives a synthetic "interrupted, outcome
   unknown" result. Read-only tools (declared by the plugin or by MCP
   `readOnlyHint`/`idempotentHint`) may run again.
4. A client can re-join a run: `GET /runs/:runId?after=<seq>` replays the
   segments after the cursor and attaches to the live stream. The `done`
   frame, not the connection, marks the end of a turn.
5. Per-session multitask rule: `interrupt` (default, Node parity) or
   `enqueue` (`multitask` on the turn body; `TURN_MULTITASK_DEFAULT` env).
6. Headless runs (Matrix room turns, scheduled task runs) get the same
   record, keep-alive, segments and recovery; a task run interrupted by a
   reset is resumed and then delivered, instead of being closed.

## Storage (all in the user's SQLite, hot rows)

| Table               | Rows per turn                                                               | Purpose                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turn_runs`         | 1 insert + ~2 updates                                                       | run id, session, request, client, status, the request needed to resume (identity, message, model, metadata, room/thread/event), attempts, checkpoint id at the last attempt, partial text on abort/interrupt |
| `turn_run_segments` | ~1 per 2 s of streaming + 1 on every settled tool event, deleted at cutover | packed frames `[seq_from, seq_to]` so a re-join and a recovery can restore the exact output                                                                                                                  |
| `turn_tool_marks`   | 1 insert + 1 update per tool call                                           | `started`/`done` per tool call id with the tool's effect                                                                                                                                                     |

Cost at the agreed profile (10 turns/day, 4 tool calls/turn): ≈ 25 rows per
turn ≈ $0.0075 per user per month at $1 per million rows written or deleted.

## Alarms and memory (performance)

- One multiplexed alarm, as today. While runs are active the object holds a
  20 s keep-alive: the alarm is re-armed only when it is within 5 s of
  expiry (≈ one storage write per 15 s of active turn, coalesced across runs).
- Recovery runs on the very next request as well as on the alarm, so a
  connected client triggers it immediately.
- The in-memory buffer holds only the unflushed tail (≤ `RUN_SEGMENT_BYTES`);
  a re-join reads older segments from SQLite in pages.
- No tier pass over an active or recovering run (same guard as the flush).

## Env knobs

| Var                      | Default                | Meaning                                             |
| ------------------------ | ---------------------- | --------------------------------------------------- |
| `RUN_KEEPALIVE_MS`       | 20000                  | keep-alive alarm horizon while a run is active      |
| `RUN_SEGMENT_FLUSH_MS`   | 2000                   | max age of unflushed output before it is packed     |
| `RUN_SEGMENT_BYTES`      | 16384                  | max unflushed bytes before it is packed             |
| `RUN_RECOVERY_ATTEMPTS`  | 4                      | consecutive no-progress attempts before interrupted |
| `RUN_RECOVERY_DELAYS_MS` | 5000,15000,30000,60000 | delay before each attempt                           |
| `TURN_MULTITASK_DEFAULT` | interrupt              | `interrupt` or `enqueue`                            |

## Wire

- `POST /messages/:sessionId` (stream): first frame `run` `{ runId, seq: 0 }`;
  every frame carries `seq`; `done` carries `{ runId, messageId }`.
- `GET /runs/:runId?after=<seq>`: SSE; replays segments `> after`, attaches
  live, ends with `done`; 404 unknown run; a finished run replays and ends.
- `GET /sessions/:sessionId/run`: the active or queued run of a session, if any.
- `POST /messages/abort`: marks the run aborted; partial text kept on the row.
- `GET /debug/runs`: runs, marks, segment counts (debug routes only).

## Recovery (object boot and alarm)

1. `turn_runs` rows in `running`/`recovering` at boot are orphans (every boot
   is a new instance). Schedule attempt N at `now + delay[N]`.
2. Attempt: rebuild the `TurnRequest` from the row; restore output from the
   segments; if the checkpoint id changed since the last attempt, reset the
   counter; invoke the graph with no new input (LangGraph resumes from the
   checkpoint's pending node); the tool-mark middleware answers started
   write calls as interrupted and lets read calls run; the first model call
   after a resume gets a continuation note carrying the partial text tail.
3. Success: the normal completion path (after-turn work, room mirror, task
   delivery). Failure: attempt N+1 or `interrupted` after the cap.

## Files

- `src/do/run-store.ts` (+ workerd test) — tables and pure decision helpers.
- `src/do/run-buffer.ts` (+ core test) — frame buffer, packing, subscribers.
- `src/do/sse-stream.ts` — frame producer writes into a run buffer; HTTP
  responses subscribe; cancel = unsubscribe.
- `src/core/middlewares/tool-marks.ts` (+ core test) — write-ahead marks,
  resume policy, continuation note.
- `src/do/user-oracle-do.ts` — run lifecycle, keep-alive, recovery, join,
  abort, enqueue, task-run completion after recovery.
- `src/tasks/scheduler.ts` — do not close a recoverable run; deliver after it.
- `src/shell/app.ts` — join route, session run route, debug route.
- `apps/qiforge-workers-example/test/e2e.ts` — drills; `test/devnet-features.ts`
  — the same against the deployed worker.
- `packages/oracles-client-sdk` — run id, cursor, re-join, no re-POST.
