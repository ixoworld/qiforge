import { Logger } from '@ixo/logger';
import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { type Database } from 'better-sqlite3';
import { type UserContextData } from '../memory-engine/types.js';
import {
  type ChatSession,
  type CreateChatSessionDto,
  type CreateChatSessionResponseDto,
  type DeleteChatSessionDto,
  type ListChatSessionsDto,
  type ListChatSessionsResponseDto,
} from './dto.js';
import {
  generateSessionTitle,
  needsTitle,
  UNTITLED_SESSION,
  type SessionTitleInput,
} from './session-title.js';

export interface IDatabaseSyncService {
  getUserDatabase(userDid: string): Promise<Database>;
}

export class SessionManagerService {
  /**
   * In-flight title generations keyed by `did:sessionId`. `syncSessionSet`
   * runs fire-and-forget after every turn, so turn 2 can start while turn 1's
   * title is still being generated — both would otherwise see `Untitled`,
   * spend a model call, and edit the Matrix root event. One entry per session
   * collapses them into a single generation.
   */
  private readonly titleGenerations = new Map<string, Promise<string>>();

  constructor(
    private readonly syncService: IDatabaseSyncService,
    public readonly matrixManger = MatrixManager.getInstance(),
  ) {}

  public getSessionsStateKey({
    oracleEntityDid,
  }: {
    oracleEntityDid: string;
  }): `${string}_${string}` {
    return `${oracleEntityDid}_sessions`;
  }

  /**
   * Generate and persist a title for a session that still holds the
   * placeholder — exactly once per session.
   *
   * Two guards stack. In-process, `titleGenerations` collapses concurrent
   * turns onto one model call. Across processes, the write is conditional on
   * the row still being untitled, and the Matrix root event is only edited
   * when that write is the one that landed. A caller that loses the race
   * re-reads the winner's title instead of overwriting it.
   */
  private async ensureTitle({
    db,
    sessionId,
    did,
    roomId,
    messages,
  }: {
    db: Database;
    sessionId: string;
    did: string;
    roomId?: string;
    messages: SessionTitleInput[];
  }): Promise<string> {
    const key = `${did}:${sessionId}`;
    const pending = this.titleGenerations.get(key);
    if (pending) return pending;

    const generation = (async (): Promise<string> => {
      const title = await generateSessionTitle(messages);
      if (!title) return UNTITLED_SESSION;

      const result = db
        .prepare(
          `UPDATE sessions
             SET title = ?
             WHERE session_id = ?
               AND (title IS NULL OR trim(title) = '' OR lower(title) = 'untitled')`,
        )
        .run(title, sessionId);

      if (result.changes === 0) {
        const winner = await this.getSession(sessionId, did, false);
        return winner?.title ?? title;
      }

      if (roomId) {
        // The session id is the root Matrix event; editing it renames the
        // conversation for Matrix clients. Fire-and-forget — a failed rename
        // must not fail the turn's session sync.
        this.matrixManger
          .editMessage({
            messageId: sessionId,
            roomId,
            message: title,
            isOracleAdmin: true,
          })
          .catch((err) => {
            Logger.error('Failed to update conversation title in Matrix:', err);
          });
      }

      return title;
    })().finally(() => {
      this.titleGenerations.delete(key);
    });

    this.titleGenerations.set(key, generation);
    return generation;
  }

  public async updateLastProcessedCount({
    sessionId,
    did,
    lastProcessedCount,
  }: {
    sessionId: string;
    did: string;
    lastProcessedCount: number;
  }): Promise<void> {
    const db = await this.syncService.getUserDatabase(did);
    db.prepare(
      'UPDATE sessions SET last_processed_count = ? WHERE session_id = ?',
    ).run(lastProcessedCount, sessionId);
    return;
  }

