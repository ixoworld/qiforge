/**
 * Text a `view_attachment` call extracted, kept in the user's own SQLite
 * file per (session, attachment reference, extraction model) so a later
 * view of the same file costs neither a download nor a helper-model call.
 * Only Matrix media is cached: an `mxc://` URI or event never changes,
 * whereas what an http(s) URL serves can. Entries expire after
 * `VIEW_CACHE_MAX_AGE_MS`, a session keeps its newest
 * `VIEW_CACHE_MAX_PER_SESSION`, both enforced on write, and a deleted
 * session takes its entries with it (`forgetSession`).
 */
import type { DoSqliteDatabase } from '../sqlite/database';
import type { Logger } from '../plugin-api/types';

/** One session's cache, as `viewAttachment` sees it. */
export interface AttachmentTextCache {
  get(ref: string, model: string): Promise<string | undefined>;
  put(ref: string, model: string, text: string): Promise<void>;
}

/**
 * The longest text kept per entry (characters). Documents are extracted up
 * to `MAX_TEXT_LENGTH` (50 000) plus a header, so this covers them; a longer
 * description is not cached and is extracted again on the next view.
 */
export const VIEW_CACHE_MAX_CHARS = 64 * 1024;

/** How long an entry is served and kept. */
export const VIEW_CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** Entries a session keeps (the newest). */
export const VIEW_CACHE_MAX_PER_SESSION = 50;

/** What an http(s) URL serves can change between views. */
function isCacheable(ref: string): boolean {
  return !/^https?:\/\//i.test(ref);
}

/** The "model" key of plain text decoded locally (no helper model involved). */
export const LOCAL_TEXT_EXTRACTION = 'local-text';

export class AttachmentTextCacheStore {
  private setupPromise: Promise<void> | undefined;

  constructor(
    private readonly db: Pick<DoSqliteDatabase, 'run' | 'get'>,
    private readonly log: Pick<Logger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  private setup(): Promise<void> {
    this.setupPromise ??= this.createTables().catch((error: unknown) => {
      this.setupPromise = undefined;
      throw error;
    });
    return this.setupPromise;
  }

  private async createTables(): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS attachment_text_cache (
         session_id TEXT NOT NULL,
         ref TEXT NOT NULL,
         model TEXT NOT NULL,
         text TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         UNIQUE (session_id, ref, model)
       )`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_attachment_text_cache_age
       ON attachment_text_cache(created_at)`,
    );
    await this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_attachment_text_cache_session
       ON attachment_text_cache(session_id, created_at)`,
    );
  }

  /**
   * The cache of one session. Its failures are logged and treated as a miss
   * (or a skipped write): a cache must never fail the view itself.
   */
  forSession(sessionId: string): AttachmentTextCache {
    return {
      get: async (ref, model) => {
        if (!isCacheable(ref)) return undefined;
        try {
          await this.setup();
          const row = await this.db.get<{ text: string }>(
            `SELECT text FROM attachment_text_cache
             WHERE session_id = ? AND ref = ? AND model = ? AND created_at > ?`,
            [sessionId, ref, model, this.now() - VIEW_CACHE_MAX_AGE_MS],
          );
          return row?.text;
        } catch (error) {
          this.log.warn(
            `[attachments] view cache read failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
      },
      put: async (ref, model, text) => {
        if (!isCacheable(ref) || text.length > VIEW_CACHE_MAX_CHARS) return;
        try {
          await this.setup();
          const now = this.now();
          await this.db.run(
            `INSERT OR REPLACE INTO attachment_text_cache
               (session_id, ref, model, text, created_at) VALUES (?, ?, ?, ?, ?)`,
            [sessionId, ref, model, text, now],
          );
          await this.db.run(
            `DELETE FROM attachment_text_cache WHERE created_at <= ?`,
            [now - VIEW_CACHE_MAX_AGE_MS],
          );
          await this.db.run(
            `DELETE FROM attachment_text_cache
             WHERE session_id = ? AND rowid NOT IN (
               SELECT rowid FROM attachment_text_cache WHERE session_id = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?
             )`,
            [sessionId, sessionId, VIEW_CACHE_MAX_PER_SESSION],
          );
        } catch (error) {
          this.log.warn(
            `[attachments] view cache write failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
  }

  /** Drop every entry of a deleted session; returns how many went. */
  async forgetSession(sessionId: string): Promise<number> {
    await this.setup();
    const { changes } = await this.db.run(
      `DELETE FROM attachment_text_cache WHERE session_id = ?`,
      [sessionId],
    );
    return changes;
  }
}

/** What {@link IngestTextLru} keeps per extraction. */
export interface IngestedText {
  text: string;
  /** True when the extraction itself was cut (cap reached, reply at its limit). */
  truncated: boolean;
  /** Size of the original file. */
  bytes: number;
  mimetype: string;
  /** Page count of a PDF's text layer. */
  pages?: number;
}

/** One session's view of an {@link IngestTextLru}. */
export interface IngestTextScope {
  get(ref: string, key: string): IngestedText | undefined;
  put(ref: string, key: string, value: IngestedText): void;
}

/** The longest text the ingestion LRU keeps per entry (characters). */
export const INGEST_LRU_MAX_CHARS = 1_000_000;
/** Entries the ingestion LRU keeps (per Durable Object). */
export const INGEST_LRU_MAX_ENTRIES = 4;
/** How long an ingestion LRU entry is served. */
export const INGEST_LRU_TTL_MS = 10 * 60 * 1000;

/**
 * Text extracted for document ingestion, in memory only: a few large
 * entries (up to a megabyte of text each, far over the 64 KB the SQLite
 * cache keeps) so the second call for the same file (confirm, retry,
 * `allow_truncation`) costs no download and no parse. Least recently used
 * entries go first; entries expire after the TTL.
 */
export class IngestTextLru {
  private readonly entries = new Map<
    string,
    { value: IngestedText; at: number }
  >();

  constructor(
    private readonly opts: {
      maxEntries?: number;
      maxChars?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get(key: string): IngestedText | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at >= (this.opts.ttlMs ?? INGEST_LRU_TTL_MS)) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert: Map iteration order is the recency order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  private put(key: string, value: IngestedText): void {
    if (value.text.length > (this.opts.maxChars ?? INGEST_LRU_MAX_CHARS)) {
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    const max = this.opts.maxEntries ?? INGEST_LRU_MAX_ENTRIES;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  forSession(sessionId: string): IngestTextScope {
    const keyOf = (ref: string, key: string) =>
      JSON.stringify([sessionId, ref, key]);
    return {
      get: (ref, key) =>
        isCacheable(ref) ? this.get(keyOf(ref, key)) : undefined,
      put: (ref, key, value) => {
        if (isCacheable(ref)) this.put(keyOf(ref, key), value);
      },
    };
  }
}
