# Portal History Serving Fix

Users on the portal web app see compacted chat history — a summary plus recent
messages — instead of the full transcript for older sessions. Reported after
the 2026-08-20 Companion deploy.

## Constraint (decided)

The summarization middleware **stays**. It bounds model context and checkpoint
size (removing it reintroduces the unbounded-state growth fixed in ORA-382 and
hands long threads to the token limiter's hard truncation). After this fix it
must be invisible to users: summarization compacts what the _model_ sees,
never what the _user_ sees.

## What we already know

- The portal reads history through `@ixo/oracles-client-sdk` `use-chat` v2 →
  `GET <apiUrl>/messages/<sessionId>` (`use-chat.ts:104`).
- That endpoint (`messages.service.ts:203`, `listMessages`) deliberately reads
  the **full transcript** from the saver's `messages` table via
  `listThreadMessages`, filtering only the summary bookkeeping message
  (`isSummarizationMessage`). The `messages` table is never pruned and never
  touched by summarization.
- Forensics on a real prod DB (the ORA-382 incident file, legacy pod,
  2026-08-18) showed the `messages` table holding the complete March→August
  transcript for all 17 sessions. The data layer retained history under
  summarization on that pod.

So the compacted view means one specific layer is lying, and a 30-minute
diagnosis identifies which.

## Diagnosis (gate — run before any fix)

Pick one affected `sessionId` + `userDid` from a user report. On the pod
(read-only, `node:sqlite`):

```bash
DB="<SQLITE_DATABASE_PATH>/user_dbs/<userDid>/<storageKey>.db"
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$DB', { readOnly: true });
const rows = db.prepare('SELECT COUNT(*) n, MIN(created_at) a, MAX(created_at) b FROM messages WHERE thread_id = ?').get('<sessionId>');
console.log(rows);
db.close();"
```

Compare against (1) what the portal renders and (2) the endpoint's actual
response (`curl` with a valid UCAN invocation, or replay through the SDK).

| Observation                                                | Branch                  |
| ---------------------------------------------------------- | ----------------------- |
| Table row count ≈ what the portal shows (rows are missing) | **A — write-path gap**  |
| Table has full history, endpoint returns less              | **B — endpoint defect** |
| Endpoint returns full history, portal shows less           | **C — client defect**   |

## Fix branches

### A — write-path gap (table rows missing)

Older turns never landed in the `messages` table for the affected era/threads.
History is **not lost**: every user and assistant message was replayed into
the session's Matrix room thread.

- Identify affected threads: sessions whose `MIN(messages.created_at)` is
  materially later than the session's `created_at` (query over `sessions` ×
  `messages`).
- Backfill: for each affected thread, page the Matrix room thread timeline
  (session id = thread root event id), map events back to message rows, and
  `INSERT OR IGNORE` by `message_id` (never REPLACE — existing rows win).
  Runs as a one-time admin task, per-user, behind the existing
  `markUserActive` guards.
- Find and fix why the write path skipped them (saver `put()` messages loop —
  e.g. messages without ids, or an era before the table existed), with a
  regression test that a put persists every message id it is handed.

### B — endpoint defect

`listThreadMessages` ordering/filtering or
`transformGraphStateMessageToListMessageResponse` drops rows, or the deployed
image predates the transcript-read (shipped 2026-07-06, #216). Fix in place;
pin with a unit test: a thread whose state was summarized (summary row +
tail in latest checkpoint, full set in `messages` table) must list every
non-bookkeeping message.

### C — client defect

The portal pins an SDK version that reads a different surface, or paginates
and never fetches older pages. Fix in the portal/SDK; add the same-shape
assertion to the SDK's tests.

## Delivery

One hotfix PR on the branch that the diagnosis selects (A also ships the
backfill task). Update `docs/architecture/matrix-and-checkpointer.md` only if
branch A changes write-path behavior.
