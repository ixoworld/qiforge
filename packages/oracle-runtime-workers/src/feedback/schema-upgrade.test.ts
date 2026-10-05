/**
 * Feedback tables created by an older build: `setup()` brings them up to
 * the current shape in place, so a user object never fails a reservation
 * with "no such column" after an upgrade.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DoSqliteDatabase } from '../sqlite/database';
import { FeedbackMarkers } from './reservation';

/** The table as the first build of the feature created it. */
const FIRST_MARKERS_SHAPE = `CREATE TABLE message_feedback_markers (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
  reserved_at INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
)`;

const NOW = Date.parse('2026-10-05T09:00:00.000Z');
const target = {
  sessionId: 's-1',
  messageId: 'm-1',
  submissionId: '8103aeac-96e5-441b-9f87-000000000001',
};

async function withDb(
  name: string,
  body: (db: DoSqliteDatabase) => Promise<void>,
): Promise<void> {
  const stub = env.SQLITE_TEST.get(env.SQLITE_TEST.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    const db = await DoSqliteDatabase.open(state, `${name}.db`);
    try {
      await body(db);
    } finally {
      await db.close();
    }
  });
}

const columnsOf = async (db: DoSqliteDatabase, table: string) =>
  (await db.exec<{ name: string }>(`PRAGMA table_info(${table})`)).map(
    (c) => c.name,
  );

describe('FeedbackMarkers on a table from an older build', () => {
  it('adds the missing column, keeps the old rows, and reserves through the real store', async () => {
    await withDb('feedback-old-shape', async (db) => {
      await db.run(FIRST_MARKERS_SHAPE);
      await db.run(
        `INSERT INTO message_feedback_markers
           (session_id, message_id, submission_id, status, reserved_at, submitted_at)
         VALUES ('s-0', 'm-0', 'old-submission', 'delivered', 1, '2026-10-01T00:00:00.000Z')`,
      );
      expect(await columnsOf(db, 'message_feedback_markers')).not.toContain(
        'previous_submission_id',
      );

      const markers = new FeedbackMarkers(db, () => NOW);
      expect(await markers.reserve(target)).toEqual({
        kind: 'reserved',
        submittedAt: '2026-10-05T09:00:00.000Z',
        replacesOtherSubmission: false,
      });
      await markers.settle(target, 'delivered');

      expect(await columnsOf(db, 'message_feedback_markers')).toContain(
        'previous_submission_id',
      );
      expect(
        await db.exec(
          'SELECT session_id, submission_id, previous_submission_id, status FROM message_feedback_markers ORDER BY session_id',
        ),
      ).toEqual([
        {
          session_id: 's-0',
          submission_id: 'old-submission',
          previous_submission_id: null,
          status: 'delivered',
        },
        {
          session_id: 's-1',
          submission_id: target.submissionId,
          previous_submission_id: null,
          status: 'delivered',
        },
      ]);
      // The old row is answered like any delivered submission.
      expect(
        await markers.reserve({
          sessionId: 's-0',
          messageId: 'm-0',
          submissionId: 'old-submission',
        }),
      ).toEqual({
        kind: 'delivered',
        submittedAt: '2026-10-01T00:00:00.000Z',
      });

      // Idempotent: a second store over the upgraded table changes nothing.
      await new FeedbackMarkers(db, () => NOW).setup();
      expect(
        (await columnsOf(db, 'message_feedback_markers')).filter(
          (c) => c === 'previous_submission_id',
        ),
      ).toHaveLength(1);
    });
  });

  it('refuses a table missing a column that cannot be added in place, naming it', async () => {
    await withDb('feedback-foreign-shape', async (db) => {
      await db.run(
        'CREATE TABLE message_feedback_attempts (attempted INTEGER NOT NULL)',
      );
      await expect(new FeedbackMarkers(db).setup()).rejects.toThrow(
        'message_feedback_attempts lacks the column at, which cannot be added in place',
      );
    });
  });
});
