import {
  type CreateChatSessionResponseDto,
  type ChatSession,
  type SessionManagerService,
} from '@ixo/common';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { makeConfig } from '../../testing/nest-doubles.js';
import { type SessionHistoryProcessor } from './session-history-processor.service.js';
import { SessionsService } from './sessions.service.js';

vi.mock('@ixo/oracles-chain-client', () => ({
  getMatrixHomeServerCroppedForDid: vi.fn(),
}));

const mockedGetHomeServer = vi.mocked(getMatrixHomeServerCroppedForDid);

const USER_DID = 'did:ixo:user-1';
const ORACLE_ENTITY_DID = 'did:ixo:oracle-entity';
const ORACLE_NAME = 'TestOracle';
const ORACLE_DID = 'did:ixo:oracle';
const HOME_SERVER = 'home.server';
const MAIN_ROOM_ID = '!main:home.server';

function makeSessionManager() {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    matrixManger: {
      getOracleRoomIdWithHomeServer: vi.fn(),
    },
  };
}

function makeSyncService() {
  return {
    markUserActive: vi.fn(),
    markUserInactive: vi.fn(),
  };
}

function makeHistoryProcessor() {
  return {
    processSessionHistory: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: 'sess-1',
    title: 'Session 1',
    lastUpdatedAt: '2026-05-21T00:00:00.000Z',
    createdAt: '2026-05-20T00:00:00.000Z',
    oracleName: ORACLE_NAME,
    oracleDid: ORACLE_DID,
    oracleEntityDid: ORACLE_ENTITY_DID,
    lastProcessedCount: 0,
    roomId: MAIN_ROOM_ID,
    ...overrides,
  };
}

function makeCreateResponse(
  overrides: Partial<CreateChatSessionResponseDto> = {},
): CreateChatSessionResponseDto {
  return makeSession(overrides);
}

