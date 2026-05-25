import { MatrixManager } from '@ixo/matrix';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { File } from 'node:buffer';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  getMediaFromRoomByStorageKey,
  uploadMediaToRoom,
} from '../../matrix/checkpointer/matrix-upload-utils.js';
import { ChannelMemoryRepo } from './channel-memory.repo.js';
import {
  ChannelMemorySummarizer,
  type Summarizer,
} from './channel-memory.summarizer.js';
import {
  type ChannelMember,
  type ChannelMemoryChunk,
  type ObservedMessage,
  type PinnedFact,
} from './channel-memory.types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

const logger = new Logger('ChannelMemoryService');

const COMPACT_BUFFER_THRESHOLD = 20;
const COMPACT_IDLE_MS = 5 * 60 * 1000;
const COMPACT_JIT_MIN = 5;
const COMPACT_JIT_TIMEOUT_MS = 3000;
const BUFFER_HARD_CAP = 40;
const SESSION_INJECT_RECENT_CHUNKS = 8;
const SESSION_INJECT_OLDEST_CHUNKS = 2;
const SESSION_INJECT_LAST_MESSAGES = 15;

const MATRIX_STORAGE_KEY = 'qiforge.channel_memory.v1';
const DEFAULT_SYNC_DEBOUNCE_MS = 60 * 1000;
const DEFAULT_DB_PATH = './data/channel_memory';

export interface ChannelMemoryServiceConfig {
  dbPath?: string;
  syncDebounceMs?: number;
  oracleDid?: string;
  /** Disable Matrix sync entirely (e.g. unit tests). */
  matrixSyncDisabled?: boolean;
}

export const CHANNEL_MEMORY_SERVICE_CONFIG = Symbol.for(
  'CHANNEL_MEMORY_SERVICE_CONFIG',
);

export const CHANNEL_MEMORY_SUMMARIZER = Symbol.for(
  'CHANNEL_MEMORY_SUMMARIZER',
);

interface BufferEntry {
  messages: ObservedMessage[];
  idleTimer: NodeJS.Timeout | null;
}

interface RoomEntry {
  repo: ChannelMemoryRepo;
  dbPath: string;
  dirty: boolean;
  syncTimer: NodeJS.Timeout | null;
  uploadInFlight: Promise<void> | null;
  /** sha256 of the last gzipped+SQLite snapshot uploaded — skips re-upload when unchanged. */
  lastUploadedChecksum: string | undefined;
}

/**
 * Channel memory pipeline. One SQLite DB per Matrix room (under
 * `dbPath/channel_memory/`), each synced as encrypted media to its own
 * Matrix room. On first access the service tries to download the latest
 * snapshot from the room before opening locally; on writes it schedules a
 * debounced upload back to the room.
 *
 * Compaction triggers when the buffer hits a threshold, an idle timeout
 * elapses, or the agent is about to be engaged (`compactJustInTime`).
 */
@Injectable()
export class ChannelMemoryService implements OnModuleInit, OnModuleDestroy {
  private static singleton: ChannelMemoryService | undefined;

  private readonly buffer = new Map<string, BufferEntry>();
  private readonly compactionInFlight = new Map<string, Promise<void>>();
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly opening = new Map<string, Promise<RoomEntry>>();

  private rootDir!: string;
  private oracleDid!: string;
  private syncDebounceMs!: number;
  private matrixSyncDisabled = false;

  constructor(
    @Optional() private readonly config: ConfigService | null,
    @Optional()
    @Inject(CHANNEL_MEMORY_SERVICE_CONFIG)
    private readonly overrides: ChannelMemoryServiceConfig | null,
    @Optional()
    @Inject(CHANNEL_MEMORY_SUMMARIZER)
    private readonly summarizer: Summarizer = new ChannelMemorySummarizer(),
  ) {}

  static getInstance(): ChannelMemoryService | undefined {
    return ChannelMemoryService.singleton;
  }

  /** Test-only — wipe the singleton so a fresh instance can register. */
  static resetSingleton(): void {
    ChannelMemoryService.singleton = undefined;
  }

