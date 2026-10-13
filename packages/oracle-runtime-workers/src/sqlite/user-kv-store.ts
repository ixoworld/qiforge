/**
 * `user_kv` table access in the USER'S OWN SQLite database — the Workers
 * implementation of `ctx.kv` (`UserKvSurface`). Rows live in the owner file,
 * so plugin state written here survives the object being evicted and
 * restored from the owner copy, and leaves with the file when it is exported
 * or deleted.
 *
 *   user_kv(namespace, key, value, bytes, idle_ttl_ms, expires_at, touched_seq)
 *
 * `value` is JSON text; `bytes` the row's UTF-8 size — namespace, key and
 * value together (`userKvRowBytes`) — the unit of the store-wide byte cap
 * (`USER_KV_LIMITS` in `core/user-kv.ts`). Every write checks the caps
 * inside its own transaction. `expires_at` (ms epoch) is null for entries written
 * without an idle TTL. `touched_seq` is a store-wide counter bumped on every
 * read and write of a row: the least-recently-used entry of a namespace is
 * its lowest `touched_seq`. A counter rather than a timestamp keeps the order
 * total when several touches land in the same millisecond.
 */
import {
  assertUserKvName,
  assertUserKvOptions,
  assertUserKvValueSize,
  decodeUserKvValue,
  encodeUserKvValue,
  resolveUserKvLimits,
  userKvOverflow,
  userKvRowBytes,
  userKvValueBytes,
  type UserKvLimits,
  type UserKvUsage,
} from '../core/user-kv';
import type { UserKvSurface, UserKvWriteOptions } from '../plugin-api/types';
import type { DoSqliteDatabase } from './database';

type KvRow = {
  value: string;
  idle_ttl_ms: number | bigint | null;
  expires_at: number | bigint | null;
};

type CountRow = { n: number | bigint };
type TotalsRow = { n: number | bigint; b: number | bigint };

const NEXT_SEQ = `(SELECT COALESCE(MAX(touched_seq), 0) + 1 FROM user_kv)`;

export class SqliteUserKv implements UserKvSurface {
  private setupPromise: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly limits: Readonly<UserKvLimits>;

  /**
   * `limits` overrides the hard caps for tests; the host constructs the
   * store without it, so the caps in force are `USER_KV_LIMITS`.
   */
  constructor(
    private readonly db: DoSqliteDatabase,
    options: { now?: () => number; limits?: Partial<UserKvLimits> } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.limits = resolveUserKvLimits(options.limits);
  }

  /**
   * Create the table + indexes, or bring a table from an older build up to
   * the current shape. Idempotent, cached like `TasksStore`.
   */
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
        bytes INTEGER NOT NULL,
        idle_ttl_ms INTEGER,
        expires_at INTEGER,
        touched_seq INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      )`);
    await this.addBytesColumn();
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_user_kv_recency ON user_kv(namespace, touched_seq)`,
    );
    // Every touch computes MAX(touched_seq) over the whole table.
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_user_kv_seq ON user_kv(touched_seq)`,
    );
    // Covers the store-wide COUNT(*) + SUM(bytes) of the cap check, so it
    // reads the index rather than every value.
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_user_kv_bytes ON user_kv(bytes)`,
    );
    // The store-wide sweep of expired rows before a write is refused.
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_user_kv_expiry ON user_kv(expires_at)`,
    );
  }

  /**
   * A table created before the caps has no `bytes`: add it and fill it from
   * the stored names and JSON in one transaction, so a column that exists is always
   * filled. SQLite only adds a NOT NULL column with a default; every write
   * sets it explicitly.
   */
  private async addBytesColumn(): Promise<void> {
    const columns = await this.db.exec<{ name: string }>(
      `PRAGMA table_info(user_kv)`,
    );
    if (columns.some((column) => column.name === 'bytes')) return;
    await this.db.transaction(async () => {
      await this.db.run(
        `ALTER TABLE user_kv ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0`,
      );
      await this.db.run(
        `UPDATE user_kv SET bytes = length(CAST(namespace AS BLOB))
           + length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))`,
      );
    });
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
        if (options.maxEntries !== undefined) {
          await this.trim(namespace, options.maxEntries);
        }
        return undefined;
      }
      const json = encodeUserKvValue(next);
      const valueBytes = assertUserKvValueSize(namespace, json, this.limits);
      const ttl = options.idleTtlMs ?? null;
      await this.db.run(
        `INSERT INTO user_kv (namespace, key, value, bytes, idle_ttl_ms, expires_at, touched_seq)
         VALUES (?, ?, ?, ?, ?, ?, ${NEXT_SEQ})
         ON CONFLICT (namespace, key) DO UPDATE SET
           value = excluded.value,
           bytes = excluded.bytes,
           idle_ttl_ms = excluded.idle_ttl_ms,
           expires_at = excluded.expires_at,
           touched_seq = excluded.touched_seq`,
        [
          namespace,
          key,
          json,
          userKvRowBytes(namespace, key, valueBytes),
          ttl,
          ttl === null ? null : this.now() + ttl,
        ],
      );
      if (options.maxEntries !== undefined) {
        await this.trim(namespace, options.maxEntries);
      }
      // `touch` deleted an expired row, so `current` is the live row this
      // write replaced, if any. Namespace and key are the same, so the row
      // grew exactly when its value did.
      await this.enforceCaps(namespace, {
        entries: current === undefined,
        bytes:
          valueBytes > (current === undefined ? 0 : userKvValueBytes(current)),
      });
      return decodeUserKvValue(json);
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

  /**
   * Throw `UserKvLimitError` — rolling the caller's transaction back,
   * so the write and anything it evicted are undone — when the write broke a
   * hard cap. Before refusing, expired rows of every namespace are swept and
   * the store measured again, so rows nobody can read any more never block
   * a write. Only the measures the write `grew` are checked
   * (`userKvOverflow`). Runs inside the caller's transaction, after the write.
   */
  private async enforceCaps(
    namespace: string,
    grew: { entries: boolean; bytes: boolean },
  ): Promise<void> {
    if (!grew.entries && !grew.bytes) return;
    let overflow = userKvOverflow(
      namespace,
      await this.usage(namespace),
      grew,
      this.limits,
    );
    if (!overflow) return;
    const swept = await this.db.run(
      `DELETE FROM user_kv WHERE expires_at IS NOT NULL AND expires_at <= ?`,
      [this.now()],
    );
    if (swept.changes > 0) {
      overflow = userKvOverflow(
        namespace,
        await this.usage(namespace),
        grew,
        this.limits,
      );
    }
    if (overflow) throw overflow;
  }

  /**
   * Rows of the namespace (`idx_user_kv_recency`) and rows + row bytes of
   * the store (covering `idx_user_kv_bytes`), expired rows included.
   */
  private async usage(namespace: string): Promise<UserKvUsage> {
    const ns = await this.db.get<CountRow>(
      `SELECT COUNT(*) AS n FROM user_kv WHERE namespace = ?`,
      [namespace],
    );
    const totals = await this.db.get<TotalsRow>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM user_kv`,
    );
    return {
      namespaceEntries: Number(ns?.n ?? 0),
      totalEntries: Number(totals?.n ?? 0),
      totalBytes: Number(totals?.b ?? 0),
    };
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
