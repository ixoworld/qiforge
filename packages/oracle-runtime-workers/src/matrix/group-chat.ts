/**
 * Matrix group rooms — the port of the Node runtime's `matrix-group-chats`
 * plugin: the gate that decides whether the oracle answers a message in a
 * room with more than two members, and the channel memory every such room
 * gets (compacted summaries, pinned facts, the member roster).
 *
 * Node ran the gate as an agent middleware inside each speaker's turn; the
 * room-level state (active threads, the per-room memory database) lived in
 * the process. On Workers every speaker has their own user object, so the
 * room-level state belongs to the one object every message passes through:
 * the gateway. It runs the gate BEFORE a turn is dispatched (an ignored
 * message never wakes a user object) and keeps the memory in its own SQLite
 * (`group_*` tables; FTS5 for search, the LIKE fallback Node has when FTS5 is
 * missing). The decision, the room kind and the speaker's display name ride
 * on the turn request so the user object applies Node's `[DisplayName]: `
 * prefix and offers the channel-memory tools (`plugins/matrix-group-chats`).
 *
 * The rules, in Node's order (`guard.ts`):
 *   1. a direct room (the `m.room.create` `is_direct` flag, or ≤ 2 joined
 *      members — and, here, a room whose canonical alias is a user↔oracle
 *      alias of this oracle, whatever its member count: that room IS the
 *      user's conversation with the oracle, and the service bots that
 *      homeservers seat in it must not turn it into a group)
 *      → always answer, no gate, no prefix, no tools;
 *   2. the bot is in `m.mentions.user_ids` → answer;
 *   3. the message quote-replies a message the bot sent → answer;
 *   4. the thread is one the bot answered in within the TTL → answer
 *      (an in-memory map, re-warmed from the durable `group_bot_threads`
 *      table after a restart — Node re-warmed from a room history scan);
 *   5. otherwise stay silent — the message is still captured into channel
 *      memory so summaries stay accurate.
 * An answer is skipped when the bot's power level is below the room's
 * `m.room.message` threshold (plus `GROUP_CHAT_REQUIRE_POWER_LEVEL`).
 *
 * What happens in a group room is a deployment choice, `MATRIX_GROUP_ROOMS`
 * on the gateway: `silent` (the default) answers nothing there and captures
 * nothing — the bot only ever speaks in direct rooms (the user↔oracle room,
 * the task rooms it creates); `gate` runs the Node lane described here;
 * `answer` replies to everything as in a direct room (Node without the
 * plugin). Direct rooms behave the same under every policy.
 *
 * Compaction: every observed message goes to a per-room buffer; at 20 the
 * buffer is summarized (`group-chat-summarizer.ts`, run in the speaker's user
 * object) into a chunk, and just before the bot answers a buffer of ≥ 5 is
 * compacted with a 3 s cap so the reply is not held up. Node also compacted
 * after 5 idle minutes; here the buffer is durable and the next engagement
 * compacts it, so nothing is lost while a room is quiet.
 */
import type { JsonString } from '../do/contracts';
import type { ObservedMessage } from './group-chat-summarizer';

export interface RoomTypeInfo {
  isDirect: boolean;
  memberCount: number;
  joinedMemberIds: string[];
}

export interface ChannelMemoryChunk {
  id: string;
  roomId: string;
  summary: string;
  fromEventId: string;
  toEventId: string;
  fromTimestamp: number;
  toTimestamp: number;
  messageCount: number;
  participants: string[];
  threadIds: string[];
  tier: number;
  createdAt: number;
}

export interface PinnedFact {
  id: string;
  roomId: string;
  fact: string;
  pinnedByDid: string;
  sourceEventId?: string;
  createdAt: number;
}

export interface ChannelMember {
  matrixUserId: string;
  displayName: string;
  did?: string;
}

export const DEFAULT_ACTIVE_THREAD_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_ROOM_INFO_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_REQUIRE_POWER_LEVEL = 0;
export const COMPACT_BUFFER_THRESHOLD = 20;
export const COMPACT_JIT_MIN = 5;
export const COMPACT_JIT_TIMEOUT_MS = 3000;
export const RECALL_DEFAULT_CHUNKS = 10;
export const RECALL_MAX_CHUNKS = 30;
export const PINNED_FACT_MAX_CHARS = 500;

/** What the bot does in a room with more than two members (`MATRIX_GROUP_ROOMS`). */
export type GroupRoomPolicy = 'silent' | 'gate' | 'answer';
export const DEFAULT_GROUP_ROOM_POLICY: GroupRoomPolicy = 'silent';

