/**
 * One-time rename of the room-thread sessions an earlier build of this
 * runtime keyed as `thread:<rootEventId>`. The rule is Node's now: the
 * session id of a room thread IS its root event id (`src/matrix/ingest.ts`),
 * so a reply in a thread opened before the change must find its transcript
 * under the root id, and a reply inside a Portal session's thread must find
 * the Portal session — not a prefixed twin of it.
 *
 * Runs on every boot of a user object and is cheap when there is nothing to
 * do (one indexed read of the sessions table). A legacy row whose root id
 * already names a session (the Portal session the thread was mirrored from)
 * is left as it is: two transcripts cannot be folded into one checkpoint
 * chain, and the row stays reachable in the Portal under its old id.
 *
 * `matrix:<roomId>` sessions — the main timeline of a room, one session per
 * room in that build — have no Node equivalent and are not renamed: they keep
 * their transcript, new room messages simply no longer continue them.
 */
import type { DoSqliteDatabase } from '../sqlite/database';

export const LEGACY_THREAD_SESSION_PREFIX = 'thread:';

/** Every table that keys rows on a session / LangGraph thread id. */
const SESSION_KEYED_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'sessions', column: 'session_id' },
  { table: 'checkpoints', column: 'thread_id' },
  { table: 'writes', column: 'thread_id' },
  { table: 'messages', column: 'thread_id' },
  { table: 'turn_runs', column: 'session_id' },
  { table: 'matrix_turns', column: 'session_id' },
  { table: 'tool_results', column: 'session_id' },
];

export interface ThreadSessionMigrationResult {
  /** Legacy rows renamed to their root event id. */
  renamed: number;
  /** Legacy rows kept because a session with the root id already exists. */
  skipped: number;
}

/**
 * Rename every `thread:<root>` session to `<root>` across the session-keyed
 * tables (each rename in one transaction). The tables must exist: call it
 * after every store's `setup()`.
 */
export async function migrateThreadSessionIds(
  db: DoSqliteDatabase,
  log: Pick<Console, 'log' | 'warn'>,
): Promise<ThreadSessionMigrationResult> {
  const prefix = LEGACY_THREAD_SESSION_PREFIX;
  // substr() rather than LIKE: DO SQL rejects LIKE patterns.
  const legacy = await db.exec<{ session_id: string }>(
    `SELECT session_id FROM sessions WHERE substr(session_id, 1, ?) = ?`,
    [prefix.length, prefix],
  );
  const result: ThreadSessionMigrationResult = { renamed: 0, skipped: 0 };
  if (legacy.length === 0) return result;
  for (const { session_id: legacyId } of legacy) {
    const rootId = legacyId.slice(prefix.length);
    const clash = await db.get<{ one: number }>(
      `SELECT 1 AS one FROM sessions WHERE session_id = ?`,
      [rootId],
    );
    if (clash) {
      result.skipped += 1;
      continue;
    }
    await db.transaction(async () => {
      for (const { table, column } of SESSION_KEYED_TABLES) {
        await db.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [
          rootId,
          legacyId,
        ]);
      }
    });
    result.renamed += 1;
  }
  log.log(
    `[session-ids] ${result.renamed} thread session(s) renamed to their root event id` +
      (result.skipped > 0
        ? `, ${result.skipped} kept (a session with the root id already exists)`
        : ''),
  );
  return result;
}
