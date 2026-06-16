import { Logger } from '@ixo/logger';
import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { type Database } from 'better-sqlite3';
import {
  getChatOpenAiModel,
  getLLMProvider,
  getOpenRouterChatModel,
  getProviderConfig,
} from '../../ai/index.js';
import { type UserContextData } from '../memory-engine/types.js';
import {
  type ChatSession,
  type CreateChatSessionDto,
  type CreateChatSessionResponseDto,
  type DeleteChatSessionDto,
  type ListChatSessionsDto,
  type ListChatSessionsResponseDto,
} from './dto.js';

export interface IDatabaseSyncService {
  getUserDatabase(userDid: string): Promise<Database>;
}

export class SessionManagerService {
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

  private async createMessageTitle({
    messages,
  }: {
    messages: string[];
  }): Promise<string> {
    if (messages.length === 0) {
      return 'Untitled';
    }
    const provider = getLLMProvider();
    const config = getProviderConfig();

    const llm =
      provider === 'openrouter'
        ? getOpenRouterChatModel({
            model: 'meta-llama/llama-3.1-8b-instruct',
            temperature: 0.3,
            timeout: 60_000,
          })
        : getChatOpenAiModel({
            model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
            temperature: 0.3,
            apiKey: config.apiKey,
            timeout: 60_000,
            configuration: {
              baseURL: config.baseURL,
            },
          });
    const response = await llm.invoke(
      `Based on this messages messages, Add a title for this convo and only based on the messages? MAKE SURE TO ONLY RESPOND WITH THE TITLE.

      ## RESPONSE FORMAT
      ONLY RESPOND WITH THE TITLE not anything else that title will be saved to the store directly from your response so generated based on the messages.

      EXample

      Input:
      <messages>
      Hello, how are you?
      I'm good, thank you!
      did u see the new feature i added?
      yes but i didn't like it
      </messages>

      Output:
      Conversation about a new feature

      ___________________________________________________________

      Input:
      <messages>
      What are the store opening hours?
      We are open from 9am to 5pm, Monday to Friday.
      </messages>

      Output:
      Store Opening Hours Information
___________________________________________________________
      Input:
      <messages>
      Can you help me reset my password?
      Sure, I can assist you with that.
      </messages>

      Output:
      Password Reset Assistance

      ___________________________________________________________
      # the out put should be only the title not anything else that title will be saved to the store directly from your response so generated based on the messages.

      USER MESSAGES:
      <messages>
      ${messages.join('\n\n')}
      </messages>
      `,
    );

    const title = String(response.content);
    return title;
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
    messages: string[];
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
        title: await this.createMessageTitle({
          messages,
        }),
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

    // 1. We have at least 2 messages (enough to generate a meaningful title)
    // 2. AND the current title is "Untitled" or undefined (hasn't been set yet)
    const hasEnoughMessages = messages.length >= 2;
    const needsTitleUpdate =
      !selectedSession.title ||
      selectedSession.title.toLowerCase() === 'untitled' ||
      (selectedSession.title && selectedSession.title.trim() === '');

    const allowTitleUpdate = hasEnoughMessages && needsTitleUpdate; // update the session
    const title = allowTitleUpdate
      ? await this.createMessageTitle({
          messages,
        })
      : selectedSession.title;

    if (allowTitleUpdate && roomId && title) {
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

    const lastUpdatedAt = new Date().toISOString();
    const updatedSession: ChatSession = {
      ...selectedSession,
      title,
      lastUpdatedAt,
      lastProcessedCount,
      slackThreadTs,
    };

    db.prepare(
      `
      UPDATE sessions
      SET title = ?, last_updated_at = ?, last_processed_count = ?, slack_thread_ts = ?
      WHERE session_id = ?
    `,
    ).run(
      updatedSession.title ?? null,
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
