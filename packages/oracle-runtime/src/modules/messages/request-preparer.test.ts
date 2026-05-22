import {
  type ChatSession,
  type SessionManagerService,
} from '@ixo/common';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { makeConfig } from '../../testing/nest-doubles.js';
import {
  makeCheckpointSync,
  makeSessionManagerStub,
} from './__test-fixtures__/deps.js';
import type { SendMessagePayload } from './dto/send-message.dto.js';
import { type HomeServerCache } from './homeserver-cache.js';
import { RequestPreparer, type PrepareInput } from './request-preparer.js';

const USER_DID = 'did:ixo:user-1';
const SESSION_ID = 'sess-1';
const HOME_SERVER = 'home.server';
const ROOM_ID = '!room:home';
const ORACLE_ENTITY_DID = 'did:ixo:oracle-entity';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: SESSION_ID,
    lastUpdatedAt: '2026-05-21T00:00:00.000Z',
    createdAt: '2026-05-20T00:00:00.000Z',
    oracleName: 'TestOracle',
    oracleDid: 'did:ixo:oracle',
    oracleEntityDid: ORACLE_ENTITY_DID,
    lastProcessedCount: 0,
    roomId: ROOM_ID,
    ...overrides,
  };
}

function makePayload(overrides: Partial<PrepareInput> = {}): PrepareInput {
  const base: SendMessagePayload = {
    did: USER_DID,
    sessionId: SESSION_ID,
    message: 'hello',
  };
  return { ...base, ...overrides } as PrepareInput;
}

function makeReq(headers: Record<string, string | string[]> = {}): Request {
  return { headers } as unknown as Request;
}

