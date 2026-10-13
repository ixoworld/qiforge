/**
 * Test-only Durable Object standing in for `UserOracleDO`'s feedback RPCs:
 * the real `reserveFeedback` + `FeedbackMarkers` over DO SQLite, with a
 * transcript seeded as LangChain messages and run through the real
 * `transformTranscript`. Bound as `FEEDBACK_TEST` by
 * `test/wrangler.test.jsonc`. Not part of the runtime.
 */
import { DurableObject } from 'cloudflare:workers';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DoSqliteDatabase } from '../sqlite/database';
import type { TurnIdentity } from '../do/contracts';
import { transformTranscript } from '../do/transcript';
import type {
  FeedbackReservation,
  FeedbackSettlement,
  FeedbackTarget,
} from './contract';
import { FeedbackMarkers, reserveFeedback } from './reservation';

export interface SeedMessage {
  id: string;
  type: 'human' | 'ai';
  content: string;
}

export class FeedbackTestDO extends DurableObject {
  private db: DoSqliteDatabase | undefined;
  private markers: FeedbackMarkers | undefined;
  private nowMs = Date.parse('2026-10-05T09:00:00.000Z');
  private readonly transcripts = new Map<string, SeedMessage[]>();
  private readonly running = new Set<string>();
  /** Every identity the shell forwarded: the route must name the signed caller. */
  private readonly callers: string[] = [];

  private async ready(): Promise<FeedbackMarkers> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'feedback-test.db');
      this.markers = undefined;
    }
    this.markers ??= new FeedbackMarkers(this.db, () => this.nowMs);
    await this.markers.setup();
    return this.markers;
  }

  async seed(sessionId: string, messages: SeedMessage[]): Promise<void> {
    this.transcripts.set(sessionId, messages);
  }

  async setRunning(sessionId: string, running: boolean): Promise<void> {
    if (running) this.running.add(sessionId);
    else this.running.delete(sessionId);
  }

  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
  }

  async reserveMessageFeedback(
    identity: TurnIdentity,
    target: FeedbackTarget,
  ): Promise<FeedbackReservation> {
    this.callers.push(identity.userDid);
    const markers = await this.ready();
    return reserveFeedback(
      {
        sessionExists: async (sessionId) => this.transcripts.has(sessionId),
        transcript: async (sessionId) =>
          (
            await transformTranscript(
              (this.transcripts.get(sessionId) ?? []).map((m) =>
                m.type === 'human'
                  ? new HumanMessage({ id: m.id, content: m.content })
                  : new AIMessage({ id: m.id, content: m.content }),
              ),
            )
          ).messages,
        runActive: async (sessionId) => this.running.has(sessionId),
        markers,
      },
      target,
    );
  }

  async settleMessageFeedback(
    identity: TurnIdentity,
    target: FeedbackTarget,
    outcome: FeedbackSettlement,
  ): Promise<void> {
    this.callers.push(identity.userDid);
    await (await this.ready()).settle(target, outcome);
  }

  async forgetSession(sessionId: string): Promise<void> {
    await (await this.ready()).forgetSession(sessionId);
  }

  async callerDids(): Promise<string[]> {
    return [...this.callers];
  }

  /** Every row of every table in the database, as text. */
  async dump(): Promise<{ tables: string[]; text: string }> {
    await this.ready();
    const db = this.db!;
    const tables = (
      await db.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
    ).map((t) => t.name);
    const rows: Record<string, unknown[]> = {};
    for (const table of tables)
      rows[table] = await db.exec(`SELECT * FROM "${table}"`);
    return { tables, text: JSON.stringify(rows) };
  }

  async markerStatus(
    sessionId: string,
    messageId: string,
  ): Promise<string | null> {
    await this.ready();
    const row = await this.db!.get<{ status: string }>(
      'SELECT status FROM message_feedback_markers WHERE session_id = ? AND message_id = ?',
      [sessionId, messageId],
    );
    return row?.status ?? null;
  }
}
