/**
 * Whole tool results that were too large for the model's context.
 *
 * `createResultCapMiddleware` (core/middlewares/result-cap.ts) hands the model
 * a head + tail of any result above the turn's cap and stores the whole
 * result here, under a content hash, so the model can page through it with
 * `read_result` when the visible part is not enough. Two tiers:
 *
 *   - **SQLite** (this object's database, `tool_results`) for results under
 *     `r2MinBytes` (default 1 MB): a Durable Object SQL row holds 2 MB at
 *     most, and the hot store is shared with checkpoints, runs and tasks;
 *   - **R2** (the tier bucket, `<object id>/results/<id>`) for anything
 *     larger — which is what an MCP dump or a big fetch produces — so the
 *     10 GB object limit is never in play.
 *
 * Every row carries `expires_at` (default 24 h): the model reads a result
 * back in the turn that produced it, rarely later. Expired rows and their
 * R2 objects are removed by `sweep()` at boot; a session's results go with
 * the session. Operators may add an R2 lifecycle rule on the `results/`
 * prefix as a belt on top of the sweep. Identical results de-duplicate by
 * hash (the row's expiry is refreshed instead of a second copy).
 */
import type { DoSqliteDatabase } from '../sqlite/database';
import type { Logger } from '../plugin-api/types';
import { NOOP_LOGGER } from '../core/utils';

export type ResultTier = 'sqlite' | 'r2';

export interface StoredResultRef {
  id: string;
  /** Size in bytes (UTF-8). */
  size: number;
  tier: ResultTier;
}

export type ReadResultOutcome =
  | {
      status: 'ok';
      id: string;
      tier: ResultTier;
      size: number;
      offset: number;
      length: number;
      text: string;
      /** Byte offset of the next chunk, or `null` at the end. */
      next: number | null;
    }
  | { status: 'expired' | 'not-found' };

export interface ResultStoreOptions {
  bucket?: R2Bucket;
  /** Key prefix in the bucket (the object's id). */
  prefix: string;
  ttlMs?: number;
  /** Results this size or larger go to R2 (needs `bucket`). */
  r2MinBytes?: number;
  now?: () => number;
  logger?: Logger;
}

export const DEFAULT_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RESULT_R2_MIN_BYTES = 1_000_000;
/** A DO SQL row holds 2 MB; leave room for the row's other columns. */
export const SQLITE_RESULT_MAX_BYTES = 1_500_000;
/** Longest chunk `read` returns (bytes). */
export const MAX_READ_BYTES = 64 * 1024;

