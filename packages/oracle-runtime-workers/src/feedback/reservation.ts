/**
 * The user object's half of anonymous feedback: check the message the
 * feedback is about, apply the user's own submission limit, and keep the
 * idempotency marker that makes one Agent message produce at most one issue.
 *
 * Only ids, a status and timestamps are stored — never the feedback text,
 * which stays in the shell for the length of one request.
 */
import type { DoSqliteDatabase } from '../sqlite/database';
import type { MessageDto } from '../do/transcript';
import type {
  FeedbackReservation,
  FeedbackSettlement,
  FeedbackTarget,
} from './contract';

/** Submissions one user may start per window (the Node runtime's 3 per minute). */
export const FEEDBACK_USER_LIMIT = 3;
export const FEEDBACK_WINDOW_MS = 60_000;
/**
 * A reservation the shell never settled (its isolate died mid-delivery) is
 * reclaimed after this. Longer than the sink can take (three attempts of at
 * most 8 s plus waits); the sink's own marker lookup stops a reclaimed
 * delivery from creating a second issue.
 */
export const FEEDBACK_PENDING_STALE_MS = 2 * 60_000;

interface MarkerRow extends Record<string, string | number | null> {
  submission_id: string;
  previous_submission_id: string | null;
  status: string;
  reserved_at: number;
  submitted_at: string;
}

/**
 * A completed Agent reply: an `ai` message of the transcript that is not
 * part of the turn still running in the session. The listing marks every
 * stored message complete, so the in-flight turn is told apart by position:
 * while a run is active, everything after the last user message belongs to it.
 */
export function isCompletedAgentMessage(
  messages: readonly MessageDto[],
  messageId: string,
  runActive: boolean,
): boolean {
  const index = messages.findIndex((m) => m.id === messageId);
  const message = index === -1 ? undefined : messages[index];
  if (!message || message.type !== 'ai' || message.isComplete === false)
    return false;
  return (
    !runActive || messages.slice(index + 1).some((m) => m.type === 'human')
  );
}

/**
 * A column of a feedback table. `add` is the `ALTER TABLE … ADD COLUMN`
 * definition for a column added after the table first shipped; a column
 * without one was in the first shape (a key or NOT NULL column SQLite cannot
 * add in place), so a table lacking it is not one this runtime made.
 */
interface ColumnSpec {
  name: string;
  add?: string;
}

const MARKER_COLUMNS: readonly ColumnSpec[] = [
  { name: 'session_id' },
  { name: 'message_id' },
  { name: 'submission_id' },
  { name: 'status' },
  { name: 'reserved_at' },
  { name: 'submitted_at' },
  { name: 'previous_submission_id', add: 'TEXT' },
];

const ATTEMPT_COLUMNS: readonly ColumnSpec[] = [{ name: 'at' }];

/** Add the columns an older table lacks; idempotent. */
async function ensureColumns(
  db: DoSqliteDatabase,
  table: string,
  columns: readonly ColumnSpec[],
): Promise<void> {
  const present = new Set(
    (await db.exec<{ name: string }>(`PRAGMA table_info(${table})`)).map(
      (column) => column.name,
    ),
  );
  for (const column of columns) {
    if (present.has(column.name)) continue;
    if (column.add === undefined)
      throw new Error(
        `${table} lacks the column ${column.name}, which cannot be added in place`,
      );
    await db.run(
      `ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.add}`,
    );
  }
}

