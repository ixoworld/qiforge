import { MatrixManager } from '@ixo/matrix';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getMediaFromRoomByStorageKey,
  uploadMediaToRoom,
} from 'src/user-matrix-sqlite-sync-service/matrix-upload-utils';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { File } from 'node:buffer';
import * as path from 'node:path';
import { type ENV } from '../types';
import { ChannelMemoryRepo } from './channel-memory.repo';
import { ChannelMemorySummarizer } from './channel-memory.summarizer';
import {
  type ChannelMember,
  type ChannelMemoryChunk,
  type ObservedMessage,
  type PinnedFact,
} from './channel-memory.types';

const logger = new Logger('ChannelMemoryService');

const COMPACT_BUFFER_THRESHOLD = 20;
const COMPACT_IDLE_MS = 5 * 60 * 1000;
const COMPACT_JIT_MIN = 5;
const COMPACT_JIT_TIMEOUT_MS = 3000;
const BUFFER_HARD_CAP = 40;
const SESSION_INJECT_RECENT_CHUNKS = 8;
const SESSION_INJECT_OLDEST_CHUNKS = 2;
const SESSION_INJECT_LAST_MESSAGES = 15;

/**
 * Storage key used when uploading the per-room channel-memory DB to Matrix.
 * Same key in every room — the room id implicitly disambiguates.
 */
const MATRIX_STORAGE_KEY = 'qiforge.channel_memory.v1';

/** Debounce window between a write and the eventual upload to Matrix. */
const SYNC_DEBOUNCE_MS = 60 * 1000;

interface BufferEntry {
  messages: ObservedMessage[];
  idleTimer: NodeJS.Timeout | null;
}

interface RoomEntry {
  repo: ChannelMemoryRepo;
  dbPath: string;
  /** Set true after any write; reset to false after a successful Matrix upload. */
  dirty: boolean;
  /** Pending upload timer, debounced after each write. */
  syncTimer: NodeJS.Timeout | null;
  /** In-flight upload promise — serializes overlapping syncs per room. */
  uploadInFlight: Promise<void> | null;
}

/**
 * Channel memory pipeline.
 *
 * One SQLite DB per Matrix room (under `${SQLITE_DATABASE_PATH}/channel_memory/`),
 * each synced as encrypted media to its own Matrix room — same mechanism the
 * user-DB sync service uses, just keyed per-room. On first access the service
 * tries to download the latest DB from the room before opening locally; on
 * dirty + shutdown it uploads.
 *
 * Compaction is triggered when:
 *   - Buffer reaches COMPACT_BUFFER_THRESHOLD, or
 *   - COMPACT_IDLE_MS elapses with no new messages in the buffer, or
 *   - just-in-time when the agent is about to be engaged (`compactJustInTime`).
 *
 * Buffer is in-memory only — losing it on restart is acceptable since Matrix
 * retains the raw messages and the next compaction picks up where we left off.
 */
@Injectable()
export class ChannelMemoryService implements OnModuleInit, OnModuleDestroy {
  private static singleton: ChannelMemoryService | undefined;

  private readonly summarizer = new ChannelMemorySummarizer();
  private readonly buffer = new Map<string, BufferEntry>();
  /** Per-room compaction promise to serialize concurrent triggers. */
  private readonly compactionInFlight = new Map<string, Promise<void>>();
  /** Open DBs keyed by roomId. */
  private readonly rooms = new Map<string, RoomEntry>();
  /** Locks getRoom() against concurrent open + matrix-download for the same room. */
  private readonly opening = new Map<string, Promise<RoomEntry>>();

  private rootDir!: string;

  constructor(private readonly config: ConfigService<ENV>) {}

  static getInstance(): ChannelMemoryService | undefined {
    return ChannelMemoryService.singleton;
  }

  onModuleInit(): void {
    const baseDir = this.config.getOrThrow<string>('SQLITE_DATABASE_PATH');
    this.rootDir = path.join(baseDir, 'channel_memory');
    fs.mkdirSync(this.rootDir, { recursive: true });
    ChannelMemoryService.singleton = this;
    logger.log(`[ChannelMemory] DB root ready at ${this.rootDir}`);
  }

  async onModuleDestroy(): Promise<void> {
    // Stop scheduled work first
    for (const entry of this.buffer.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    this.buffer.clear();

    // Drain any pending uploads, then close DBs
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
    // Hash roomId so we get a filesystem-safe filename and avoid leaking
    // raw Matrix room ids into the local FS layout.
    const oracleDid = this.config.getOrThrow<string>('ORACLE_DID');
    const hash = crypto
      .createHash('sha256')
      .update(`${roomId}|${oracleDid}`)
      .digest('hex')
      .slice(0, 24);
    return path.join(this.rootDir, `${hash}.db`);
  }

  /**
   * Get (or open) the per-room repo. Lazily downloads the latest DB from the
   * Matrix room before opening if no local file exists. Returns the repo
   * once ready.
   */
  private async getRoom(roomId: string): Promise<RoomEntry> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const opening = this.opening.get(roomId);
    if (opening) return opening;

    const promise = (async () => {
      const dbPath = this.dbPathFor(roomId);

      if (!fs.existsSync(dbPath)) {
        await this.tryRestoreFromMatrix(roomId, dbPath);
      }

      const repo = new ChannelMemoryRepo(dbPath);
      const entry: RoomEntry = {
        repo,
        dbPath,
        dirty: false,
        syncTimer: null,
        uploadInFlight: null,
      };
      this.rooms.set(roomId, entry);
      return entry;
    })().finally(() => {
      this.opening.delete(roomId);
    });

    this.opening.set(roomId, promise);
    return promise;
  }

