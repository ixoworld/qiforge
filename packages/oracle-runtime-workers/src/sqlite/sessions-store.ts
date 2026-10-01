/**
 * `sessions` table access — the Workers counterpart of the Node runtime's
 * `SessionManagerService` SQL. Same table (created with the same DDL the Node
 * runtime uses, so files round-trip between runtimes):
 *
 *   sessions(session_id PK, title, last_updated_at, created_at, oracle_name,
 *            oracle_did, oracle_entity_did, last_processed_count,
 *            user_context, room_id, slack_thread_ts)
 *
 * Title generation and Matrix side effects are NOT here — those belong to the
 * turn pipeline; this store only owns the rows.
 */
import type { DoSqliteDatabase, SqlParam } from './database';

export interface SessionRecord {
  sessionId: string;
  title?: string;
  lastUpdatedAt: string;
  createdAt: string;
  oracleName: string;
  oracleDid: string;
  oracleEntityDid: string;
  lastProcessedCount?: number;
  userContext?: Record<string, unknown>;
  roomId?: string;
  slackThreadTs?: string;
}

export interface CreateSessionInput {
  sessionId: string;
  oracleName: string;
  oracleDid: string;
  oracleEntityDid: string;
  title?: string;
  roomId?: string;
  slackThreadTs?: string;
  userContext?: Record<string, unknown>;
  lastProcessedCount?: number;
}

export interface TouchSessionInput {
  lastProcessedCount?: number;
  /** Omit to keep the stored value (callers that don't own the Slack binding). */
  slackThreadTs?: string;
}

export interface ListSessionsResult {
  sessions: SessionRecord[];
  total: number;
}

export const UNTITLED_SESSION = 'Untitled';

type SessionRow = {
  session_id: string;
  title: string | null;
  last_updated_at: string;
  created_at: string;
  oracle_name: string;
  oracle_did: string;
  oracle_entity_did: string;
  last_processed_count: number | null;
  user_context: string | null;
  room_id: string | null;
  slack_thread_ts: string | null;
};

type SessionRowWithTotal = SessionRow & { total: number };

const SESSION_COLUMNS = `session_id, title, last_updated_at, created_at, oracle_name,
  oracle_did, oracle_entity_did, last_processed_count, user_context, room_id, slack_thread_ts`;