describe('SessionsService', () => {
  let sessionManager: ReturnType<typeof makeSessionManager>;
  let syncService: ReturnType<typeof makeSyncService>;
  let historyProcessor: ReturnType<typeof makeHistoryProcessor>;
  let config: ConfigService;
  let svc: SessionsService;

  beforeEach(() => {
    vi.resetAllMocks();
    sessionManager = makeSessionManager();
    syncService = makeSyncService();
    historyProcessor = makeHistoryProcessor();
    config = makeConfig({
      ORACLE_ENTITY_DID,
      ORACLE_NAME,
      ORACLE_DID,
    });
    sessionManager.matrixManger.getOracleRoomIdWithHomeServer.mockResolvedValue(
      {
        roomId: MAIN_ROOM_ID,
        roomAlias: '#alias:home.server',
        oracleRoomFullAlias: '#full:home.server',
      },
    );
    sessionManager.listSessions.mockResolvedValue({ sessions: [], total: 0 });
    sessionManager.createSession.mockResolvedValue(makeCreateResponse());
    sessionManager.deleteSession.mockResolvedValue(undefined);
    mockedGetHomeServer.mockResolvedValue(HOME_SERVER);
    svc = new SessionsService(
      sessionManager as unknown as SessionManagerService,
      config,
      historyProcessor as unknown as SessionHistoryProcessor,
      syncService as unknown as UserMatrixSqliteSyncService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createSession', () => {
    it('calls markUserActive for entry + before-background-task (outer createSession pair)', async () => {
      // Counts: outer createSession entry (1) + before-bg-task (2)
      // + internal `this.listSessions` entry from processPreviousSessionHistory (3).
      // The first two are the createSession ref-count pair; the third is the
      // inner listSessions pair that runs synchronously before any await.
      await svc.createSession({ did: USER_DID, homeServer: HOME_SERVER });
      expect(syncService.markUserActive).toHaveBeenCalledTimes(3);
      expect(syncService.markUserActive).toHaveBeenNthCalledWith(1, USER_DID);
      expect(syncService.markUserActive).toHaveBeenNthCalledWith(2, USER_DID);
      expect(syncService.markUserActive).toHaveBeenNthCalledWith(3, USER_DID);
    });

    it('calls markUserInactive in finally chains so active/inactive counts balance', async () => {
      await svc.createSession({ did: USER_DID, homeServer: HOME_SERVER });
      // Ref-count must balance: 3 active -> 3 inactive (1 from inner
      // listSessions finally, 1 from outer createSession finally, 1 from
      // background processPreviousSessionHistory .finally()).
      await vi.waitFor(() =>
        expect(syncService.markUserInactive).toHaveBeenCalledTimes(3),
      );
      expect(syncService.markUserInactive).toHaveBeenNthCalledWith(1, USER_DID);
      expect(syncService.markUserInactive).toHaveBeenNthCalledWith(2, USER_DID);
      expect(syncService.markUserInactive).toHaveBeenNthCalledWith(3, USER_DID);
    });

    it('invokes processPreviousSessionHistory in the background without awaiting', async () => {
      // Background task hangs forever — createSession must still resolve.
      let releaseHistory: () => void = () => undefined;
      historyProcessor.processSessionHistory.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseHistory = resolve;
        }),
      );
      sessionManager.listSessions.mockResolvedValueOnce({
        sessions: [makeSession({ sessionId: 'prev-sess' })],
        total: 1,
      });

      await svc.createSession({ did: USER_DID, homeServer: HOME_SERVER });

      await vi.waitFor(() =>
        expect(historyProcessor.processSessionHistory).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 'prev-sess',
            did: USER_DID,
            oracleEntityDid: ORACLE_ENTITY_DID,
            homeServer: HOME_SERVER,
          }),
        ),
      );
      releaseHistory();
    });

    it('returns CreateChatSessionResponseDto from sessionManager', async () => {
      const expected = makeCreateResponse({ sessionId: 'new-sess' });
      sessionManager.createSession.mockResolvedValueOnce(expected);

      const result = await svc.createSession({
        did: USER_DID,
        homeServer: HOME_SERVER,
        slackThreadTs: 'thread-123',
      });

      expect(result).toBe(expected);
      expect(sessionManager.createSession).toHaveBeenCalledWith({
        did: USER_DID,
        homeServer: HOME_SERVER,
        oracleName: ORACLE_NAME,
        oracleEntityDid: ORACLE_ENTITY_DID,
        oracleDid: ORACLE_DID,
        slackThreadTs: 'thread-123',
      });
    });

    it('wraps thrown errors in BadRequestException preserving original message', async () => {
      sessionManager.createSession.mockRejectedValue(new Error('matrix down'));

      const rejection = svc.createSession({
        did: USER_DID,
        homeServer: HOME_SERVER,
      });
      await expect(rejection).rejects.toBeInstanceOf(BadRequestException);
      await expect(rejection).rejects.toThrow(/matrix down/);
    });
  });

  describe('listSessions', () => {
    it('resolves homeServer via getMatrixHomeServerCroppedForDid when payload omits it', async () => {
      await svc.listSessions({ did: USER_DID });

      expect(mockedGetHomeServer).toHaveBeenCalledWith(USER_DID);
      expect(
        sessionManager.matrixManger.getOracleRoomIdWithHomeServer,
      ).toHaveBeenCalledWith({
        userDid: USER_DID,
        oracleEntityDid: ORACLE_ENTITY_DID,
        userHomeServer: HOME_SERVER,
      });
    });

    it('uses data.homeServer when provided (no chain lookup)', async () => {
      await svc.listSessions({ did: USER_DID, homeServer: 'custom.server' });

      expect(mockedGetHomeServer).not.toHaveBeenCalled();
      expect(
        sessionManager.matrixManger.getOracleRoomIdWithHomeServer,
      ).toHaveBeenCalledWith({
        userDid: USER_DID,
        oracleEntityDid: ORACLE_ENTITY_DID,
        userHomeServer: 'custom.server',
      });
    });

    it('filters by mainRoomId resolved from matrixManger.getOracleRoomIdWithHomeServer', async () => {
      sessionManager.matrixManger.getOracleRoomIdWithHomeServer.mockResolvedValueOnce(
        {
          roomId: '!resolved:home',
          roomAlias: '#a:home',
          oracleRoomFullAlias: '#full:home',
        },
      );

      await svc.listSessions({
        did: USER_DID,
        homeServer: HOME_SERVER,
        limit: 5,
        offset: 10,
      });

      expect(sessionManager.listSessions).toHaveBeenCalledWith({
        did: USER_DID,
        oracleEntityDid: ORACLE_ENTITY_DID,
        limit: 5,
        offset: 10,
        roomId: '!resolved:home',
      });
    });

    it('throws BadRequestException when homeserver resolution fails', async () => {
      mockedGetHomeServer.mockRejectedValue(new Error('chain rpc down'));

      const rejection = svc.listSessions({ did: USER_DID });
      await expect(rejection).rejects.toBeInstanceOf(BadRequestException);
      await expect(rejection).rejects.toThrow(/chain rpc down/);
    });

    it('calls markUserInactive in finally on both success and error', async () => {
      await svc.listSessions({ did: USER_DID, homeServer: HOME_SERVER });
      expect(syncService.markUserActive).toHaveBeenCalledTimes(1);
      expect(syncService.markUserActive).toHaveBeenCalledWith(USER_DID);
      expect(syncService.markUserInactive).toHaveBeenCalledTimes(1);
      expect(syncService.markUserInactive).toHaveBeenCalledWith(USER_DID);

      syncService.markUserActive.mockClear();
      syncService.markUserInactive.mockClear();
      sessionManager.listSessions.mockRejectedValue(new Error('db error'));

      await expect(
        svc.listSessions({ did: USER_DID, homeServer: HOME_SERVER }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(syncService.markUserActive).toHaveBeenCalledTimes(1);
      expect(syncService.markUserInactive).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteSession', () => {
    it('calls markUserActive twice (entry + before background)', async () => {
      await svc.deleteSession({
        did: USER_DID,
        sessionId: 'sess-del',
        homeServer: HOME_SERVER,
      });
      expect(syncService.markUserActive).toHaveBeenCalledTimes(2);
      expect(syncService.markUserActive).toHaveBeenNthCalledWith(1, USER_DID);
      expect(syncService.markUserActive).toHaveBeenNthCalledWith(2, USER_DID);
    });

    it('calls markUserInactive twice (matching) in finally chains', async () => {
      await svc.deleteSession({
        did: USER_DID,
        sessionId: 'sess-del',
        homeServer: HOME_SERVER,
      });
      await vi.waitFor(() =>
        expect(syncService.markUserInactive).toHaveBeenCalledTimes(2),
      );
    });

    it('fires processSessionHistory for the deleted sessionId in the background', async () => {
      let releaseHistory: () => void = () => undefined;
      historyProcessor.processSessionHistory.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseHistory = resolve;
        }),
      );

      await svc.deleteSession({
        did: USER_DID,
        sessionId: 'sess-del',
        homeServer: HOME_SERVER,
      });

      await vi.waitFor(() =>
        expect(historyProcessor.processSessionHistory).toHaveBeenCalledWith({
          sessionId: 'sess-del',
          did: USER_DID,
          oracleEntityDid: ORACLE_ENTITY_DID,
          homeServer: HOME_SERVER,
        }),
      );
      releaseHistory();
    });

    it('awaits sessionManager.deleteSession with the correct payload', async () => {
      await svc.deleteSession({
        did: USER_DID,
        sessionId: 'sess-del',
        homeServer: HOME_SERVER,
      });
      expect(sessionManager.deleteSession).toHaveBeenCalledWith({
        did: USER_DID,
        sessionId: 'sess-del',
        oracleEntityDid: ORACLE_ENTITY_DID,
      });
    });

    it('returns success message', async () => {
      const result = await svc.deleteSession({
        did: USER_DID,
        sessionId: 'sess-del',
        homeServer: HOME_SERVER,
      });
      expect(result).toEqual({ message: 'Session deleted successfully' });
    });
  });

  describe('processPreviousSessionHistory (via createSession)', () => {
    it('picks sessions[0] (most recent) for background processing', async () => {
      sessionManager.listSessions.mockResolvedValueOnce({
        sessions: [
          makeSession({ sessionId: 'most-recent' }),
          makeSession({ sessionId: 'older' }),
        ],
        total: 2,
      });

      await svc.createSession({ did: USER_DID, homeServer: HOME_SERVER });

      await vi.waitFor(() =>
        expect(historyProcessor.processSessionHistory).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'most-recent' }),
        ),
      );
      expect(historyProcessor.processSessionHistory).toHaveBeenCalledTimes(1);
    });

    it('does not schedule processSessionHistory when sessions list is empty', async () => {
      sessionManager.listSessions.mockResolvedValue({
        sessions: [],
        total: 0,
      });

      await svc.createSession({ did: USER_DID, homeServer: HOME_SERVER });
      // Drain microtasks so any erroneously-fired background task would land.
      await Promise.resolve();
      await Promise.resolve();

      expect(historyProcessor.processSessionHistory).not.toHaveBeenCalled();
    });

    it('pairs markUserActive/markUserInactive around the inner fire-and-forget when a prior session exists', async () => {
      sessionManager.listSessions.mockResolvedValue({
        sessions: [makeSession({ sessionId: 'prev-sess' })],
        total: 1,
      });
      // With a prior session, processPreviousSessionHistory fires an inner
      // markUserActive + .finally(markUserInactive) pair for the
      // sessionHistoryProcessor call. Combined with the outer createSession
      // pair, the inner listSessions pair, and the bg createSession pair,
      // the totals must be 4 active and 4 inactive (balanced).

      await svc.createSession({ did: USER_DID, homeServer: HOME_SERVER });

      await vi.waitFor(() =>
        expect(syncService.markUserInactive).toHaveBeenCalledTimes(4),
      );
      expect(syncService.markUserActive).toHaveBeenCalledTimes(4);
    });
  });
});
