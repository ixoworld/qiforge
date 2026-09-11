/**
 * What the user object remembers about each room message it was asked to
 * answer, so the gateway can ask again after a reset without the turn ever
 * running twice (`src/matrix/inbox-store.ts` is the asking side).
 *
 * One row per Matrix event id, in the user's own SQLite next to the
 * checkpoints: `started_at` is written before the turn runs, `reply_text` +
 * `answered_at` when it has finished. A second request for the same event:
 *
 * - answered → the stored text is returned; no model, no tools;
 * - running in this instance → the caller attaches to the running turn
 *   (kept in memory by the object, not here);
 * - started, not answered, not running → the object itself reset mid-turn;
 *   tools may have run, so the turn is NOT re-run: the request is refused
 *   with `TURN_INTERRUPTED_MARKER` and the gateway tells the user to try
 *   again — the same thing that happens today when the object dies while
 *   the gateway is alive;
 * - unknown → run once.
 *
 * Rows older than `RETENTION_MS` are pruned at setup; a replay that late
 * cannot happen (the gateway inbox gives up after `MAX_TURN_REPLAYS`).
 */
import type { DoSqliteDatabase } from '../sqlite/database';

export interface MatrixTurnRecord {
  eventId: string;
  sessionId: string;
  requestId: string;
  startedAt: string;
  answeredAt: string | null;
  replyText: string | null;
}

export type MatrixTurnDecision = 'run' | 'answered' | 'interrupted';

/** Rows are kept for a week; the gateway never replays anything that old. */
export const RETENTION_MS = 7 * 24 * 3600 * 1000;

export function decideMatrixTurn(
  existing: MatrixTurnRecord | undefined,
): MatrixTurnDecision {
  if (!existing) return 'run';
  return existing.replyText !== null ? 'answered' : 'interrupted';
}

type LedgerRow = {
  event_id: string;
  session_id: string;
  request_id: string;
  started_at: string;
  answered_at: string | null;
  reply_text: string | null;
} & Record<string, string | null>;

export class MatrixTurnLedger {
  private setupPromise: Promise<void> | undefined;

  constructor(
    readonly db: DoSqliteDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS matrix_turns (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        answered_at TEXT,
        reply_text TEXT
      )`);
    await this.db.run(`DELETE FROM matrix_turns WHERE started_at < ?`, [
      new Date(this.now() - RETENTION_MS).toISOString(),
    ]);
  }

  async get(eventId: string): Promise<MatrixTurnRecord | undefined> {
    await this.setup();
    const row = await this.db.get<LedgerRow>(
      `SELECT event_id, session_id, request_id, started_at, answered_at, reply_text
       FROM matrix_turns WHERE event_id = ?`,
      [eventId],
    );
    if (!row) return undefined;
    return {
      eventId: row.event_id,
      sessionId: row.session_id,
      requestId: row.request_id,
      startedAt: row.started_at,
      answeredAt: row.answered_at,
      replyText: row.reply_text,
    };
  }

  /** Mark the turn as started. Durable before any model or tool runs. */
  async start(
    eventId: string,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    await this.setup();
    await this.db.run(
      `INSERT OR IGNORE INTO matrix_turns (event_id, session_id, request_id, started_at)
       VALUES (?, ?, ?, ?)`,
      [eventId, sessionId, requestId, new Date(this.now()).toISOString()],
    );
  }

  /** Record the reply; from now on the event is answered, never re-run. */
  async answer(eventId: string, replyText: string): Promise<void> {
    await this.setup();
    await this.db.run(
      `UPDATE matrix_turns SET reply_text = ?, answered_at = ? WHERE event_id = ?`,
      [replyText, new Date(this.now()).toISOString(), eventId],
    );
  }
}
