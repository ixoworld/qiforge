/**
 * Test-only Durable Object driving `RunStore` over a real DO-backed SQLite
 * inside workerd. Bound as `RUN_STORE_TEST` by `test/wrangler.test.jsonc`.
 * Not part of the runtime.
 */
import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import type { RunSummary } from './contracts';
import type { PackedSegment } from './run-buffer';
import { RunCoordinator } from './run-coordinator';
import { runSummaryOf } from './run-request';
import {
  RunStore,
  runDurabilityConfig,
  type RunRecord,
  type ToolMark,
  type WriteClaimRecord,
} from './run-store';

export class RunStoreTestDO extends DurableObject {
  private db: DoSqliteDatabase | undefined;

  private store: RunStore | undefined;

  private nowMs = Date.parse('2026-09-13T10:00:00.000Z');

  private async runStore(): Promise<RunStore> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'runs-test.db');
      this.store = undefined;
    }
    this.store ??= new RunStore(this.db, () => this.nowMs);
    return this.store;
  }

  async setNow(ms: number): Promise<void> {
    this.nowMs = ms;
  }

  /** Run raw SQL on the store's database before/around the store (migration tests). */
  async rawRun(sql: string): Promise<void> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'runs-test.db');
      this.store = undefined;
    }
    await this.db.run(sql);
  }

  async columnsOf(table: string): Promise<string[]> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'runs-test.db');
      this.store = undefined;
    }
    const rows = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(${table})`,
    );
    return rows.map((r) => r.name);
  }

  async create(input: Parameters<RunStore['create']>[0]): Promise<void> {
    await (await this.runStore()).create(input);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    return (await this.runStore()).get(runId);
  }

  async wasChannelRunPruned(runId: string): Promise<boolean> {
    return (await this.runStore()).wasChannelRunPruned(runId);
  }

  /**
   * Begin a run through a `RunCoordinator` over this SQLite store, let its
   * one attempt finish with `reply`, and report what the coordinator handed
   * `onRunEnded` and what the row holds afterwards.
   */
  async coordinateRun(input: {
    runId: string;
    client: RunRecord['client'];
    reply: string;
  }): Promise<{
    endedClient: RunRecord['client'];
    stored: RunRecord | undefined;
    summary: RunSummary | undefined;
  }> {
    const store = await this.runStore();
    let ended!: (record: RunRecord) => void;
    const endedRecord = new Promise<RunRecord>((resolve) => {
      ended = resolve;
    });
    const runs = new RunCoordinator({
      store,
      config: runDurabilityConfig({}),
      instanceId: 'coordinator-test',
      log: {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      now: () => this.nowMs,
      requestAlarm: () => undefined,
      runAttempt: async () => ({
        status: 'finished',
        text: input.reply,
        messageId: `msg-${input.runId}`,
      }),
      checkpointIdOf: async () => null,
      onRunEnded: async (record) => ended(record),
    });
    await runs.begin({
      runId: input.runId,
      sessionId: `$session-${input.runId}`,
      requestId: `req-${input.runId}`,
      client: input.client,
      request: '{}',
      multitask: 'enqueue',
    });
    const record = await endedRecord;
    const stored = await store.get(input.runId);
    return {
      endedClient: record.client,
      stored,
      summary: stored ? runSummaryOf(stored) : undefined,
    };
  }

  async listRecent(): Promise<RunRecord[]> {
    return (await this.runStore()).listRecent();
  }

  async update(
    runId: string,
    patch: Parameters<RunStore['update']>[1],
  ): Promise<void> {
    await (await this.runStore()).update(runId, patch);
  }

  async activeForSession(sessionId: string): Promise<RunRecord | undefined> {
    return (await this.runStore()).activeForSession(sessionId);
  }

  async listActive(): Promise<RunRecord[]> {
    return (await this.runStore()).listActive();
  }

  async queuedForSession(sessionId: string): Promise<RunRecord[]> {
    return (await this.runStore()).queuedForSession(sessionId);
  }

  async appendSegment(runId: string, segment: PackedSegment): Promise<void> {
    await (await this.runStore()).appendSegment(runId, segment);
  }

  async readSegments(runId: string, after = 0): Promise<PackedSegment[]> {
    return (await this.runStore()).readSegments(runId, after);
  }

  async deleteSegments(runId: string): Promise<void> {
    await (await this.runStore()).deleteSegments(runId);
  }

  async countSegments(runId: string): Promise<number> {
    return (await this.runStore()).countSegments(runId);
  }

  async startMark(
    input: Parameters<RunStore['startMark']>[0],
  ): Promise<ToolMark | undefined> {
    return (await this.runStore()).startMark(input);
  }

  async bumpMark(runId: string, toolCallId: string): Promise<void> {
    await (await this.runStore()).bumpMark(runId, toolCallId);
  }

  async finishMark(
    runId: string,
    toolCallId: string,
    outcome: 'ok' | 'error' | 'interrupted',
  ): Promise<void> {
    await (await this.runStore()).finishMark(runId, toolCallId, outcome);
  }

  async listMarks(runId: string): Promise<ToolMark[]> {
    return (await this.runStore()).listMarks(runId);
  }

  async claimWrite(
    input: Parameters<RunStore['claimWrite']>[0],
  ): Promise<Awaited<ReturnType<RunStore['claimWrite']>>> {
    return (await this.runStore()).claimWrite(input);
  }

  async releaseWrite(fingerprint: string, runId: string): Promise<void> {
    await (await this.runStore()).releaseWrite(fingerprint, runId);
  }

  async listClaims(): Promise<WriteClaimRecord[]> {
    return (await this.runStore()).listClaims();
  }

  /** Close the database so the next call re-opens it (a fresh `RunStore`, setup again). */
  async reopen(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
    this.store = undefined;
  }

  async rowCount(table: string): Promise<number> {
    await this.runStore();
    const row = await this.db!.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return Number(row?.n ?? 0);
  }
}