type ResultRow = {
  id: string;
  session_id: string;
  tool_name: string;
  size: number;
  tier: string;
  content: string | null;
  created_at: string;
  expires_at: number;
} & Record<string, string | number | null>;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class ResultStore {
  private setupPromise: Promise<void> | undefined;

  private readonly now: () => number;

  private readonly ttlMs: number;

  private readonly r2MinBytes: number;

  private readonly logger: Logger;

  constructor(
    readonly db: DoSqliteDatabase,
    private readonly options: ResultStoreOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_RESULT_TTL_MS;
    this.r2MinBytes = options.r2MinBytes ?? DEFAULT_RESULT_R2_MIN_BYTES;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  setup(): Promise<void> {
    this.setupPromise ??= this.doSetup().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async doSetup(): Promise<void> {
    await this.db.run(`
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
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_id)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_tool_results_expires ON tool_results(expires_at)`,
    );
    await this.sweep();
  }

  private key(id: string): string {
    return `${this.options.prefix}/results/${id}`;
  }

  /**
   * Store a result whole. Returns `undefined` when it cannot be kept (too
   * large for a SQLite row and no bucket is bound) — the caller then shows
   * the truncated text without a handle.
   */
  async put(input: {
    sessionId: string;
    toolName: string;
    content: string;
  }): Promise<StoredResultRef | undefined> {
    await this.setup();
    const bytes = new TextEncoder().encode(input.content);
    const id = await sha256Hex(bytes);
    const expiresAt = this.now() + this.ttlMs;
    const existing = await this.db.get<ResultRow>(
      `SELECT id, tier, size FROM tool_results WHERE id = ?`,
      [id],
    );
    if (existing) {
      await this.db.run(`UPDATE tool_results SET expires_at = ? WHERE id = ?`, [
        expiresAt,
        id,
      ]);
      return {
        id,
        size: Number(existing.size),
        tier: existing.tier === 'r2' ? 'r2' : 'sqlite',
      };
    }
    const useR2 =
      this.options.bucket !== undefined && bytes.byteLength >= this.r2MinBytes;
    if (!useR2 && bytes.byteLength > SQLITE_RESULT_MAX_BYTES) {
      this.logger.warn(
        `[results] ${input.toolName}: ${bytes.byteLength} bytes exceed the SQLite tier and no bucket is bound; not saved`,
      );
      return undefined;
    }
    if (useR2) {
      await this.options.bucket!.put(this.key(id), bytes, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        customMetadata: {
          sessionId: input.sessionId,
          toolName: input.toolName,
        },
      });
    }
    await this.db.run(
      `INSERT OR IGNORE INTO tool_results (id, session_id, tool_name, size, tier, content, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.sessionId,
        input.toolName,
        bytes.byteLength,
        useR2 ? 'r2' : 'sqlite',
        useR2 ? null : input.content,
        new Date(this.now()).toISOString(),
        expiresAt,
      ],
    );
    return { id, size: bytes.byteLength, tier: useR2 ? 'r2' : 'sqlite' };
  }

  /** A chunk of a stored result, by byte range. */
  async read(
    id: string,
    offset = 0,
    length = 4_000,
  ): Promise<ReadResultOutcome> {
    await this.setup();
    const row = await this.db.get<ResultRow>(
      `SELECT id, tier, size, content, expires_at FROM tool_results WHERE id = ?`,
      [id],
    );
    if (!row) return { status: 'not-found' };
    if (Number(row.expires_at) <= this.now()) {
      await this.remove([row]);
      return { status: 'expired' };
    }
    const size = Number(row.size);
    const start = Math.max(0, Math.min(Math.floor(offset), size));
    const span = Math.max(
      1,
      Math.min(Math.floor(length), MAX_READ_BYTES, size - start),
    );
    const tier: ResultTier = row.tier === 'r2' ? 'r2' : 'sqlite';
    let slice: Uint8Array;
    if (tier === 'r2') {
      const object = await this.options.bucket?.get(this.key(id), {
        range: { offset: start, length: span },
      });
      if (!object) return { status: 'not-found' };
      slice = new Uint8Array(await object.arrayBuffer());
    } else {
      slice = new TextEncoder()
        .encode(row.content ?? '')
        .subarray(start, start + span);
    }
    const text = new TextDecoder().decode(slice);
    const next = start + span < size ? start + span : null;
    return {
      status: 'ok',
      id,
      tier,
      size,
      offset: start,
      length: span,
      text,
      next,
    };
  }

  async deleteForSession(sessionId: string): Promise<number> {
    await this.setup();
    const rows = await this.db.exec<ResultRow>(
      `SELECT id, tier FROM tool_results WHERE session_id = ?`,
      [sessionId],
    );
    await this.remove(rows);
    return rows.length;
  }

  /** Drop expired rows (and their R2 objects). Returns how many. */
  async sweep(): Promise<number> {
    const rows = await this.db.exec<ResultRow>(
      `SELECT id, tier FROM tool_results WHERE expires_at <= ?`,
      [this.now()],
    );
    await this.remove(rows);
    return rows.length;
  }

  private async remove(
    rows: Array<Pick<ResultRow, 'id' | 'tier'>>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const r2Keys = rows
      .filter((r) => r.tier === 'r2')
      .map((r) => this.key(r.id));
    if (r2Keys.length > 0 && this.options.bucket) {
      try {
        await this.options.bucket.delete(r2Keys);
      } catch (error) {
        this.logger.warn(
          `[results] could not delete ${r2Keys.length} R2 object(s): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const row of rows)
      await this.db.run(`DELETE FROM tool_results WHERE id = ?`, [row.id]);
  }

  async stats(): Promise<{
    rows: number;
    sqliteBytes: number;
    r2Rows: number;
    r2Bytes: number;
  }> {
    await this.setup();
    const row = await this.db.get<{
      rows: number;
      sqlite_bytes: number | null;
      r2_rows: number | null;
      r2_bytes: number | null;
    }>(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN tier = 'sqlite' THEN size ELSE 0 END) AS sqlite_bytes,
              SUM(CASE WHEN tier = 'r2' THEN 1 ELSE 0 END) AS r2_rows,
              SUM(CASE WHEN tier = 'r2' THEN size ELSE 0 END) AS r2_bytes
       FROM tool_results`,
    );
    return {
      rows: Number(row?.rows ?? 0),
      sqliteBytes: Number(row?.sqlite_bytes ?? 0),
      r2Rows: Number(row?.r2_rows ?? 0),
      r2Bytes: Number(row?.r2_bytes ?? 0),
    };
  }
}

/** Parse the `TOOL_RESULT_*` knobs (defaults: 24 h, 1 MB). */
export function resultStoreKnobs(env: Record<string, unknown>): {
  ttlMs: number;
  r2MinBytes: number;
} {
  const hours = Number(env.TOOL_RESULT_TTL_HOURS);
  const r2Min = Number(env.TOOL_RESULT_R2_MIN_BYTES);
  return {
    ttlMs:
      Number.isFinite(hours) && hours >= 1
        ? Math.floor(hours * 60 * 60 * 1000)
        : DEFAULT_RESULT_TTL_MS,
    r2MinBytes:
      Number.isInteger(r2Min) &&
      r2Min >= 64 * 1024 &&
      r2Min <= SQLITE_RESULT_MAX_BYTES
        ? r2Min
        : DEFAULT_RESULT_R2_MIN_BYTES,
  };
}