export class FeedbackMarkers {
  private setupPromise: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DoSqliteDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  setup(): Promise<void> {
    this.setupPromise ??= (async () => {
      await this.db.run(`CREATE TABLE IF NOT EXISTS message_feedback_markers (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        -- the submission whose stale reservation this one took over, if any
        previous_submission_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
        reserved_at INTEGER NOT NULL,
        submitted_at TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      )`);
      await this.db.run(`CREATE TABLE IF NOT EXISTS message_feedback_attempts (
        at INTEGER NOT NULL
      )`);
      // CREATE TABLE IF NOT EXISTS leaves a table an older build created as
      // it was: bring every column up to the current shape.
      await ensureColumns(this.db, 'message_feedback_markers', MARKER_COLUMNS);
      await ensureColumns(
        this.db,
        'message_feedback_attempts',
        ATTEMPT_COLUMNS,
      );
    })().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  /** Reservations and settlements run one at a time. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Reserve delivery for a message the caller has already validated. A
   * replay of the delivered submission answers with it again; other
   * feedback for the same message is a conflict; only a fresh reservation
   * counts against the user's limit.
   */
  reserve(
    target: FeedbackTarget,
  ): Promise<Exclude<FeedbackReservation, { kind: 'not_found' }>> {
    return this.serialize(async () => {
      await this.setup();
      return this.db.transaction(async () => {
        const now = this.now();
        const existing = await this.db.get<MarkerRow>(
          `SELECT submission_id, previous_submission_id, status, reserved_at, submitted_at
             FROM message_feedback_markers
            WHERE session_id = ? AND message_id = ?`,
          [target.sessionId, target.messageId],
        );
        if (existing?.status === 'delivered')
          return existing.submission_id === target.submissionId
            ? { kind: 'delivered', submittedAt: existing.submitted_at }
            : { kind: 'conflict' };
        const sameSubmission = existing?.submission_id === target.submissionId;
        if (existing && now - existing.reserved_at < FEEDBACK_PENDING_STALE_MS)
          return sameSubmission ? { kind: 'in_flight' } : { kind: 'conflict' };

        await this.db.run(
          'DELETE FROM message_feedback_attempts WHERE at <= ?',
          [now - FEEDBACK_WINDOW_MS],
        );
        const recent = await this.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM message_feedback_attempts',
        );
        if ((recent?.n ?? 0) >= FEEDBACK_USER_LIMIT)
          return { kind: 'rate_limited' };
        await this.db.run(
          'INSERT INTO message_feedback_attempts (at) VALUES (?)',
          [now],
        );

        // A stale reservation of another submission may have created the
        // issue before its isolate died; remember whose it was, so the shell
        // never reports this submission as delivered when it sent nothing.
        const previous = existing
          ? sameSubmission
            ? existing.previous_submission_id
            : existing.submission_id
          : null;
        const submittedAt = new Date(now).toISOString();
        await this.db.run(
          `INSERT OR REPLACE INTO message_feedback_markers
             (session_id, message_id, submission_id, previous_submission_id,
              status, reserved_at, submitted_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          [
            target.sessionId,
            target.messageId,
            target.submissionId,
            previous,
            now,
            submittedAt,
          ],
        );
        return {
          kind: 'reserved',
          submittedAt,
          replacesOtherSubmission: previous !== null,
        };
      });
    });
  }

  /**
   * Settle this submission's reservation:
   * - `delivered`: its issue exists — the marker is kept for good;
   * - `superseded`: the issue that exists is the earlier submission's, so
   *   the marker is kept under that submission and this one becomes a
   *   conflict on any retry;
   * - `released`: delivery failed — the marker is removed so the user can
   *   try again.
   */
  settle(target: FeedbackTarget, outcome: FeedbackSettlement): Promise<void> {
    return this.serialize(async () => {
      await this.setup();
      const match = [target.sessionId, target.messageId, target.submissionId];
      switch (outcome) {
        case 'delivered':
          await this.db.run(
            `UPDATE message_feedback_markers SET status = 'delivered'
              WHERE session_id = ? AND message_id = ? AND submission_id = ?`,
            match,
          );
          return;
        case 'superseded':
          await this.db.run(
            `UPDATE message_feedback_markers
                SET status = 'delivered',
                    submission_id = COALESCE(previous_submission_id, submission_id)
              WHERE session_id = ? AND message_id = ? AND submission_id = ?`,
            match,
          );
          return;
        case 'released':
          await this.db.run(
            `DELETE FROM message_feedback_markers
              WHERE session_id = ? AND message_id = ? AND submission_id = ?
                AND status = 'pending'`,
            match,
          );
          return;
      }
    });
  }

  /** A deleted session's markers go with it. */
  forgetSession(sessionId: string): Promise<void> {
    return this.serialize(async () => {
      await this.setup();
      await this.db.run(
        'DELETE FROM message_feedback_markers WHERE session_id = ?',
        [sessionId],
      );
    });
  }
}

/** What {@link reserveFeedback} needs from the user object. */
export interface FeedbackReservationHost {
  sessionExists(sessionId: string): Promise<boolean>;
  transcript(sessionId: string): Promise<MessageDto[]>;
  runActive(sessionId: string): Promise<boolean>;
  markers: FeedbackMarkers;
}

/** Validate the target against the user's own database, then reserve. */
export async function reserveFeedback(
  host: FeedbackReservationHost,
  target: FeedbackTarget,
): Promise<FeedbackReservation> {
  if (!(await host.sessionExists(target.sessionId)))
    return { kind: 'not_found' };
  const [messages, runActive] = await Promise.all([
    host.transcript(target.sessionId),
    host.runActive(target.sessionId),
  ]);
  if (!isCompletedAgentMessage(messages, target.messageId, runActive))
    return { kind: 'not_found' };
  return host.markers.reserve(target);
}