export interface GroupChatOptions {
  groupRooms: GroupRoomPolicy;
  activeThreadTtlMs: number;
  requirePowerLevel: number;
  roomInfoTtlMs: number;
}

export interface GroupChatEnv {
  MATRIX_GROUP_ROOMS?: string;
  GROUP_CHAT_ACTIVE_THREAD_TTL_MS?: string;
  GROUP_CHAT_REQUIRE_POWER_LEVEL?: string;
  GROUP_CHAT_ROOM_INFO_TTL_MS?: string;
}

function intFromEnv(raw: string | undefined, fallback: number, min: number) {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n >= min ? n : fallback;
}

/** The Node plugin's config knobs, read from the gateway's env. */
export function groupChatOptionsFromEnv(env: GroupChatEnv): GroupChatOptions {
  return {
    groupRooms:
      env.MATRIX_GROUP_ROOMS === 'gate' || env.MATRIX_GROUP_ROOMS === 'answer'
        ? env.MATRIX_GROUP_ROOMS
        : DEFAULT_GROUP_ROOM_POLICY,
    activeThreadTtlMs: intFromEnv(
      env.GROUP_CHAT_ACTIVE_THREAD_TTL_MS,
      DEFAULT_ACTIVE_THREAD_TTL_MS,
      60_000,
    ),
    requirePowerLevel: intFromEnv(
      env.GROUP_CHAT_REQUIRE_POWER_LEVEL,
      DEFAULT_REQUIRE_POWER_LEVEL,
      0,
    ),
    roomInfoTtlMs: intFromEnv(
      env.GROUP_CHAT_ROOM_INFO_TTL_MS,
      DEFAULT_ROOM_INFO_TTL_MS,
      60_000,
    ),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (the Node guard's, unchanged in semantics)
// ---------------------------------------------------------------------------

/** True when the event's `m.mentions.user_ids` names the bot. Older clients omit `m.mentions`: false. */
export function isBotMentioned(
  content: Record<string, unknown> | undefined,
  botUserId: string,
): boolean {
  if (!content) return false;
  const mentions = content['m.mentions'] as { user_ids?: unknown } | undefined;
  const userIds = mentions?.user_ids;
  if (!Array.isArray(userIds)) return false;
  return userIds.some((id) => typeof id === 'string' && id === botUserId);
}

export interface BotPowerLevel {
  /** The bot's effective power level in the room. */
  pl: number;
  /** Power level required to send `m.room.message` events. */
  sendThreshold: number;
  /** True when the bot has at least `max(sendThreshold, requiredMin)`. */
  allowed: (requiredMin?: number) => boolean;
}

/**
 * The bot's send permission from an `m.room.power_levels` content (a
 * missing event is "everyone allowed", the Matrix default).
 */
export function botPowerLevelOf(
  content: unknown,
  botUserId: string,
): BotPowerLevel {
  const pls =
    typeof content === 'object' && content !== null
      ? (content as {
          users?: Record<string, number>;
          users_default?: number;
          events?: Record<string, number>;
          events_default?: number;
        })
      : {};
  const usersDefault = pls.users_default ?? 0;
  const eventsDefault = pls.events_default ?? 0;
  const pl = pls.users?.[botUserId] ?? usersDefault;
  const sendThreshold = pls.events?.['m.room.message'] ?? eventsDefault;
  return {
    pl,
    sendThreshold,
    allowed: (requiredMin = 0) => pl >= Math.max(sendThreshold, requiredMin),
  };
}

const activeKey = (roomId: string, threadId: string) => `${roomId}:${threadId}`;

// ---------------------------------------------------------------------------
// Store — the Node `ChannelMemoryRepo` schema on the gateway's SQLite
// ---------------------------------------------------------------------------

type ChunkRow = {
  id: string;
  room_id: string;
  summary: string;
  from_event_id: string;
  to_event_id: string;
  from_ts: number;
  to_ts: number;
  message_count: number;
  participants_json: string;
  thread_ids_json: string;
  tier: number;
  created_at: number;
} & Record<string, SqlStorageValue>;

type FactRow = {
  id: string;
  room_id: string;
  fact: string;
  pinned_by_did: string;
  source_event_id: string | null;
  created_at: number;
} & Record<string, SqlStorageValue>;

type BufferRow = {
  event_id: string;
  room_id: string;
  thread_id: string;
  sender_did: string;
  sender_user_id: string;
  display_name: string;
  body: string;
  ts: number;
} & Record<string, SqlStorageValue>;

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.length) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}

const rowToChunk = (row: ChunkRow): ChannelMemoryChunk => ({
  id: row.id,
  roomId: row.room_id,
  summary: row.summary,
  fromEventId: row.from_event_id,
  toEventId: row.to_event_id,
  fromTimestamp: Number(row.from_ts),
  toTimestamp: Number(row.to_ts),
  messageCount: Number(row.message_count),
  participants: jsonArray(row.participants_json),
  threadIds: jsonArray(row.thread_ids_json),
  tier: Number(row.tier ?? 1),
  createdAt: Number(row.created_at),
});

const rowToFact = (row: FactRow): PinnedFact => ({
  id: row.id,
  roomId: row.room_id,
  fact: row.fact,
  pinnedByDid: row.pinned_by_did,
  ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}),
  createdAt: Number(row.created_at),
});

