import { Logger } from '@nestjs/common';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ChannelMemoryChunk,
  type ChannelMember,
  type PinnedFact,
} from './channel-memory.types';

const logger = new Logger('ChannelMemoryRepo');

/**
 * SQLite repository for channel memory chunks, pinned facts, and roster.
 *
 * Single oracle-wide DB at `${SQLITE_DATABASE_PATH}/channel_memory.db`. We use
 * better-sqlite3 (already a transitive dep via the existing checkpointer) and
 * FTS5 (built-in) for chunk search. Schema is created idempotently on init.
 *
 * The DB is intentionally local-only for v1. If the file is lost, the system
 * regenerates summaries from Matrix history on next group-room session start.
 * Sync to Matrix is a v2 concern.
 */
export class ChannelMemoryRepo {
  private readonly db: DatabaseType;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.bootstrap();
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_memory_chunks (
        id                TEXT PRIMARY KEY,
        room_id           TEXT NOT NULL,
        summary           TEXT NOT NULL,
        from_event_id     TEXT NOT NULL,
        to_event_id       TEXT NOT NULL,
        from_ts           INTEGER NOT NULL,
        to_ts             INTEGER NOT NULL,
        message_count     INTEGER NOT NULL,
        participants_json TEXT NOT NULL,
        thread_ids_json   TEXT NOT NULL,
        tier              INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_room_ts
        ON channel_memory_chunks(room_id, to_ts DESC);
      CREATE INDEX IF NOT EXISTS idx_chunks_room_tier_ts
        ON channel_memory_chunks(room_id, tier, to_ts DESC);

      CREATE TABLE IF NOT EXISTS channel_pinned_facts (
        id              TEXT PRIMARY KEY,
        room_id         TEXT NOT NULL,
        fact            TEXT NOT NULL,
        pinned_by_did   TEXT NOT NULL,
        source_event_id TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_room
        ON channel_pinned_facts(room_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS channel_meta (
        room_id      TEXT PRIMARY KEY,
        members_json TEXT NOT NULL DEFAULT '[]',
        updated_at   INTEGER NOT NULL
      );
    `);

    // FTS5 virtual table — created separately because it can fail on minimal
    // SQLite builds. Skip silently if unavailable; search will fall back to LIKE.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS channel_memory_chunks_fts USING fts5(
          summary,
          room_id UNINDEXED,
          content='channel_memory_chunks',
          content_rowid='rowid',
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON channel_memory_chunks
        BEGIN
          INSERT INTO channel_memory_chunks_fts(rowid, summary, room_id)
            VALUES (new.rowid, new.summary, new.room_id);
        END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON channel_memory_chunks
        BEGIN
          INSERT INTO channel_memory_chunks_fts(channel_memory_chunks_fts, rowid, summary, room_id)
            VALUES ('delete', old.rowid, old.summary, old.room_id);
        END;
      `);
    } catch (err) {
      logger.warn(
        `[ChannelMemoryRepo] FTS5 bootstrap failed; search will use LIKE fallback. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  insertChunk(chunk: ChannelMemoryChunk): void {
    this.db
      .prepare(
        `INSERT INTO channel_memory_chunks (
          id, room_id, summary, from_event_id, to_event_id, from_ts, to_ts,
          message_count, participants_json, thread_ids_json, tier, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.id,
        chunk.roomId,
        chunk.summary,
        chunk.fromEventId,
        chunk.toEventId,
        chunk.fromTimestamp,
        chunk.toTimestamp,
        chunk.messageCount,
        JSON.stringify(chunk.participants),
        JSON.stringify(chunk.threadIds),
        chunk.tier,
        chunk.createdAt,
      );
  }

  recentChunks(roomId: string, limit: number): ChannelMemoryChunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_memory_chunks
           WHERE room_id = ? AND tier = 1
           ORDER BY to_ts DESC
           LIMIT ?`,
      )
      .all(roomId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.rowToChunk);
  }

  /** Earliest chunks first — used for anchoring long-running rooms. */
  oldestChunks(roomId: string, limit: number): ChannelMemoryChunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_memory_chunks
           WHERE room_id = ?
           ORDER BY to_ts ASC
           LIMIT ?`,
      )
      .all(roomId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.rowToChunk);
  }

