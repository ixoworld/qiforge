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
  RUN_RETENTION_MS,
  RunStore,
  STALE_RUN_FILTER,
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
    /** The record `onRunEnded` was handed (what the object delivers from). */
    ended: RunRecord;
    stored: RunRecord | undefined;
    summary: RunSummary | undefined;
    /** Store work from begin to the run's end: transactions and row reads. */
    work: { transactions: number; reads: number };
  }> {
    const store = await this.runStore();
    await store.setup();
    const db = this.db!;
    const work = { transactions: 0, reads: 0 };
    const transaction = db.transaction.bind(db);
    db.transaction = <T>(fn: () => Promise<T>): Promise<T> => {
      work.transactions += 1;
      return transaction(fn);
    };
    const get = store.get.bind(store);
    store.get = (runId: string) => {
      work.reads += 1;
      return get(runId);
    };
    const readSegments = store.readSegments.bind(store);
    store.readSegments = (runId: string, after?: number) => {
      work.reads += 1;
      return readSegments(runId, after);
    };
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
    db.transaction = transaction;
    store.get = get;
    store.readSegments = readSegments;
    const stored = await store.get(input.runId);
    return {
      endedClient: record.client,
      ended: record,
      stored,
      summary: stored ? runSummaryOf(stored) : undefined,
      work,
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
  async reconcileWrite(
    fingerprint: string,
    input: Parameters<RunStore['reconcileWrite']>[2],
  ): Promise<boolean> {
    return (await this.runStore()).reconcileWrite(
      fingerprint,
      'did:ixo:test-owner',
      input,
    );
  }

  /** Close the database so the next call re-opens it (a fresh `RunStore`, setup again). */
  async reopen(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
    this.store = undefined;
  }

  /**
   * Seed two databases with the same mix of runs, prune one with the
   * per-run pruning the store used to do and the other by opening a
   * `RunStore` on it, and hand back both databases' contents and how many
   * transactions the store's boot opened.
   */
  async pruneEquivalence(): Promise<{
    legacy: PrunedTables;
    current: PrunedTables;
    transactions: number;
    receiptPlan: string[];
  }> {
    const t0 = this.nowMs;
    const later = t0 + RUN_RETENTION_MS + 60_000;
    const seed = async (name: string): Promise<DoSqliteDatabase> => {
      const db = await DoSqliteDatabase.open(this.ctx, name);
      await new RunStore(db, () => t0).setup();
      await db.run(`CREATE TABLE IF NOT EXISTS channel_requests (
        binding_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE, session_id TEXT,
        reply_mirrored INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (binding_id, request_id)
      )`);
      const old = new Date(t0).toISOString();
      const fresh = new Date(later - 1000).toISOString();
      const statuses = ['finished', 'aborted', 'interrupted', 'failed'];
      const runs: Array<[string, string, string, string]> = [];
      for (let i = 0; i < 30; i += 1)
        runs.push([`ch-stale-${i}`, 'channel', statuses[i % 4]!, old]);
      for (let i = 0; i < 5; i += 1)
        runs.push([`portal-stale-${i}`, 'portal', statuses[i % 4]!, old]);
      for (let i = 0; i < 5; i += 1)
        runs.push([`ch-fresh-${i}`, 'channel', 'finished', fresh]);
      for (const status of ['running', 'queued', 'recovering'])
        runs.push([`ch-active-${status}`, 'channel', status, old]);
      for (const [runId, client, status, at] of runs) {
        await db.run(
          `INSERT INTO turn_runs (run_id, session_id, request_id, client, status, started_at, updated_at, request, instance_id)
           VALUES (?, 's', ?, ?, ?, ?, ?, '{}', 'i')`,
          [runId, `req-${runId}`, client, status, at, at],
        );
        await db.run(
          `INSERT INTO turn_tool_marks (run_id, tool_call_id, tool_name, effect, started_at) VALUES (?, 'c1', 't', 'read', ?)`,
          [runId, at],
        );
        await db.run(
          `INSERT INTO turn_run_plans (run_id, plan) VALUES (?, '{}')`,
          [runId],
        );
        await db.run(
          `INSERT INTO turn_run_segments (run_id, seq_from, seq_to, payload) VALUES (?, 1, 1, '[]')`,
          [runId],
        );
        if (client === 'channel')
          await db.run(
            `INSERT INTO channel_requests (binding_id, request_id, request_hash, run_id) VALUES ('b', ?, 'h', ?)`,
            [`req-${runId}`, runId],
          );
      }
      // Left by an earlier boot: tombstoned runs whose receipts survived,
      // and a receipt whose run was never begun.
      for (const runId of ['ch-tombstoned-0', 'ch-tombstoned-1']) {
        await db.run(
          `INSERT INTO channel_run_tombstones (run_id, status) VALUES (?, 'finished')`,
          [runId],
        );
        await db.run(
          `INSERT INTO channel_requests (binding_id, request_id, request_hash, run_id) VALUES ('b', ?, 'h', ?)`,
          [`req-${runId}`, runId],
        );
      }
      await db.run(
        `INSERT INTO channel_requests (binding_id, request_id, request_hash, run_id) VALUES ('b', 'req-never', 'h', 'ch-never-begun')`,
      );
      await db.run(
        `INSERT INTO turn_write_claims (fingerprint, tool_name, run_id, session_id, started_at) VALUES ('old', 't', 'x', 's', ?), ('new', 't', 'y', 's', ?)`,
        [old, fresh],
      );
      return db;
    };
    const dump = async (db: DoSqliteDatabase): Promise<PrunedTables> => {
      const rows = (table: keyof PrunedTables) =>
        db.exec<PrunedRow>(`SELECT * FROM ${table} ORDER BY 1, 2`);
      return {
        turn_runs: await rows('turn_runs'),
        turn_tool_marks: await rows('turn_tool_marks'),
        turn_run_plans: await rows('turn_run_plans'),
        turn_run_segments: await rows('turn_run_segments'),
        turn_write_claims: await rows('turn_write_claims'),
        channel_run_tombstones: await rows('channel_run_tombstones'),
        channel_requests: await rows('channel_requests'),
      };
    };

    const legacyDb = await seed('prune-legacy.db');
    await legacyPrune(legacyDb, later);
    const legacy = await dump(legacyDb);

    const currentDb = await seed('prune-current.db');
    let transactions = 0;
    const transaction = currentDb.transaction.bind(currentDb);
    currentDb.transaction = <T>(fn: () => Promise<T>): Promise<T> => {
      transactions += 1;
      return transaction(fn);
    };
    await new RunStore(currentDb, () => later).setup();
    const current = await dump(currentDb);
    const receiptPlan = (
      await currentDb.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN DELETE FROM channel_requests WHERE EXISTS (
           SELECT 1 FROM channel_run_tombstones t WHERE t.run_id = channel_requests.run_id
         )`,
      )
    ).map((row) => row.detail);
    await legacyDb.close();
    await currentDb.close();
    return { legacy, current, transactions, receiptPlan };
  }

  /** How SQLite runs the statements boot pruning issues on every boot. */
  async prunePlans(): Promise<{ staleRuns: string[]; oldClaims: string[] }> {
    await (await this.runStore()).setup();
    const plan = async (sql: string) =>
      (
        await this.db!.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [
          '2026-01-01T00:00:00.000Z',
        ])
      ).map((row) => row.detail);
    return {
      staleRuns: await plan(
        `SELECT run_id FROM turn_runs WHERE ${STALE_RUN_FILTER} LIMIT 1`,
      ),
      oldClaims: await plan(
        `DELETE FROM turn_write_claims WHERE started_at < ?`,
      ),
    };
  }

  async rowCount(table: string): Promise<number> {
    await this.runStore();
    const row = await this.db!.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return Number(row?.n ?? 0);
  }
}

/** A row of the run tables (text and integer columns only). */
type PrunedRow = Record<string, string | number | null>;

/** Every table boot pruning touches, row by row. */
interface PrunedTables {
  turn_runs: PrunedRow[];
  turn_tool_marks: PrunedRow[];
  turn_run_plans: PrunedRow[];
  turn_run_segments: PrunedRow[];
  turn_write_claims: PrunedRow[];
  channel_run_tombstones: PrunedRow[];
  channel_requests: PrunedRow[];
}

/** The store's boot pruning as it was: one transaction per stale run. */
async function legacyPrune(db: DoSqliteDatabase, now: number): Promise<void> {
  const cutoff = new Date(now - RUN_RETENTION_MS).toISOString();
  await db.run(`DELETE FROM turn_write_claims WHERE started_at < ?`, [cutoff]);
  const stale = await db.exec<{
    run_id: string;
    client: string;
    status: string;
  }>(
    `SELECT run_id, client, status FROM turn_runs WHERE status IN ('finished','aborted','interrupted','failed') AND updated_at < ?`,
    [cutoff],
  );
  for (const row of stale) {
    await db.transaction(async () => {
      if (row.client === 'channel')
        await db.run(
          'INSERT OR IGNORE INTO channel_run_tombstones (run_id, status) VALUES (?, ?)',
          [row.run_id, row.status],
        );
      for (const table of [
        'turn_tool_marks',
        'turn_run_plans',
        'turn_run_segments',
        'turn_runs',
      ])
        await db.run(`DELETE FROM ${table} WHERE run_id = ?`, [row.run_id]);
    });
  }
  await db.run(
    `DELETE FROM channel_requests WHERE run_id IN (SELECT run_id FROM channel_run_tombstones)`,
  );
}