const rowToObserved = (row: BufferRow): ObservedMessage => ({
  eventId: row.event_id,
  threadId: row.thread_id,
  senderDid: row.sender_did,
  senderMatrixUserId: row.sender_user_id,
  senderDisplayName: row.display_name,
  body: row.body,
  timestamp: Number(row.ts),
});

export class GroupChatStore {
  /** Whether the FTS5 index exists (search falls back to LIKE otherwise, as on Node). */
  readonly fts: boolean;

  constructor(
    private readonly sql: SqlStorage,
    log: (level: 'warn', msg: string) => void = () => undefined,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS group_memory_chunks (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      from_event_id TEXT NOT NULL,
      to_event_id TEXT NOT NULL,
      from_ts INTEGER NOT NULL,
      to_ts INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      participants_json TEXT NOT NULL,
      thread_ids_json TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_group_chunks_room_ts ON group_memory_chunks(room_id, to_ts DESC)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS group_pinned_facts (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      pinned_by_did TEXT NOT NULL,
      source_event_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_group_facts_room ON group_pinned_facts(room_id, created_at DESC)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS group_room_meta (
      room_id TEXT PRIMARY KEY,
      members_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS group_message_buffer (
      event_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sender_did TEXT NOT NULL,
      sender_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      body TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_group_buffer_room ON group_message_buffer(room_id, ts)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS group_bot_threads (
      room_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, thread_id)
    )`);
    let fts = false;
    try {
      sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS group_memory_chunks_fts USING fts5(
        summary,
        room_id UNINDEXED,
        content='group_memory_chunks',
        content_rowid='rowid',
        tokenize='porter unicode61'
      )`);
      sql.exec(`CREATE TRIGGER IF NOT EXISTS group_chunks_ai AFTER INSERT ON group_memory_chunks
      BEGIN
        INSERT INTO group_memory_chunks_fts(rowid, summary, room_id)
          VALUES (new.rowid, new.summary, new.room_id);
      END`);
      sql.exec(`CREATE TRIGGER IF NOT EXISTS group_chunks_ad AFTER DELETE ON group_memory_chunks
      BEGIN
        INSERT INTO group_memory_chunks_fts(group_memory_chunks_fts, rowid, summary, room_id)
          VALUES ('delete', old.rowid, old.summary, old.room_id);
      END`);
      fts = true;
    } catch (err) {
      log(
        'warn',
        `[group-chat] FTS5 unavailable; channel-memory search uses LIKE: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.fts = fts;
  }

  insertChunk(chunk: ChannelMemoryChunk): void {
    this.sql.exec(
      `INSERT INTO group_memory_chunks (
        id, room_id, summary, from_event_id, to_event_id, from_ts, to_ts,
        message_count, participants_json, thread_ids_json, tier, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  recentChunks(roomId: string, limit: number, tier = 1): ChannelMemoryChunk[] {
    return this.sql
      .exec<ChunkRow>(
        `SELECT * FROM group_memory_chunks WHERE room_id = ? AND tier = ?
         ORDER BY to_ts DESC LIMIT ?`,
        roomId,
        tier,
        limit,
      )
      .toArray()
      .map(rowToChunk);
  }

  oldestChunks(roomId: string, limit: number): ChannelMemoryChunk[] {
    return this.sql
      .exec<ChunkRow>(
        `SELECT * FROM group_memory_chunks WHERE room_id = ? ORDER BY to_ts ASC LIMIT ?`,
        roomId,
        limit,
      )
      .toArray()
      .map(rowToChunk);
  }

  countChunks(roomId?: string): number {
    const rows = roomId
      ? this.sql
          .exec<{
            n: number;
          }>(
            `SELECT COUNT(*) AS n FROM group_memory_chunks WHERE room_id = ?`,
            roomId,
          )
          .toArray()
      : this.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM group_memory_chunks`)
          .toArray();
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Keyword search over the chunks: FTS5 (`OR` of the words, ranked) when
   * the index exists and the query parses, else the Node LIKE fallback
   * (every word, newest first).
   */
  searchChunks(
    roomId: string,
    query: string,
    limit: number,
  ): ChannelMemoryChunk[] {
    const trimmed = query.trim();
    if (!trimmed) return this.recentChunks(roomId, limit);
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (this.fts) {
      const ftsQuery = words.length > 1 ? words.join(' OR ') : trimmed;
      try {
        return this.sql
          .exec<ChunkRow>(
            `SELECT c.* FROM group_memory_chunks c
               JOIN group_memory_chunks_fts f ON f.rowid = c.rowid
               WHERE c.room_id = ? AND group_memory_chunks_fts MATCH ?
               ORDER BY rank LIMIT ?`,
            roomId,
            ftsQuery,
            limit,
          )
          .toArray()
          .map(rowToChunk);
      } catch {
        // A query the FTS parser rejects (punctuation, operators): LIKE.
      }
    }
    const conditions = words
      .map(() => `summary LIKE ? ESCAPE '\\'`)
      .join(' AND ');
    const values = words.map(
      (w) => `%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`,
    );
    return this.sql
      .exec<ChunkRow>(
        `SELECT * FROM group_memory_chunks WHERE room_id = ? AND ${conditions}
         ORDER BY to_ts DESC LIMIT ?`,
        roomId,
        ...values,
        limit,
      )
      .toArray()
      .map(rowToChunk);
  }

  insertPinnedFact(fact: PinnedFact): void {
    this.sql.exec(
      `INSERT INTO group_pinned_facts (id, room_id, fact, pinned_by_did, source_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      fact.id,
      fact.roomId,
      fact.fact,
      fact.pinnedByDid,
      fact.sourceEventId ?? null,
      fact.createdAt,
    );
  }

  listPinnedFacts(roomId: string, limit = 100): PinnedFact[] {
    return this.sql
      .exec<FactRow>(
        `SELECT * FROM group_pinned_facts WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
        roomId,
        limit,
      )
      .toArray()
      .map(rowToFact);
  }

  deletePinnedFact(roomId: string, factId: string): boolean {
    const before = this.countFacts(roomId);
    this.sql.exec(
      `DELETE FROM group_pinned_facts WHERE room_id = ? AND id = ?`,
      roomId,
      factId,
    );
    return this.countFacts(roomId) < before;
  }

  countFacts(roomId?: string): number {
    const rows = roomId
      ? this.sql
          .exec<{
            n: number;
          }>(
            `SELECT COUNT(*) AS n FROM group_pinned_facts WHERE room_id = ?`,
            roomId,
          )
          .toArray()
      : this.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM group_pinned_facts`)
          .toArray();
    return Number(rows[0]?.n ?? 0);
  }

  upsertMembers(roomId: string, members: ChannelMember[], now: number): void {
    this.sql.exec(
      `INSERT INTO group_room_meta (room_id, members_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET members_json = excluded.members_json, updated_at = excluded.updated_at`,
      roomId,
      JSON.stringify(members),
      now,
    );
  }

  getMembers(roomId: string): ChannelMember[] {
    const rows = this.sql
      .exec<{
        members_json: string;
      }>(`SELECT members_json FROM group_room_meta WHERE room_id = ?`, roomId)
      .toArray();
    const raw = rows[0]?.members_json;
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (m): m is ChannelMember =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as { matrixUserId?: unknown }).matrixUserId === 'string' &&
          typeof (m as { displayName?: unknown }).displayName === 'string',
      );
    } catch {
      return [];
    }
  }

  /** Buffer a message for compaction; false when the event was already buffered (a replay). */
  bufferAppend(roomId: string, msg: ObservedMessage): boolean {
    const before = this.bufferCount(roomId);
    this.sql.exec(
      `INSERT OR IGNORE INTO group_message_buffer
        (event_id, room_id, thread_id, sender_did, sender_user_id, display_name, body, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.eventId,
      roomId,
      msg.threadId,
      msg.senderDid,
      msg.senderMatrixUserId,
      msg.senderDisplayName,
      msg.body,
      msg.timestamp,
    );
    return this.bufferCount(roomId) > before;
  }

  bufferCount(roomId?: string): number {
    const rows = roomId
      ? this.sql
          .exec<{
            n: number;
          }>(
            `SELECT COUNT(*) AS n FROM group_message_buffer WHERE room_id = ?`,
            roomId,
          )
          .toArray()
      : this.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM group_message_buffer`)
          .toArray();
    return Number(rows[0]?.n ?? 0);
  }

  /** The room's buffered messages, oldest first. */
  bufferRows(roomId: string): ObservedMessage[] {
    return this.sql
      .exec<BufferRow>(
        `SELECT * FROM group_message_buffer WHERE room_id = ? ORDER BY ts ASC, rowid ASC`,
        roomId,
      )
      .toArray()
      .map(rowToObserved);
  }

  bufferDelete(eventIds: string[]): void {
    for (const id of eventIds)
      this.sql.exec(`DELETE FROM group_message_buffer WHERE event_id = ?`, id);
  }

  markBotThread(roomId: string, threadId: string, expiresAt: number): void {
    this.sql.exec(
      `INSERT INTO group_bot_threads (room_id, thread_id, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(room_id, thread_id) DO UPDATE SET expires_at = excluded.expires_at`,
      roomId,
      threadId,
      expiresAt,
    );
  }

  /** Whether the bot answered in the thread within the TTL (the durable half of the active-thread map). */
  botThreadExpiry(roomId: string, threadId: string): number | undefined {
    const rows = this.sql
      .exec<{
        expires_at: number;
      }>(
        `SELECT expires_at FROM group_bot_threads WHERE room_id = ? AND thread_id = ?`,
        roomId,
        threadId,
      )
      .toArray();
    return rows[0] ? Number(rows[0].expires_at) : undefined;
  }

  sweepBotThreads(now: number): void {
    this.sql.exec(`DELETE FROM group_bot_threads WHERE expires_at <= ?`, now);
  }

  stats(): { buffered: number; chunks: number; facts: number } {
    return {
      buffered: this.bufferCount(),
      chunks: this.countChunks(),
      facts: this.countFacts(),
    };
  }
}

// ---------------------------------------------------------------------------
// Service — room info, display names, the gate, compaction, the read APIs
// ---------------------------------------------------------------------------

export interface GroupChatDeps {
  botUserId: string;
  /** Whether the room's canonical alias names it as a user↔oracle room of this oracle. */
  isOracleRoom(roomId: string): Promise<boolean>;
  getRoomStateEvent(
    roomId: string,
    type: string,
    stateKey?: string,
  ): Promise<JsonString | null>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  getEvent(roomId: string, eventId: string): Promise<JsonString | null>;
  getUserProfile(userId: string): Promise<{ displayname?: string } | null>;
  /** Compact a batch into a summary (`null` keeps the batch buffered). */
  summarize(messages: ObservedMessage[]): Promise<string | null>;
  /** Keeps background work alive past the request that started it (`ctx.waitUntil`). */
  keepAlive(work: Promise<unknown>): void;
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    extra?: unknown,
  ): void;
  now?(): number;
  /** The JIT compaction cap (tests shorten it). */
  jitTimeoutMs?: number;
}

export type GateReason =
  | 'dm'
  | 'mentioned'
  | 'reply-to-bot'
  | 'active-thread'
  | 'ignored'
  | 'power-level'
  /** `MATRIX_GROUP_ROOMS=silent`: a group room, nothing is answered or captured. */
  | 'group-rooms-off'
  /** `MATRIX_GROUP_ROOMS=answer`: every room is treated as direct. */
  | 'answer-all';

export interface GateInput {
  roomId: string;
  threadId: string;
  /** The message the decision is about (the latest text message of a burst). */
  eventId: string;
  sender: string;
  senderDid: string;
  body: string;
  ts: number;
  mentionsBot: boolean;
  inReplyTo?: string;
}

export interface GateDecision {
  respond: boolean;
  reason: GateReason;
  roomKind: 'direct' | 'group';
  memberCount: number;
  /** The speaker's display name in the room (their user id when unknown). */
  displayName: string;
}

export interface ChannelMemoryRecall {
  chunks: ChannelMemoryChunk[];
  pinnedFacts: PinnedFact[];
  members: ChannelMember[];
}

function parseJson(json: JsonString | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function contentOf(
  json: JsonString | null,
): Record<string, unknown> | undefined {
  const parsed = parseJson(json);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  // `getRoomStateEvent` answers with the content itself; `getEvent` with the
  // whole event. Accept both shapes.
  const maybe = parsed as { content?: unknown; type?: unknown };
  if (typeof maybe.type === 'string' && typeof maybe.content === 'object')
    return maybe.content as Record<string, unknown>;
  return parsed as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GroupChatService {
  readonly store: GroupChatStore;
  private readonly rooms = new Map<
    string,
    { info: RoomTypeInfo; expiresAt: number }
  >();
  private readonly names = new Map<
    string,
    { name: string; expiresAt: number }
  >();
  private readonly activeThreads = new Map<string, number>();
  private readonly compacting = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(
    sql: SqlStorage,
    private readonly deps: GroupChatDeps,
    readonly options: GroupChatOptions,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.store = new GroupChatStore(sql, (level, msg) => deps.log(level, msg));
  }

  // ── room info + display names ───────────────────────────────────────────

  /**
   * Node's `getRoomInfo`: the create event's `is_direct`, else ≤ 2 joined
   * members; a user↔oracle room (by alias) is direct regardless. Cached.
   */
  async roomInfo(roomId: string): Promise<RoomTypeInfo> {
    const cached = this.rooms.get(roomId);
    if (cached && cached.expiresAt > this.now()) return cached.info;
    let isDirect = await this.deps.isOracleRoom(roomId).catch(() => false);
    const create = contentOf(
      await this.deps
        .getRoomStateEvent(roomId, 'm.room.create')
        .catch(() => null),
    );
    if (create?.is_direct === true) isDirect = true;
    const joinedMemberIds = await this.deps.getJoinedRoomMembers(roomId);
    const memberCount = joinedMemberIds.length;
    if (!isDirect && memberCount > 0 && memberCount <= 2) isDirect = true;
    const info: RoomTypeInfo = { isDirect, memberCount, joinedMemberIds };
    this.sweepMaps();
    this.rooms.set(roomId, {
      info,
      expiresAt: this.now() + this.options.roomInfoTtlMs,
    });
    return info;
  }

  /** Forget a room's cached info (a membership change arrived). */
  invalidateRoom(roomId: string): void {
    this.rooms.delete(roomId);
    for (const key of this.names.keys())
      if (key.startsWith(`${roomId}|`)) this.names.delete(key);
  }

  /** A member's display name in the room: the member event, the profile, else the user id. Cached. */
  async displayName(roomId: string, userId: string): Promise<string> {
    const key = `${roomId}|${userId}`;
    const cached = this.names.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.name;
    let name: string | undefined;
    const member = contentOf(
      await this.deps
        .getRoomStateEvent(roomId, 'm.room.member', userId)
        .catch(() => null),
    );
    if (typeof member?.displayname === 'string' && member.displayname)
      name = member.displayname;
    if (!name) {
      const profile = await this.deps.getUserProfile(userId).catch(() => null);
      if (profile?.displayname) name = profile.displayname;
    }
    name ??= userId;
    this.names.set(key, {
      name,
      expiresAt: this.now() + this.options.roomInfoTtlMs,
    });
    return name;
  }

  private sweepMaps(): void {
    const now = this.now();
    for (const [key, entry] of this.rooms)
      if (entry.expiresAt <= now) this.rooms.delete(key);
    for (const [key, entry] of this.names)
      if (entry.expiresAt <= now) this.names.delete(key);
  }

  // ── the gate ────────────────────────────────────────────────────────────

  async gate(input: GateInput): Promise<GateDecision> {
    const { roomId, threadId } = input;
    if (this.options.groupRooms === 'answer')
      return {
        respond: true,
        reason: 'answer-all',
        roomKind: 'direct',
        memberCount: 0,
        displayName: input.sender,
      };
    let info: RoomTypeInfo;
    try {
      info = await this.roomInfo(roomId);
    } catch (err) {
      // Node's middleware passes through when the room cannot be read.
      this.deps.log(
        'warn',
        `[group-chat] room info failed for ${roomId}; answering as a direct room`,
        err,
      );
      return {
        respond: true,
        reason: 'dm',
        roomKind: 'direct',
        memberCount: 0,
        displayName: input.sender,
      };
    }
    const direct = info.isDirect || info.memberCount <= 2;
    // The default: the bot has no business in a group room — not a reply,
    // not a typing indicator, not a captured message.
    if (!direct && this.options.groupRooms === 'silent')
      return {
        respond: false,
        reason: 'group-rooms-off',
        roomKind: 'group',
        memberCount: info.memberCount,
        displayName: input.sender,
      };
    const displayName = await this.displayName(roomId, input.sender);
    if (direct)
      return {
        respond: true,
        reason: 'dm',
        roomKind: 'direct',
        memberCount: info.memberCount,
        displayName,
      };

    const group = {
      roomKind: 'group' as const,
      memberCount: info.memberCount,
      displayName,
    };
    // Captured whether or not the bot answers, so summaries stay accurate.
    this.observe(roomId, {
      eventId: input.eventId,
      threadId,
      senderDid: input.senderDid,
      senderMatrixUserId: input.sender,
      senderDisplayName: displayName,
      body: input.body,
      timestamp: input.ts,
    });
    this.sweepActiveThreads();

    const reason = await this.respondReason(input);
    if (reason === 'ignored') {
      this.deps.log(
        'info',
        `[group-chat] room=${roomId} thread=${threadId.slice(0, 10)} ignored`,
      );
      return { ...group, respond: false, reason };
    }

    const pl = botPowerLevelOf(
      contentOf(
        await this.deps
          .getRoomStateEvent(roomId, 'm.room.power_levels')
          .catch((err: unknown) => {
            this.deps.log(
              'warn',
              `[group-chat] power_levels read failed for ${roomId}`,
              err,
            );
            return null;
          }),
      ),
      this.deps.botUserId,
    );
    if (!pl.allowed(this.options.requirePowerLevel)) {
      this.deps.log(
        'warn',
        `[group-chat] room=${roomId} bot PL ${pl.pl} < required ${Math.max(pl.sendThreshold, this.options.requirePowerLevel)} — skipping`,
      );
      return { ...group, respond: false, reason: 'power-level' };
    }

    this.markActive(roomId, threadId);
    this.deps.keepAlive(this.refreshMembers(roomId).catch(() => undefined));
    await this.compactJustInTime(roomId);
    return { ...group, respond: true, reason };
  }

  private async respondReason(
    input: GateInput,
  ): Promise<
    Exclude<GateReason, 'dm' | 'power-level' | 'group-rooms-off' | 'answer-all'>
  > {
    const { roomId, threadId } = input;
    if (input.mentionsBot) return 'mentioned';
    if (input.inReplyTo && (await this.isBotEvent(roomId, input.inReplyTo)))
      return 'reply-to-bot';
    if (this.isActiveThread(roomId, threadId)) return 'active-thread';
    // A bare message roots its own thread: nothing to look up for it.
    if (threadId !== input.eventId) {
      const expiry = this.store.botThreadExpiry(roomId, threadId);
      if (expiry !== undefined && expiry > this.now()) {
        this.activeThreads.set(activeKey(roomId, threadId), expiry);
        return 'active-thread';
      }
    }
    return 'ignored';
  }

  private async isBotEvent(roomId: string, eventId: string): Promise<boolean> {
    try {
      const parsed = parseJson(await this.deps.getEvent(roomId, eventId));
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { sender?: unknown }).sender === this.deps.botUserId
      );
    } catch (err) {
      this.deps.log(
        'warn',
        `[group-chat] could not fetch reply target ${eventId} in ${roomId}`,
        err,
      );
      return false;
    }
  }

  private isActiveThread(roomId: string, threadId: string): boolean {
    const key = activeKey(roomId, threadId);
    const expiresAt = this.activeThreads.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.activeThreads.delete(key);
      return false;
    }
    return true;
  }