describe('RequestPreparer', () => {
  let sessionManager: ReturnType<typeof makeSessionManagerStub>;
  let checkpointSync: ReturnType<typeof makeCheckpointSync>;
  let homeServerCache: { get: ReturnType<typeof vi.fn> };
  let preparer: RequestPreparer;

  beforeEach(() => {
    vi.resetAllMocks();
    sessionManager = makeSessionManagerStub();
    checkpointSync = makeCheckpointSync();
    homeServerCache = { get: vi.fn().mockResolvedValue(HOME_SERVER) };
    sessionManager.getSession.mockResolvedValue(makeSession());
    sessionManager.matrixManger.getOracleRoomIdWithHomeServer.mockResolvedValue(
      { roomId: ROOM_ID, roomAlias: '#a:home', oracleRoomFullAlias: '#f:home' },
    );
    checkpointSync.getUserDatabase.mockResolvedValue(undefined);

    preparer = new RequestPreparer(
      sessionManager as unknown as SessionManagerService,
      checkpointSync as unknown as UserMatrixSqliteSyncService,
      homeServerCache as unknown as HomeServerCache,
      makeConfig({ ORACLE_ENTITY_DID }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateSessionId', () => {
    it('throws BadRequestException when sessionId missing', () => {
      expect(() => preparer.validateSessionId(undefined, USER_DID)).toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when did missing', () => {
      expect(() => preparer.validateSessionId(SESSION_ID, undefined)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('prepare', () => {
    it('resolves homeServer from cache when payload.homeServer absent', async () => {
      const prepared = await preparer.prepare(makePayload());

      expect(homeServerCache.get).toHaveBeenCalledWith(USER_DID);
      expect(prepared.homeServerName).toBe(HOME_SERVER);
    });

    it('skips cache when payload.homeServer provided', async () => {
      const prepared = await preparer.prepare(
        makePayload({ homeServer: 'override.server' }),
      );

      expect(homeServerCache.get).not.toHaveBeenCalled();
      expect(prepared.homeServerName).toBe('override.server');
    });

    it('throws NotFoundException when sessionManager.getSession returns null', async () => {
      sessionManager.getSession.mockResolvedValueOnce(null);

      await expect(preparer.prepare(makePayload())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('resolves roomId from targetSession.roomId without consulting matrix', async () => {
      sessionManager.getSession.mockResolvedValueOnce(
        makeSession({ roomId: '!session-room:home' }),
      );

      const prepared = await preparer.prepare(makePayload());

      expect(prepared.roomId).toBe('!session-room:home');
      expect(
        sessionManager.matrixManger.getOracleRoomIdWithHomeServer,
      ).not.toHaveBeenCalled();
    });

    it('falls through to matrixManger.getOracleRoomIdWithHomeServer when session has no roomId', async () => {
      sessionManager.getSession.mockResolvedValueOnce(
        makeSession({ roomId: undefined }),
      );
      sessionManager.matrixManger.getOracleRoomIdWithHomeServer.mockResolvedValueOnce(
        {
          roomId: '!matrix-room:home',
          roomAlias: '#a:home',
          oracleRoomFullAlias: '#f:home',
        },
      );

      const prepared = await preparer.prepare(makePayload());

      expect(
        sessionManager.matrixManger.getOracleRoomIdWithHomeServer,
      ).toHaveBeenCalledWith({
        userDid: USER_DID,
        oracleEntityDid: ORACLE_ENTITY_DID,
        userHomeServer: HOME_SERVER,
      });
      expect(prepared.roomId).toBe('!matrix-room:home');
    });

    it('throws NotFoundException when matrix fallback returns no roomId', async () => {
      sessionManager.getSession.mockResolvedValueOnce(
        makeSession({ roomId: undefined }),
      );
      sessionManager.matrixManger.getOracleRoomIdWithHomeServer.mockResolvedValueOnce(
        { roomId: '', roomAlias: '', oracleRoomFullAlias: '' },
      );

      await expect(preparer.prepare(makePayload())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reuses sessionId as langchain thread_id by default', async () => {
      const prepared = await preparer.prepare(makePayload());

      expect(prepared.langchainThreadId).toBe(SESSION_ID);
      expect(prepared.runnableConfig.configurable.thread_id).toBe(SESSION_ID);
      expect(prepared.runnableConfig.configurable.sessionId).toBe(SESSION_ID);
    });

    it('honors overrideLangchainThreadId for runnableConfig.thread_id', async () => {
      const prepared = await preparer.prepare(
        makePayload({ overrideLangchainThreadId: 'thread-override' }),
      );

      expect(prepared.langchainThreadId).toBe('thread-override');
      expect(prepared.runnableConfig.configurable.thread_id).toBe(
        'thread-override',
      );
      expect(prepared.runnableConfig.configurable.sessionId).toBe(
        'thread-override',
      );
      expect(prepared.sessionId).toBe(SESSION_ID);
    });

    it('resolves timezone from payload.timezone first, then x-timezone header', async () => {
      const payloadWins = await preparer.prepare(
        makePayload({
          timezone: 'America/New_York',
          req: makeReq({ 'x-timezone': 'Europe/Paris' }),
        }),
      );
      expect(payloadWins.timezone).toBe('America/New_York');

      const headerFallback = await preparer.prepare(
        makePayload({ req: makeReq({ 'x-timezone': 'Europe/Paris' }) }),
      );
      expect(headerFallback.timezone).toBe('Europe/Paris');
    });

    it('formatTimeInTimezone falls back to UTC when zone invalid', async () => {
      const prepared = await preparer.prepare(
        makePayload({ timezone: 'Not/AReal_Zone' }),
      );

      expect(prepared.timezone).toBe('Not/AReal_Zone');
      expect(prepared.currentTime).toMatch(/UTC|GMT/);
    });

    it('generates a fresh requestId when stream=false', async () => {
      const a = await preparer.prepare(makePayload({ stream: false }));
      const b = await preparer.prepare(makePayload({ stream: false }));

      expect(a.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(b.requestId).not.toBe(a.requestId);
      expect(a.runnableConfig.configurable.requestId).toBe(a.requestId);
    });
  });
});