  private async tryRestoreFromMatrix(
    roomId: string,
    dbPath: string,
  ): Promise<void> {
    try {
      const result = await getMediaFromRoomByStorageKey(
        roomId,
        MATRIX_STORAGE_KEY,
      );
      if (!result) {
        logger.log(
          `[ChannelMemory] No prior DB in Matrix for room=${roomId}; starting fresh`,
        );
        return;
      }
      await fsp.writeFile(dbPath, result.mediaBuffer);
      logger.log(
        `[ChannelMemory] Restored channel-memory DB for room=${roomId} (${result.mediaBuffer.length} bytes)`,
      );
    } catch (err) {
      logger.warn(
        `[ChannelMemory] Restore from Matrix failed for room=${roomId}; starting fresh. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private markDirty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.dirty = true;
    if (room.syncTimer) clearTimeout(room.syncTimer);
    room.syncTimer = setTimeout(() => {
      this.syncToMatrix(roomId).catch((err) => {
        logger.warn(
          `[ChannelMemory] debounced sync failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, SYNC_DEBOUNCE_MS);
  }

  private async syncToMatrix(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.uploadInFlight) {
      await room.uploadInFlight;
      // If still dirty after the previous upload, fall through and re-upload.
      if (!room.dirty) return;
    }

    if (!room.dirty) return;

    const upload = (async () => {
      // Take a snapshot copy to a temp file to avoid uploading a partially
      // mutated DB. Better-sqlite3's WAL means in-place reads are fine, but
      // a copy is cheap and rules out races with future writes.
      const snapshotPath = `${room.dbPath}.snap-${Date.now()}`;
      try {
        await fsp.copyFile(room.dbPath, snapshotPath);
        const buf = await fsp.readFile(snapshotPath);
        const file = new File([buf], 'channel_memory.db', {
          type: 'application/x-sqlite3',
        });
        await uploadMediaToRoom(roomId, file, MATRIX_STORAGE_KEY);
        room.dirty = false;
        logger.log(
          `[ChannelMemory] Uploaded DB to room=${roomId} (${buf.length} bytes)`,
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
          `[ChannelMemory] idle compaction failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, COMPACT_IDLE_MS);

    if (entry.messages.length >= COMPACT_BUFFER_THRESHOLD) {
      void this.compact(roomId).catch((err) =>
        logger.warn(
          `[ChannelMemory] threshold compaction failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
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
        `[ChannelMemory] JIT compaction error for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
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

    const summary = await this.summarizer.summarize(drained);
    if (!summary) {
      entry.messages.unshift(...drained);
      logger.warn(
        `[ChannelMemory] summary unavailable; ${drained.length} msgs requeued for ${roomId}`,
      );
      return;
    }

    const chunk: ChannelMemoryChunk = {
      id: crypto.randomUUID(),
      roomId,
      summary,
      fromEventId: drained[0].eventId,
      toEventId: drained[drained.length - 1].eventId,
      fromTimestamp: drained[0].timestamp,
      toTimestamp: drained[drained.length - 1].timestamp,
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
        `[ChannelMemory] room=${roomId} chunk=${chunk.id} msgs=${chunk.messageCount} totalChunks=${room.repo.countChunks(roomId)}`,
      );
    } catch (err) {
      logger.error(
        `[ChannelMemory] insertChunk failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Read APIs (used by tools and session-start injection) ───────────────

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

  async refreshMembers(
    roomId: string,
    matrixManager: MatrixManager,
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
        `[ChannelMemory] refreshMembers failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
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
   * group-room session. Combines:
   *   - Member roster
   *   - Pinned facts
   *   - Last N recent chunks (recency)
   *   - Oldest few chunks (anchoring)
   *   - Last K raw room messages for immediate freshness
   */
  async buildSessionContext(
    roomId: string,
    matrixManager: MatrixManager,
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
            `[ChannelMemory] live recent fetch failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { messages: [] };
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
          return `### [${when}] ${c.messageCount} msgs\n${c.summary}`;
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
      `Tools available for this room: search_channel_memory, recall_channel_memory, get_room_messages_range, pin_room_fact, unpin_room_fact.`,
    );

    return sections.join('\n\n');
  }
}