  public async syncSessionSet({
    sessionId,
    did,
    messages,
    oracleEntityDid,
    oracleName,
    roomId,
    lastProcessedCount,
    oracleDid,
    userContext,
    slackThreadTs,
  }: {
    sessionId: string;
    did: string;
    messages: SessionTitleInput[];
    oracleEntityDid: string;
    oracleName: string;
    roomId?: string;
    lastProcessedCount?: number;
    oracleDid: string;
    userContext?: UserContextData;
    slackThreadTs?: string;
  }): Promise<ChatSession> {
    const db = await this.syncService.getUserDatabase(did);

    const selectedSession = await this.getSession(sessionId, did, false);

    if (!selectedSession) {
      const session: ChatSession = {
        sessionId,
        oracleName,
        title: (await generateSessionTitle(messages)) ?? UNTITLED_SESSION,
        lastUpdatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        oracleEntityDid,
        oracleDid,
        userContext,
        roomId,
        slackThreadTs,
      };

      // Always use SQLite
      db.prepare(
        `
        INSERT INTO sessions (
          session_id, title, last_updated_at, created_at, oracle_name,
          oracle_did, oracle_entity_did, last_processed_count,
          user_context, room_id, slack_thread_ts
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        session.sessionId,
        session.title ?? null,
        session.lastUpdatedAt,
        session.createdAt,
        session.oracleName,
        session.oracleDid,
        session.oracleEntityDid,
        session.lastProcessedCount ?? null,
        session.userContext ? JSON.stringify(session.userContext) : null,
        session.roomId ?? null,
        session.slackThreadTs ?? null,
      );

      return session;
    }

    // A session is named once, on the first turn that carries a real
    // exchange. `ensureTitle` owns the title column from here on, so this
    // update leaves it alone.
    const title = needsTitle(selectedSession.title)
      ? await this.ensureTitle({
          db,
          sessionId,
          did,
          roomId: roomId ?? selectedSession.roomId,
          messages,
        })
      : selectedSession.title;

    const lastUpdatedAt = new Date().toISOString();
    const updatedSession: ChatSession = {
      ...selectedSession,
      title,
      lastUpdatedAt,
      lastProcessedCount,
      // Callers that don't own the Slack binding (the post-turn syncer) omit
      // it; keep what the session already has instead of clearing it.
      slackThreadTs: slackThreadTs ?? selectedSession.slackThreadTs,
    };

    db.prepare(
      `
      UPDATE sessions
      SET last_updated_at = ?, last_processed_count = ?, slack_thread_ts = ?
      WHERE session_id = ?
    `,
    ).run(
      lastUpdatedAt,
      updatedSession.lastProcessedCount ?? null,
      updatedSession.slackThreadTs ?? null,
      sessionId,
    );

    return updatedSession;
  }

  public async getSession(
    sessionId: string,
    did: string,
    throwOnNotFound: boolean = true,
  ): Promise<ChatSession | undefined> {
    const db = await this.syncService.getUserDatabase(did);
    const row = db
      .prepare(
        `SELECT
          session_id, title, last_updated_at, created_at, oracle_name,
          oracle_did, oracle_entity_did, last_processed_count,
          user_context, room_id, slack_thread_ts
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          session_id: string;
          title: string | null;
          last_updated_at: string;
          created_at: string;
          oracle_name: string;
          oracle_did: string;
          oracle_entity_did: string;
          last_processed_count: number | null;
          user_context: string | null;
          room_id: string | null;
          slack_thread_ts: string | null;
        }
      | undefined;

    const selectedSession = row
      ? {
          sessionId: row.session_id,
          title: row.title ?? undefined,
          lastUpdatedAt: row.last_updated_at,
          createdAt: row.created_at,
          oracleName: row.oracle_name,
          oracleDid: row.oracle_did,
          oracleEntityDid: row.oracle_entity_did,
          lastProcessedCount: row.last_processed_count ?? undefined,
          userContext: row.user_context
            ? (JSON.parse(row.user_context) as UserContextData)
            : undefined,
          roomId: row.room_id ?? undefined,
          slackThreadTs: row.slack_thread_ts ?? undefined,
        }
      : undefined;

    if (!selectedSession) {
      if (throwOnNotFound) {
        throw new Error('Session not found');
      }
      return undefined;
    }

    return selectedSession;
  }

  public async listSessions(
    listSessionsDto: ListChatSessionsDto,
  ): Promise<ListChatSessionsResponseDto> {
    const db = await this.syncService.getUserDatabase(listSessionsDto.did);

    // Set default pagination values
    const limit = listSessionsDto.limit ?? 20;
    const offset = listSessionsDto.offset ?? 0;

    // Get paginated sessions with total count, optionally filtered by roomId
    const hasRoomFilter = !!listSessionsDto.roomId;
    const sql = hasRoomFilter
      ? `SELECT
          session_id, title, last_updated_at, created_at, oracle_name,
          oracle_did, oracle_entity_did, last_processed_count,
          user_context, room_id, slack_thread_ts,
          COUNT(*) OVER() as total
         FROM sessions
         WHERE room_id = ?
         ORDER BY last_updated_at DESC
         LIMIT ? OFFSET ?`
      : `SELECT
          session_id, title, last_updated_at, created_at, oracle_name,
          oracle_did, oracle_entity_did, last_processed_count,
          user_context, room_id, slack_thread_ts,
          COUNT(*) OVER() as total
         FROM sessions
         ORDER BY last_updated_at DESC
         LIMIT ? OFFSET ?`;

    const params = hasRoomFilter
      ? [listSessionsDto.roomId, limit, offset]
      : [limit, offset];

    const rows = db.prepare(sql).all(...params) as Array<{
      session_id: string;
      title: string | null;
      last_updated_at: string;
      created_at: string;
      oracle_name: string;
      oracle_did: string;
      oracle_entity_did: string;
      last_processed_count: number | null;
      user_context: string | null;
      room_id: string | null;
      slack_thread_ts: string | null;
      total: number;
    }>;
    const total = rows[0]?.total ?? 0;

    const sessions: ChatSession[] = rows.map((row) => ({
      sessionId: row.session_id,
      title: row.title ?? undefined,
      lastUpdatedAt: row.last_updated_at,
      createdAt: row.created_at,
      oracleName: row.oracle_name,
      oracleDid: row.oracle_did,
      oracleEntityDid: row.oracle_entity_did,
      lastProcessedCount: row.last_processed_count ?? undefined,
      userContext: row.user_context
        ? (JSON.parse(row.user_context) as UserContextData)
        : undefined,
      roomId: row.room_id ?? undefined,
      slackThreadTs: row.slack_thread_ts ?? undefined,
    }));

    return { sessions, total };
  }

  public async createSession(
    createSessionDto: CreateChatSessionDto,
    overrideEventId?: string,
  ): Promise<CreateChatSessionResponseDto> {
    const userHomeServer =
      createSessionDto.homeServer ||
      (await getMatrixHomeServerCroppedForDid(createSessionDto.did));

    // Use the provided roomId override (e.g. task-specific room),
    // or fall back to resolving the user's main oracle room.
    let roomId = createSessionDto.roomId;
    if (!roomId) {
      const resolved = await this.matrixManger.getOracleRoomIdWithHomeServer({
        userDid: createSessionDto.did,
        oracleEntityDid: createSessionDto.oracleEntityDid,
        userHomeServer,
      });
      roomId = resolved.roomId;
    }

    if (!roomId) {
      throw new Error('Room ID not found');
    }
    const eventId =
      overrideEventId ??
      (await this.matrixManger.sendMessage({
        message: 'New Conversation Started',
        roomId,
        isOracleAdmin: true,
      }));

    // `userContext` is no longer fetched at session creation. It is
    // populated per-message by the runtime's `UserContextFetcher` (cached
    // for 3 minutes), which keeps the session-create path off the Memory
    // Engine critical path AND keeps the prompt fresher than a snapshot
    // taken once at session start.
    const session = await this.syncSessionSet({
      sessionId: eventId,
      oracleName: createSessionDto.oracleName,
      did: createSessionDto.did,
      oracleEntityDid: createSessionDto.oracleEntityDid,
      oracleDid: createSessionDto.oracleDid,
      messages: [],
      roomId,
      slackThreadTs: createSessionDto.slackThreadTs,
    });

    return session;
  }

  public async deleteSession(
    deleteSessionDto: DeleteChatSessionDto,
  ): Promise<void> {
    const db = await this.syncService.getUserDatabase(deleteSessionDto.did);
    const { sessionId } = deleteSessionDto;

    // The session id doubles as the LangGraph thread id, so clear the
    // thread's checkpointer rows too (mirrors `SqliteSaver.deleteThread`).
    // The checkpointer creates its tables on the first graph turn — a user
    // who created a session but never sent a message has none yet, so only
    // the checkpointer tables need an existence check.
    const checkpointerTables = db
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('checkpoints', 'writes', 'messages')`)
      .all();

    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
      for (const { name } of checkpointerTables) {
        db.prepare(`DELETE FROM ${name} WHERE thread_id = ?`).run(sessionId);
      }
    })();
  }
}