function rowToSession(row: SessionRow): SessionRecord {
  const session: SessionRecord = {
    sessionId: row.session_id,
    lastUpdatedAt: row.last_updated_at,
    createdAt: row.created_at,
    oracleName: row.oracle_name,
    oracleDid: row.oracle_did,
    oracleEntityDid: row.oracle_entity_did,
  };
  if (row.title !== null) session.title = row.title;
  if (row.last_processed_count !== null)
    session.lastProcessedCount = row.last_processed_count;
  if (row.user_context !== null)
    session.userContext = parseUserContext(row.user_context);
  if (row.room_id !== null) session.roomId = row.room_id;
  if (row.slack_thread_ts !== null) session.slackThreadTs = row.slack_thread_ts;
  return session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUserContext(json: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class SessionsStore {
  private setupPromise: Promise<void> | undefined;

  constructor(readonly db: DoSqliteDatabase) {}

  /** Create the table + index (same DDL as the Node runtime). Idempotent. */
  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        last_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        oracle_name TEXT NOT NULL,
        oracle_did TEXT NOT NULL,
        oracle_entity_did TEXT NOT NULL,
        last_processed_count INTEGER,
        user_context TEXT,
        room_id TEXT,
        slack_thread_ts TEXT
      )`);
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(last_updated_at)`,
    );
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    await this.setup();
    const now = new Date().toISOString();
    const session: SessionRecord = {
      sessionId: input.sessionId,
      title: input.title ?? UNTITLED_SESSION,
      lastUpdatedAt: now,
      createdAt: now,
      oracleName: input.oracleName,
      oracleDid: input.oracleDid,
      oracleEntityDid: input.oracleEntityDid,
    };
    if (input.lastProcessedCount !== undefined)
      session.lastProcessedCount = input.lastProcessedCount;
    if (input.userContext !== undefined)
      session.userContext = input.userContext;
    if (input.roomId !== undefined) session.roomId = input.roomId;
    if (input.slackThreadTs !== undefined)
      session.slackThreadTs = input.slackThreadTs;
    await this.db.run(
      `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.sessionId,
        session.title ?? null,
        session.lastUpdatedAt,
        session.createdAt,
        session.oracleName,
        session.oracleDid,
        session.oracleEntityDid,
        session.lastProcessedCount ?? null,
        session.userContext !== undefined
          ? JSON.stringify(session.userContext)
          : null,
        session.roomId ?? null,
        session.slackThreadTs ?? null,
      ],
    );
    return session;
  }

  /**
   * Newest first; `roomId` restricts to one room; `excludeIdPrefix` hides
   * rows whose id starts with it (the host's task-run sessions, which the
   * Node runtime likewise keeps out of the user's session list). `total`
   * counts all matching rows.
   */
  async listSessions(
    roomId?: string,
    limit = 20,
    offset = 0,
    excludeIdPrefix?: string,
  ): Promise<ListSessionsResult> {
    await this.setup();
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (roomId !== undefined) {
      clauses.push('room_id = ?');
      params.push(roomId);
    }
    if (excludeIdPrefix !== undefined && excludeIdPrefix.length > 0) {
      // substr() rather than LIKE: DO SQL rejects LIKE patterns.
      clauses.push('substr(session_id, 1, ?) <> ?');
      params.push(excludeIdPrefix.length, excludeIdPrefix);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit, offset);
    const rows = await this.db.exec<SessionRowWithTotal>(
      `SELECT ${SESSION_COLUMNS}, COUNT(*) OVER() AS total
       FROM sessions ${where}
       ORDER BY last_updated_at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
      params,
    );
    return { sessions: rows.map(rowToSession), total: rows[0]?.total ?? 0 };
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    await this.setup();
    const row = await this.db.get<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`,
      [sessionId],
    );
    return row === undefined ? undefined : rowToSession(row);
  }

  /** Bump `last_updated_at` (and optionally the processed count / Slack thread). Returns the updated row. */
  /**
   * Advance the history-indexing watermark WITHOUT bumping `last_updated_at`
   * (which `touchSession` does and which would reorder the session list).
   * The same `last_processed_count` column the Node runtime keeps, so a
   * migrated file continues where it left off in either direction.
   */
  async setLastProcessedCount(sessionId: string, count: number): Promise<void> {
    await this.setup();
    await this.db.exec(
      'UPDATE sessions SET last_processed_count = ? WHERE session_id = ?',
      [count, sessionId],
    );
  }

  async touchSession(
    sessionId: string,
    patch: TouchSessionInput = {},
  ): Promise<SessionRecord | undefined> {
    await this.setup();
    const now = new Date().toISOString();
    const sets = ['last_updated_at = ?'];
    const params: SqlParam[] = [now];
    if (patch.lastProcessedCount !== undefined) {
      sets.push('last_processed_count = ?');
      params.push(patch.lastProcessedCount);
    }
    if (patch.slackThreadTs !== undefined) {
      sets.push('slack_thread_ts = ?');
      params.push(patch.slackThreadTs);
    }
    params.push(sessionId);
    const { changes } = await this.db.run(
      `UPDATE sessions SET ${sets.join(', ')} WHERE session_id = ?`,
      params,
    );
    if (changes === 0) return undefined;
    return this.getSession(sessionId);
  }

  /**
   * Set the title. With `onlyIfUntitled`, the write is conditional on the row
   * still holding the placeholder — the cross-process guard the Node runtime
   * uses so a concurrent generation doesn't overwrite the winner's title.
   * Returns whether a row changed.
   */
  async setTitle(
    sessionId: string,
    title: string,
    options: { onlyIfUntitled?: boolean } = {},
  ): Promise<boolean> {
    await this.setup();
    const guard = options.onlyIfUntitled
      ? ` AND (title IS NULL OR trim(title) = '' OR lower(title) = '${UNTITLED_SESSION.toLowerCase()}')`
      : '';
    const { changes } = await this.db.run(
      `UPDATE sessions SET title = ? WHERE session_id = ?${guard}`,
      [title, sessionId],
    );
    return changes > 0;
  }

  /**
   * Delete the session and — because the session id doubles as the LangGraph
   * thread id — its checkpointer rows (`checkpoints`, `writes`, `messages`),
   * in one transaction. The checkpointer tables are created on the first graph
   * turn, so only the ones that exist are touched. Returns whether a session
   * row existed.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    await this.setup();
    const tables = await this.db.exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkpoints', 'writes', 'messages')`,
    );
    return this.db.transaction(async () => {
      const { changes } = await this.db.run(
        'DELETE FROM sessions WHERE session_id = ?',
        [sessionId],
      );
      for (const { name } of tables) {
        await this.db.run(`DELETE FROM ${name} WHERE thread_id = ?`, [
          sessionId,
        ]);
      }
      return changes > 0;
    });
  }
}