  /** Mark a thread as one the bot is engaged in (memory + durable). */
  markActive(roomId: string, threadId: string): void {
    const expiresAt = this.now() + this.options.activeThreadTtlMs;
    this.activeThreads.set(activeKey(roomId, threadId), expiresAt);
    this.store.markBotThread(roomId, threadId, expiresAt);
  }

  private sweepActiveThreads(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.activeThreads)
      if (expiresAt <= now) this.activeThreads.delete(key);
    this.store.sweepBotThreads(now);
  }

  // ── capture + compaction ────────────────────────────────────────────────

  observe(roomId: string, message: ObservedMessage): void {
    if (!this.store.bufferAppend(roomId, message)) return;
    if (this.store.bufferCount(roomId) >= COMPACT_BUFFER_THRESHOLD)
      this.deps.keepAlive(
        this.compact(roomId).catch((err: unknown) =>
          this.deps.log(
            'warn',
            `[group-chat] threshold compaction failed for ${roomId}`,
            err,
          ),
        ),
      );
  }

  /** Compact a buffer of ≥ 5 before the bot answers, bounded so the reply is not held up. */
  async compactJustInTime(roomId: string): Promise<void> {
    if (this.store.bufferCount(roomId) < COMPACT_JIT_MIN) return;
    const work = this.compact(roomId).catch((err: unknown) =>
      this.deps.log(
        'warn',
        `[group-chat] JIT compaction failed for ${roomId}`,
        err,
      ),
    );
    this.deps.keepAlive(work);
    await Promise.race([
      work,
      sleep(this.deps.jitTimeoutMs ?? COMPACT_JIT_TIMEOUT_MS),
    ]);
  }

  /** Summarize the room's buffer into one chunk (single-flight per room). */
  compact(roomId: string): Promise<void> {
    const inFlight = this.compacting.get(roomId);
    if (inFlight) return inFlight;
    const work = this.compactInner(roomId).finally(() => {
      this.compacting.delete(roomId);
    });
    this.compacting.set(roomId, work);
    return work;
  }

  private async compactInner(roomId: string): Promise<void> {
    const drained = this.store.bufferRows(roomId);
    const first = drained[0];
    const last = drained[drained.length - 1];
    if (!first || !last) return;
    const summary = await this.deps.summarize(drained);
    if (!summary) {
      this.deps.log(
        'warn',
        `[group-chat] summary unavailable; ${drained.length} messages stay buffered for ${roomId}`,
      );
      return;
    }
    const chunk: ChannelMemoryChunk = {
      id: crypto.randomUUID(),
      roomId,
      summary,
      fromEventId: first.eventId,
      toEventId: last.eventId,
      fromTimestamp: first.timestamp,
      toTimestamp: last.timestamp,
      messageCount: drained.length,
      participants: Array.from(new Set(drained.map((m) => m.senderDid))),
      threadIds: Array.from(new Set(drained.map((m) => m.threadId))),
      tier: 1,
      createdAt: this.now(),
    };
    this.store.insertChunk(chunk);
    this.store.bufferDelete(drained.map((m) => m.eventId));
    this.deps.log(
      'info',
      `[group-chat] room=${roomId} chunk=${chunk.id} msgs=${chunk.messageCount} totalChunks=${this.store.countChunks(roomId)}`,
    );
  }

  // ── read APIs (the four tools) ──────────────────────────────────────────

  /** The joined members (bot excluded) with display names, stored for the roster. */
  async refreshMembers(roomId: string): Promise<ChannelMember[]> {
    try {
      const info = await this.roomInfo(roomId);
      const members: ChannelMember[] = [];
      for (const userId of info.joinedMemberIds) {
        if (userId === this.deps.botUserId) continue;
        members.push({
          matrixUserId: userId,
          displayName: await this.displayName(roomId, userId),
        });
      }
      this.store.upsertMembers(roomId, members, this.now());
      return members;
    } catch (err) {
      this.deps.log(
        'warn',
        `[group-chat] refreshMembers failed for ${roomId}`,
        err,
      );
      return this.store.getMembers(roomId);
    }
  }

  recall(roomId: string, limit = RECALL_DEFAULT_CHUNKS): ChannelMemoryRecall {
    const cap = Math.max(1, Math.min(RECALL_MAX_CHUNKS, limit));
    return {
      chunks: this.store.recentChunks(roomId, cap),
      pinnedFacts: this.store.listPinnedFacts(roomId),
      members: this.store.getMembers(roomId),
    };
  }

  search(
    roomId: string,
    query: string,
    limit = RECALL_DEFAULT_CHUNKS,
  ): ChannelMemoryChunk[] {
    return this.store.searchChunks(
      roomId,
      query,
      Math.max(1, Math.min(RECALL_MAX_CHUNKS, limit)),
    );
  }

  pinFact(args: {
    roomId: string;
    fact: string;
    pinnedByDid: string;
    sourceEventId?: string;
  }): PinnedFact {
    const fact: PinnedFact = {
      id: crypto.randomUUID(),
      roomId: args.roomId,
      fact: args.fact.trim().slice(0, PINNED_FACT_MAX_CHARS),
      pinnedByDid: args.pinnedByDid,
      ...(args.sourceEventId ? { sourceEventId: args.sourceEventId } : {}),
      createdAt: this.now(),
    };
    this.store.insertPinnedFact(fact);
    return fact;
  }

  unpinFact(roomId: string, factId: string): boolean {
    return this.store.deletePinnedFact(roomId, factId);
  }

  stats() {
    return this.store.stats();
  }
}