  countChunks(roomId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM channel_memory_chunks WHERE room_id = ?`,
      )
      .get(roomId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  searchChunks(
    roomId: string,
    query: string,
    limit: number,
  ): ChannelMemoryChunk[] {
    const trimmed = query.trim();
    if (!trimmed) return this.recentChunks(roomId, limit);

    // Multi-word queries use OR so any matching word is a hit.
    // Single-word queries are passed through unchanged (allows FTS5 prefix syntax).
    const words = trimmed.split(/\s+/).filter(Boolean);
    const ftsQuery = words.length > 1 ? words.join(' OR ') : trimmed;

    // Try FTS5 first; fall back to LIKE if the virtual table is missing.
    try {
      const rows = this.db
        .prepare(
          `SELECT c.* FROM channel_memory_chunks c
             JOIN channel_memory_chunks_fts f ON f.rowid = c.rowid
             WHERE c.room_id = ? AND channel_memory_chunks_fts MATCH ?
             ORDER BY rank LIMIT ?`,
        )
        .all(roomId, ftsQuery, limit) as Array<Record<string, unknown>>;
      return rows.map(this.rowToChunk);
    } catch (err) {
      logger.debug(
        `[ChannelMemoryRepo] FTS query failed (${err instanceof Error ? err.message : String(err)}); falling back to LIKE`,
      );
      // LIKE fallback: require all words to appear (AND semantics, best-effort).
      const likeConditions = words
        .map(() => `summary LIKE ? ESCAPE '\\'`)
        .join(' AND ');
      const likeValues = words.map(
        (w) => `%${w.replace(/[%_]/g, (c) => `\\${c}`)}%`,
      );
      const rows = this.db
        .prepare(
          `SELECT * FROM channel_memory_chunks
             WHERE room_id = ? AND ${likeConditions}
             ORDER BY to_ts DESC LIMIT ?`,
        )
        .all(roomId, ...likeValues, limit) as Array<Record<string, unknown>>;
      return rows.map(this.rowToChunk);
    }
  }

  insertPinnedFact(fact: PinnedFact): void {
    this.db
      .prepare(
        `INSERT INTO channel_pinned_facts (
          id, room_id, fact, pinned_by_did, source_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.id,
        fact.roomId,
        fact.fact,
        fact.pinnedByDid,
        fact.sourceEventId ?? null,
        fact.createdAt,
      );
  }

  listPinnedFacts(roomId: string, limit = 100): PinnedFact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_pinned_facts
           WHERE room_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
      )
      .all(roomId, limit) as Array<Record<string, unknown>>;
    return rows.map(this.rowToFact);
  }

  deletePinnedFact(roomId: string, factId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM channel_pinned_facts WHERE room_id = ? AND id = ?`)
      .run(roomId, factId);
    return result.changes > 0;
  }

  upsertMembers(roomId: string, members: ChannelMember[]): void {
    this.db
      .prepare(
        `INSERT INTO channel_meta (room_id, members_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           members_json = excluded.members_json,
           updated_at = excluded.updated_at`,
      )
      .run(roomId, JSON.stringify(members), Date.now());
  }

  getMembers(roomId: string): ChannelMember[] {
    const row = this.db
      .prepare(`SELECT members_json FROM channel_meta WHERE room_id = ?`)
      .get(roomId) as { members_json: string } | undefined;
    if (!row?.members_json) return [];
    try {
      const parsed = JSON.parse(row.members_json);
      return Array.isArray(parsed) ? (parsed as ChannelMember[]) : [];
    } catch {
      return [];
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      logger.warn(
        `[ChannelMemoryRepo] close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private rowToChunk = (row: Record<string, unknown>): ChannelMemoryChunk => ({
    id: row.id as string,
    roomId: row.room_id as string,
    summary: row.summary as string,
    fromEventId: row.from_event_id as string,
    toEventId: row.to_event_id as string,
    fromTimestamp: row.from_ts as number,
    toTimestamp: row.to_ts as number,
    messageCount: row.message_count as number,
    participants: safeJsonArray(row.participants_json),
    threadIds: safeJsonArray(row.thread_ids_json),
    tier: (row.tier as number) ?? 1,
    createdAt: row.created_at as number,
  });

  private rowToFact = (row: Record<string, unknown>): PinnedFact => ({
    id: row.id as string,
    roomId: row.room_id as string,
    fact: row.fact as string,
    pinnedByDid: row.pinned_by_did as string,
    sourceEventId: (row.source_event_id as string | null) ?? undefined,
    createdAt: row.created_at as number,
  });
}

function safeJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.length) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}
