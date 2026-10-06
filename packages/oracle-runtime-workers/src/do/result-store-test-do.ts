/**
 * Test-only Durable Object driving `ResultStore` over real DO SQLite and the
 * test R2 bucket inside workerd. Bound as `RESULT_STORE_TEST` by
 * `test/wrangler.test.jsonc`. Not part of the runtime.
 */
import { DurableObject } from 'cloudflare:workers';
import { DoSqliteDatabase } from '../sqlite/database';
import {
  ResultStore,
  type ReadResultOutcome,
  type StoredResultRef,
} from './result-store';

export class ResultStoreTestDO extends DurableObject<{ TIER_TEST: R2Bucket }> {
  private db: DoSqliteDatabase | undefined;

  private store: ResultStore | undefined;

  private nowMs = Date.parse('2026-09-14T10:00:00.000Z');

  private r2MinBytes = 1_000_000;

  private withBucket = true;

  /**
   * How R2 deletes behave: `fail` throws (an outage during a sweep),
   * `delete-then-fail` deletes and then throws (a lost response),
   * `fail-first` throws on the first call only.
   */
  private deletes: 'ok' | 'fail' | 'delete-then-fail' | 'fail-first' = 'ok';

  private deleteCalls = 0;

  /** While set, an R2 delete waits for `release` (after signalling `reached`). */
  private deleteHold: { reached: () => void; release: Promise<void> } | null =
    null;

  private async database(): Promise<DoSqliteDatabase> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'results-test.db');
      this.store = undefined;
    }
    return this.db;
  }

  private bucket(): R2Bucket {
    const remove = async (keys: string | string[]): Promise<void> => {
      this.deleteCalls += 1;
      const hold = this.deleteHold;
      if (hold) {
        hold.reached();
        await hold.release;
      }
      if (
        this.deletes === 'fail' ||
        (this.deletes === 'fail-first' && this.deleteCalls === 1)
      )
        throw new Error('R2 unavailable');
      await this.env.TIER_TEST.delete(keys);
      if (this.deletes === 'delete-then-fail')
        throw new Error('R2 response lost');
    };
    return new Proxy(this.env.TIER_TEST, {
      get: (target, property) => {
        if (property === 'delete') return remove;
        // The binding's methods only run on the binding itself.
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private async resultStore(): Promise<ResultStore> {
    const db = await this.database();
    this.store ??= new ResultStore(db, {
      ...(this.withBucket ? { bucket: this.bucket() } : {}),
      prefix: `test-${this.ctx.id.toString()}`,
      ttlMs: 60 * 60 * 1000,
      r2MinBytes: this.r2MinBytes,
      now: () => this.nowMs,
    });
    return this.store;
  }

  async configure(opts: {
    r2MinBytes?: number;
    withBucket?: boolean;
    failingDeletes?: boolean;
    deletes?: 'ok' | 'fail' | 'delete-then-fail' | 'fail-first';
  }): Promise<void> {
    if (opts.r2MinBytes !== undefined) this.r2MinBytes = opts.r2MinBytes;
    if (opts.withBucket !== undefined) this.withBucket = opts.withBucket;
    if (opts.failingDeletes !== undefined)
      this.deletes = opts.failingDeletes ? 'fail' : 'ok';
    if (opts.deletes !== undefined) this.deletes = opts.deletes;
    this.deleteCalls = 0;
    this.store = undefined;
  }

  /**
   * Delete one session's results while another session stores the same
   * content: the put starts while the delete waits on R2, and R2 answers
   * after the put had time to finish. Returns how the result reads then.
   */
  async deleteWhilePutting(input: {
    deleting: string;
    putting: string;
    content: string;
  }): Promise<ReadResultOutcome> {
    const store = await this.resultStore();
    await store.setup();
    let reached!: () => void;
    const atDelete = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    this.deleteHold = {
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const deleting = store.deleteForSession(input.deleting);
    await atDelete;
    const putting = store.put({
      sessionId: input.putting,
      toolName: 't',
      content: input.content,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [, ref] = await Promise.all([deleting, putting]);
    this.deleteHold = null;
    if (!ref) throw new Error('the result was not stored');
    return store.read(ref.id, 0, 5);
  }

  /**
   * Rows as a store written before results were shared across sessions
   * left them: the `tool_results` table alone. Call before any other method.
   */
  async seedLegacy(
    rows: Array<{ id: string; sessionId: string; content: string }>,
  ): Promise<void> {
    const db = await this.database();
    await db.run(`
      CREATE TABLE IF NOT EXISTS tool_results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        tier TEXT NOT NULL,
        content TEXT,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
    for (const row of rows)
      await db.run(
        `INSERT INTO tool_results VALUES (?, ?, 't', ?, 'sqlite', ?, ?, ?)`,
        [
          row.id,
          row.sessionId,
          new TextEncoder().encode(row.content).byteLength,
          row.content,
          new Date(this.nowMs).toISOString(),
          this.nowMs + 60 * 60 * 1000,
        ],
      );
  }

  /** Re-open the store over the same database (the next boot). */
  async reboot(): Promise<void> {
    this.store = undefined;
  }

  async references(): Promise<Array<{ id: string; session_id: string }>> {
    const db = await this.database();
    return db.exec<{ id: string; session_id: string }>(
      `SELECT id, session_id FROM tool_result_sessions ORDER BY id, session_id`,
    );
  }

  async setNow(ms: number): Promise<void> {
    this.nowMs = ms;
  }

  async put(input: {
    sessionId: string;
    toolName: string;
    content: string;
  }): Promise<StoredResultRef | undefined> {
    return (await this.resultStore()).put(input);
  }

  async read(
    id: string,
    offset?: number,
    length?: number,
  ): Promise<ReadResultOutcome> {
    return (await this.resultStore()).read(id, offset, length);
  }

  async sweep(): Promise<number> {
    return (await this.resultStore()).sweep();
  }

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.resultStore()).deleteForSession(sessionId);
  }

  async stats(): Promise<Awaited<ReturnType<ResultStore['stats']>>> {
    return (await this.resultStore()).stats();
  }

  async r2Has(id: string): Promise<boolean> {
    return (
      (await this.env.TIER_TEST.head(
        `test-${this.ctx.id.toString()}/results/${id}`,
      )) !== null
    );
  }
}
