/**
 * `user_kv` table access in the USER'S OWN SQLite database — the Workers
 * implementation of `ctx.kv` (`UserKvSurface`). Rows live in the owner file,
 * so plugin state written here survives the object being evicted and
 * restored from the owner copy, and leaves with the file when it is exported
 * or deleted.
 *
 *   user_kv(namespace, key, value, idle_ttl_ms, expires_at, touched_seq)
 *
 * `value` is JSON text. `expires_at` (ms epoch) is null for entries written
 * without an idle TTL. `touched_seq` is a store-wide counter bumped on every
 * read and write of a row: the least-recently-used entry of a namespace is
 * its lowest `touched_seq`. A counter rather than a timestamp keeps the order
 * total when several touches land in the same millisecond.
 */
import {
  assertUserKvName,
  assertUserKvOptions,
  decodeUserKvValue,
  encodeUserKvValue,
} from '../core/user-kv';
import type { UserKvSurface, UserKvWriteOptions } from '../plugin-api/types';
import type { DoSqliteDatabase } from './database';

type KvRow = {
  value: string;
  idle_ttl_ms: number | bigint | null;
  expires_at: number | bigint | null;
};

const NEXT_SEQ = `(SELECT COALESCE(MAX(touched_seq), 0) + 1 FROM user_kv)`;

export class SqliteUserKv implements UserKvSurface {
  private setupPromise: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly db: DoSqliteDatabase,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Create the table + index. Idempotent, cached like `TasksStore`. */
  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS user_kv (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        idle_ttl_ms INTEGER,
        expires_at INTEGER,
        touched_seq INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      )`);
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_user_kv_recency ON user_kv(namespace, touched_seq)`,
    );
    // Every touch computes MAX(touched_seq) over the whole table.
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_user_kv_seq ON user_kv(touched_seq)`,
    );
  }

  async get(namespace: string, key: string): Promise<unknown> {
    assertUserKvName('namespace', namespace);
    assertUserKvName('key', key);
    await this.setup();
    return this.db.transaction(async () => {
      const json = await this.touch(namespace, key);
      return json === undefined ? undefined : decodeUserKvValue(json);
    });
  }

  async set(
    namespace: string,
    key: string,
    value: unknown,
    options: UserKvWriteOptions = {},
  ): Promise<void> {
    const json = encodeUserKvValue(value);
    await this.update(namespace, key, () => decodeUserKvValue(json), options);
  }

  async update(
    namespace: string,
    key: string,
    fn: (current: unknown) => unknown,
    options: UserKvWriteOptions = {},
  ): Promise<unknown> {
    assertUserKvName('namespace', namespace);
    assertUserKvName('key', key);
    assertUserKvOptions(options);
    await this.setup();
    return this.db.transaction(async () => {
      const current = await this.touch(namespace, key);
      const next = fn(
        current === undefined ? undefined : decodeUserKvValue(current),
      );
      if (next === undefined) {
        await this.db.run(
          `DELETE FROM user_kv WHERE namespace = ? AND key = ?`,
          [namespace, key],
        );
      } else {
        const json = encodeUserKvValue(next);
        const ttl = options.idleTtlMs ?? null;
        await this.db.run(
          `INSERT INTO user_kv (namespace, key, value, idle_ttl_ms, expires_at, touched_seq)
           VALUES (?, ?, ?, ?, ?, ${NEXT_SEQ})
           ON CONFLICT (namespace, key) DO UPDATE SET
             value = excluded.value,
             idle_ttl_ms = excluded.idle_ttl_ms,
             expires_at = excluded.expires_at,
             touched_seq = excluded.touched_seq`,
          [namespace, key, json, ttl, ttl === null ? null : this.now() + ttl],
        );
      }
      if (options.maxEntries !== undefined) {
        await this.trim(namespace, options.maxEntries);
      }
      return next === undefined
        ? undefined
        : decodeUserKvValue(encodeUserKvValue(next));
    });
  }

  async delete(namespace: string, key: string): Promise<void> {
    assertUserKvName('namespace', namespace);
    assertUserKvName('key', key);
    await this.setup();
    await this.db.run(`DELETE FROM user_kv WHERE namespace = ? AND key = ?`, [
      namespace,
      key,
    ]);
  }

  /**
   * The live row's JSON, marked most recently used with its idle deadline
   * slid; an expired row is deleted and reads as absent. Runs inside the
   * caller's transaction.
   */
  private async touch(
    namespace: string,
    key: string,
  ): Promise<string | undefined> {
    const row = await this.db.get<KvRow>(
      `SELECT value, idle_ttl_ms, expires_at FROM user_kv WHERE namespace = ? AND key = ?`,
      [namespace, key],
    );
    if (!row) return undefined;
    const now = this.now();
    if (row.expires_at !== null && Number(row.expires_at) <= now) {
      await this.db.run(`DELETE FROM user_kv WHERE namespace = ? AND key = ?`, [
        namespace,
        key,
      ]);
      return undefined;
    }
    const ttl = row.idle_ttl_ms === null ? null : Number(row.idle_ttl_ms);
    await this.db.run(
      `UPDATE user_kv SET expires_at = ?, touched_seq = ${NEXT_SEQ}
       WHERE namespace = ? AND key = ?`,
      [ttl === null ? null : now + ttl, namespace, key],
    );
    return row.value;
  }

  /** Drop the namespace's expired rows, then the least recently used beyond `maxEntries`. */
  private async trim(namespace: string, maxEntries: number): Promise<void> {
    await this.db.run(
      `DELETE FROM user_kv WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
      [namespace, this.now()],
    );
    await this.db.run(
      `DELETE FROM user_kv WHERE namespace = ? AND key IN (
         SELECT key FROM user_kv WHERE namespace = ?
         ORDER BY touched_seq DESC LIMIT -1 OFFSET ?)`,
      [namespace, namespace, maxEntries],
    );
  }
}