  onModuleInit(): void {
    const cfg = this.overrides ?? {};
    const baseDir =
      cfg.dbPath ??
      this.config?.get<string>('SQLITE_DATABASE_PATH') ??
      DEFAULT_DB_PATH;
    this.rootDir = path.resolve(baseDir);
    fs.mkdirSync(this.rootDir, { recursive: true });

    this.oracleDid =
      cfg.oracleDid ??
      this.config?.get<string>('ORACLE_ENTITY_DID') ??
      this.config?.get<string>('ORACLE_DID') ??
      'unknown-oracle';

    this.syncDebounceMs =
      cfg.syncDebounceMs ??
      Number(
        this.config?.get<string | number>('CHANNEL_MEMORY_SYNC_INTERVAL_MS') ??
          DEFAULT_SYNC_DEBOUNCE_MS,
      );

    this.matrixSyncDisabled = cfg.matrixSyncDisabled ?? false;

    ChannelMemoryService.singleton = this;
    logger.log(`DB root ready at ${this.rootDir}`);
  }

  async onModuleDestroy(): Promise<void> {
    for (const entry of this.buffer.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    this.buffer.clear();

    const flushes: Array<Promise<void>> = [];
    for (const [roomId, room] of this.rooms) {
      if (room.syncTimer) {
        clearTimeout(room.syncTimer);
        room.syncTimer = null;
      }
      if (room.dirty || room.uploadInFlight) {
        flushes.push(this.syncToMatrix(roomId).catch(() => undefined));
      }
    }
    await Promise.allSettled(flushes);

    for (const room of this.rooms.values()) {
      try {
        room.repo.close();
      } catch {
        // ignore — best-effort shutdown
      }
    }
    this.rooms.clear();

    if (ChannelMemoryService.singleton === this) {
      ChannelMemoryService.singleton = undefined;
    }
  }

  // ── Per-room DB lifecycle ───────────────────────────────────────────────

  private dbPathFor(roomId: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${roomId}|${this.oracleDid}`)
      .digest('hex')
      .slice(0, 24);
    return path.join(this.rootDir, `${hash}.db`);
  }

  private async getRoom(roomId: string): Promise<RoomEntry> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const opening = this.opening.get(roomId);
    if (opening) return opening;

    const promise = (async () => {
      const dbPath = this.dbPathFor(roomId);
      await this.maybeRestoreFromMatrix(roomId, dbPath);
      const repo = new ChannelMemoryRepo(dbPath);
      const entry: RoomEntry = {
        repo,
        dbPath,
        dirty: false,
        syncTimer: null,
        uploadInFlight: null,
        lastUploadedChecksum: undefined,
      };
      this.rooms.set(roomId, entry);
      return entry;
    })().finally(() => {
      this.opening.delete(roomId);
    });

    this.opening.set(roomId, promise);
    return promise;
  }

  /**
   * Restore from Matrix when the local file is missing. The snapshot is
   * gzipped on upload (mirrors the user-DB pattern), so we gunzip on
   * download and fall back to using the raw buffer when it's already a
   * valid SQLite header (legacy snapshots).
   */
  private async maybeRestoreFromMatrix(
    roomId: string,
    dbPath: string,
  ): Promise<void> {
    if (this.matrixSyncDisabled) return;
    if (fs.existsSync(dbPath)) return;

    let remote: Awaited<ReturnType<typeof getMediaFromRoomByStorageKey>>;
    try {
      remote = await getMediaFromRoomByStorageKey(roomId, MATRIX_STORAGE_KEY);
    } catch (err) {
      logger.warn(
        `Restore from Matrix failed for room=${roomId}; starting fresh. ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!remote) {
      logger.log(`No prior DB in Matrix for room=${roomId}; starting fresh`);
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await gunzipAsync(remote.mediaBuffer);
    } catch {
      if (
        remote.mediaBuffer.length >= 16 &&
        remote.mediaBuffer.subarray(0, 16).equals(SQLITE_MAGIC)
      ) {
        buffer = remote.mediaBuffer;
      } else {
        logger.warn(
          `Restored payload for room=${roomId} is neither valid gzip nor SQLite — starting fresh`,
        );
        return;
      }
    }

    if (
      buffer.length < 16 ||
      !buffer.subarray(0, 16).equals(SQLITE_MAGIC)
    ) {
      logger.warn(
        `Restored DB for room=${roomId} has invalid SQLite header — starting fresh`,
      );
      return;
    }

    const tmp = `${dbPath}.tmp`;
    try {
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, dbPath);
      logger.log(
        `Restored channel-memory DB for room=${roomId} (${buffer.length} bytes)`,
      );
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  private markDirty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.dirty = true;
    if (this.matrixSyncDisabled) return;
    if (room.syncTimer) clearTimeout(room.syncTimer);
    room.syncTimer = setTimeout(() => {
      this.syncToMatrix(roomId).catch((err) => {
        logger.warn(
          `debounced sync failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.syncDebounceMs);
  }

  private async syncToMatrix(roomId: string): Promise<void> {
    if (this.matrixSyncDisabled) return;
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.uploadInFlight) {
      await room.uploadInFlight;
      if (!room.dirty) return;
    }
    if (!room.dirty) return;

    const upload = (async () => {
      room.repo.checkpoint();
      const snapshotPath = `${room.dbPath}.snap-${Date.now()}`;
      try {
        await fsp.copyFile(room.dbPath, snapshotPath);
        const raw = await fsp.readFile(snapshotPath);
        const checksum = crypto
          .createHash('sha256')
          .update(raw)
          .digest('hex');
        if (checksum === room.lastUploadedChecksum) {
          room.dirty = false;
          return;
        }
        const compressed = await gzipAsync(raw);
        const file = new File([compressed], `${MATRIX_STORAGE_KEY}.db.gz`, {
          type: 'application/gzip',
          lastModified: Date.now(),
        });
        await uploadMediaToRoom(roomId, file, MATRIX_STORAGE_KEY);
        room.dirty = false;
        room.lastUploadedChecksum = checksum;
        logger.log(
          `Uploaded DB to room=${roomId} (${raw.length}B raw, ${compressed.length}B gz)`,
        );
      } finally {
        await fsp.unlink(snapshotPath).catch(() => undefined);
      }
    })();

    room.uploadInFlight = upload;
    try {
      await upload;
    } finally {
      room.uploadInFlight = null;
    }
  }

  /** Public for the tier scheduler — force-flush all known rooms to Matrix. */
  async flushAll(): Promise<void> {
    const ids = Array.from(this.rooms.keys());
    await Promise.allSettled(ids.map((id) => this.syncToMatrix(id)));
  }

  // ── Capture + compaction ────────────────────────────────────────────────

  observeMessage(roomId: string, message: ObservedMessage): void {
    let entry = this.buffer.get(roomId);
    if (!entry) {
      entry = { messages: [], idleTimer: null };
      this.buffer.set(roomId, entry);
    }
    entry.messages.push(message);

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.compact(roomId).catch((err) =>
        logger.warn(
          `idle compaction failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, COMPACT_IDLE_MS);

    if (entry.messages.length >= COMPACT_BUFFER_THRESHOLD) {
      void this.compact(roomId).catch((err) =>
        logger.warn(
          `threshold compaction failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } else if (entry.messages.length >= BUFFER_HARD_CAP) {
      void this.compact(roomId);
    }
  }

  async compactJustInTime(roomId: string): Promise<void> {
    const entry = this.buffer.get(roomId);
    if (!entry || entry.messages.length < COMPACT_JIT_MIN) return;

    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, COMPACT_JIT_TIMEOUT_MS),
    );
    await Promise.race([this.compact(roomId), timeout]).catch((err) =>
      logger.warn(
        `JIT compaction error for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  private async compact(roomId: string): Promise<void> {
    const inFlight = this.compactionInFlight.get(roomId);
    if (inFlight) return inFlight;

    const promise = this.compactInner(roomId).finally(() => {
      this.compactionInFlight.delete(roomId);
    });
    this.compactionInFlight.set(roomId, promise);
    return promise;
  }

  private async compactInner(roomId: string): Promise<void> {
    const entry = this.buffer.get(roomId);
    if (!entry || entry.messages.length === 0) return;

    const drained = entry.messages.slice();
    entry.messages.length = 0;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    const first = drained[0];
    const last = drained[drained.length - 1];
    if (!first || !last) return;

    const summary = await this.summarizer.summarize(drained);
    if (!summary) {
      entry.messages.unshift(...drained);
      logger.warn(
        `summary unavailable; ${drained.length} msgs requeued for ${roomId}`,
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
      createdAt: Date.now(),
    };

    try {
      const room = await this.getRoom(roomId);
      room.repo.insertChunk(chunk);
      this.markDirty(roomId);
      logger.log(
        `room=${roomId} chunk=${chunk.id} msgs=${chunk.messageCount} totalChunks=${room.repo.countChunks(roomId)}`,
      );
    } catch (err) {
      logger.error(
        `insertChunk failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Used by the tier scheduler — drives a rollup transaction for one room. */
  async rollupTier(
    roomId: string,
    sourceTier: number,
    olderThanTs: number,
    bucketMs: number,
    minChunksPerBucket: number,
  ): Promise<number> {
    const room = await this.getRoom(roomId);
    const candidates = room.repo.findRollupCandidates(roomId, {
      sourceTier,
      olderThanTs,
      bucketMs,
      minChunksPerBucket,
    });
    if (candidates.length === 0) return 0;

    let rolledUp = 0;
    for (const candidate of candidates) {
      const rollup = await this.summarizer.rollup(
        candidate.chunks.map((c) => c.summary),
      );
      if (!rollup) continue;

      const first = candidate.chunks[0];
      const last = candidate.chunks[candidate.chunks.length - 1];
      if (!first || !last) continue;

      const participants = Array.from(
        new Set(candidate.chunks.flatMap((c) => c.participants)),
      );
      const threadIds = Array.from(
        new Set(candidate.chunks.flatMap((c) => c.threadIds)),
      );
      const messageCount = candidate.chunks.reduce(
        (n, c) => n + c.messageCount,
        0,
      );
      const consolidated: ChannelMemoryChunk = {
        id: crypto.randomUUID(),
        roomId,
        summary: rollup,
        fromEventId: first.fromEventId,
        toEventId: last.toEventId,
        fromTimestamp: first.fromTimestamp,
        toTimestamp: last.toTimestamp,
        messageCount,
        participants,
        threadIds,
        tier: candidate.toTier,
        createdAt: Date.now(),
      };

      room.repo.replaceWithRollup(
        candidate.chunks.map((c) => c.id),
        consolidated,
      );
      rolledUp += candidate.chunks.length;
    }
    if (rolledUp > 0) this.markDirty(roomId);
    return rolledUp;
  }

  listOpenRoomIds(): string[] {
    return Array.from(this.rooms.keys());
  }

  // ── Read APIs ───────────────────────────────────────────────────────────

  async recentChunks(
    roomId: string,
    limit = SESSION_INJECT_RECENT_CHUNKS,
  ): Promise<ChannelMemoryChunk[]> {
    const room = await this.getRoom(roomId);
    return room.repo.recentChunks(roomId, limit);
  }

  async oldestChunks(
    roomId: string,
    limit = SESSION_INJECT_OLDEST_CHUNKS,
  ): Promise<ChannelMemoryChunk[]> {
    const room = await this.getRoom(roomId);
    return room.repo.oldestChunks(roomId, limit);
  }

  async search(
    roomId: string,
    query: string,
    limit = 10,
  ): Promise<ChannelMemoryChunk[]> {
    const room = await this.getRoom(roomId);
    return room.repo.searchChunks(roomId, query, limit);
  }

  async listPinnedFacts(roomId: string): Promise<PinnedFact[]> {
    const room = await this.getRoom(roomId);
    return room.repo.listPinnedFacts(roomId);
  }

  async pinFact(args: {
    roomId: string;
    fact: string;
    pinnedByDid: string;
    sourceEventId?: string;
  }): Promise<PinnedFact> {
    const fact: PinnedFact = {
      id: crypto.randomUUID(),
      roomId: args.roomId,
      fact: args.fact,
      pinnedByDid: args.pinnedByDid,
      sourceEventId: args.sourceEventId,
      createdAt: Date.now(),
    };
    const room = await this.getRoom(args.roomId);
    room.repo.insertPinnedFact(fact);
    this.markDirty(args.roomId);
    return fact;
  }

  async unpinFact(roomId: string, factId: string): Promise<boolean> {
    const room = await this.getRoom(roomId);
    const ok = room.repo.deletePinnedFact(roomId, factId);
    if (ok) this.markDirty(roomId);
    return ok;
  }

  async getMembers(roomId: string): Promise<ChannelMember[]> {
    const room = await this.getRoom(roomId);
    return room.repo.getMembers(roomId);
  }

  /**
   * Pull the room member roster from Matrix (display names + matrix user IDs),
   * upsert into the local DB. Returns the freshly fetched list — falls back
   * to the cached roster if Matrix fetch fails.
   */
  async refreshMembers(
    roomId: string,
    matrixManager: MatrixManager = MatrixManager.getInstance(),
  ): Promise<ChannelMember[]> {
    try {
      const info = await matrixManager.getRoomInfo(roomId);
      const botUserId = matrixManager.getBotMatrixUserId();
      const members: ChannelMember[] = [];
      for (const userId of info.joinedMemberIds) {
        if (userId === botUserId) continue;
        const displayName = await matrixManager.getCachedDisplayName(
          userId,
          roomId,
        );
        members.push({ matrixUserId: userId, displayName });
      }
      const room = await this.getRoom(roomId);
      room.repo.upsertMembers(roomId, members);
      this.markDirty(roomId);
      return members;
    } catch (err) {
      logger.warn(
        `refreshMembers failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        const room = await this.getRoom(roomId);
        return room.repo.getMembers(roomId);
      } catch {
        return [];
      }
    }
  }

  /**
   * Build the system-prompt-ready context block injected at the start of a
   * group-room session. Combines member roster, pinned facts, recent +
   * oldest summary chunks, and the last K verbatim messages.
   */
  async buildSessionContext(
    roomId: string,
    matrixManager: MatrixManager = MatrixManager.getInstance(),
  ): Promise<string> {
    const [members, recent, oldest, facts, recentMsgs] = await Promise.all([
      this.refreshMembers(roomId, matrixManager),
      this.recentChunks(roomId),
      this.oldestChunks(roomId),
      this.listPinnedFacts(roomId),
      matrixManager
        .getRecentRoomMessages(roomId, { limit: SESSION_INJECT_LAST_MESSAGES })
        .catch((err) => {
          logger.warn(
            `live recent fetch failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { messages: [] as Array<{
            eventId: string;
            sender: string;
            body: string;
            timestamp: number;
            threadId?: string;
          }> };
        }),
    ]);

    const sections: string[] = [];

    sections.push(
      `You are participating in a Matrix group chat. User messages are prefixed with "[DisplayName]:" so you know who is speaking. Address users by their display name when relevant. Stay quiet unless explicitly mentioned, replied to, or already in an active thread with you.`,
    );

    if (members.length > 0) {
      const lines = members
        .map((m) => `- ${m.displayName} (${m.matrixUserId})`)
        .join('\n');
      sections.push(`## Members in this room\n${lines}`);
    }

    if (facts.length > 0) {
      const lines = facts.map((f) => `- ${f.fact}`).join('\n');
      sections.push(`## Pinned facts\n${lines}`);
    }

    const seen = new Set<string>();
    const ordered: ChannelMemoryChunk[] = [];
    for (const c of oldest) {
      if (!seen.has(c.id)) {
        ordered.push(c);
        seen.add(c.id);
      }
    }
    for (const c of recent) {
      if (!seen.has(c.id)) {
        ordered.push(c);
        seen.add(c.id);
      }
    }

    if (ordered.length > 0) {
      const lines = ordered
        .map((c) => {
          const when = new Date(c.toTimestamp).toISOString();
          const tierTag = c.tier > 1 ? ` tier=${c.tier}` : '';
          return `### [${when}${tierTag}] ${c.messageCount} msgs\n${c.summary}`;
        })
        .join('\n\n');
      sections.push(`## Channel memory\n${lines}`);
    }

    if (recentMsgs.messages.length > 0) {
      const lines = await Promise.all(
        recentMsgs.messages.map(async (m) => {
          const dn = await matrixManager
            .getCachedDisplayName(m.sender, roomId)
            .catch(() => m.sender);
          const when = new Date(m.timestamp).toISOString();
          const thread = m.threadId ? ` thread=${m.threadId.slice(0, 10)}` : '';
          return `[${dn} @ ${when}${thread}]: ${m.body}`;
        }),
      );
      sections.push(`## Recent messages (verbatim)\n${lines.join('\n')}`);
    }

    sections.push(
      `Tools available for this room: search_channel_memory, recall_channel_memory, pin_room_fact, unpin_room_fact.`,
    );

    return sections.join('\n\n');
  }
}
