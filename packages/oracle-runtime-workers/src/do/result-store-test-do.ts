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

  private async resultStore(): Promise<ResultStore> {
    if (!this.db || !this.db.isOpen) {
      this.db = await DoSqliteDatabase.open(this.ctx, 'results-test.db');
      this.store = undefined;
    }
    this.store ??= new ResultStore(this.db, {
      ...(this.withBucket ? { bucket: this.env.TIER_TEST } : {}),
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
  }): Promise<void> {
    if (opts.r2MinBytes !== undefined) this.r2MinBytes = opts.r2MinBytes;
    if (opts.withBucket !== undefined) this.withBucket = opts.withBucket;
    this.store = undefined;
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
