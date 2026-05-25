import {
  type ChatSession,
  type MemoryEngineService,
  type SessionManagerService,
} from '@ixo/common';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import type { Cache } from 'cache-manager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserPreferencesService } from '../../plugins/user-preferences/service/user-preferences.service.js';
import { makeConfig } from '../../testing/nest-doubles.js';
import { makeSessionManagerStub } from '../messages/__test-fixtures__/deps.js';
import type { MessagesService } from '../messages/messages.service.js';
import type { UcanService } from '../ucan/ucan.service.js';
import { SessionHistoryProcessor } from './session-history-processor.service.js';

const matrixGetDisplayName = vi.fn();

vi.mock('@ixo/matrix', () => ({
  MatrixManager: {
    getInstance: () => ({
      getDisplayName: (...args: unknown[]) => matrixGetDisplayName(...args),
    }),
  },
}));

vi.mock('@ixo/oracles-chain-client', () => ({
  getMatrixHomeServerCroppedForDid: vi.fn(),
}));

const mockedGetHomeServer = vi.mocked(getMatrixHomeServerCroppedForDid);

const USER_DID = 'did:ixo:user-1';
const ORACLE_ENTITY_DID = 'did:ixo:oracle-entity';
const ORACLE_NAME = 'TestOracle';
const ROOM_ID = '!room:home.server';
const HOME_SERVER = 'home.server';
const SESSION_ID = 'sess-1';
const MEMORY_ENGINE_URL = 'https://memory.test';
const MATRIX_BASE_URL = 'https://matrix.test/';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: SESSION_ID,
    title: 'Session 1',
    lastUpdatedAt: '2026-05-21T00:00:00.000Z',
    createdAt: '2026-05-20T00:00:00.000Z',
    oracleName: ORACLE_NAME,
    oracleDid: 'did:ixo:oracle',
    oracleEntityDid: ORACLE_ENTITY_DID,
    lastProcessedCount: 0,
    roomId: ROOM_ID,
    ...overrides,
  };
}

function makeMessage(
  type: 'human' | 'ai' | 'system' | 'tool',
  content: string,
) {
  return { type, content };
}

function makeCache(): Cache & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const cache = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  return cache as unknown as Cache & typeof cache;
}

describe('SessionHistoryProcessor', () => {
  let messagesService: { listMessages: ReturnType<typeof vi.fn> };
  let memoryEngine: { processConversationHistory: ReturnType<typeof vi.fn> };
  let sessionManager: ReturnType<typeof makeSessionManagerStub>;
  let cache: ReturnType<typeof makeCache>;
  let ucanService: {
    hasSigningKey: ReturnType<typeof vi.fn>;
    createServiceInvocation: ReturnType<typeof vi.fn>;
  };
  let svc: SessionHistoryProcessor;
  let prefsGetSpy: ReturnType<typeof vi.spyOn>;

  const baseParams = {
    sessionId: SESSION_ID,
    did: USER_DID,
    oracleEntityDid: ORACLE_ENTITY_DID,
    homeServer: HOME_SERVER,
  } as const;

  beforeEach(() => {
    vi.resetAllMocks();

    messagesService = { listMessages: vi.fn() };
    memoryEngine = {
      processConversationHistory: vi.fn().mockResolvedValue({ success: true }),
    };
    sessionManager = makeSessionManagerStub();
    cache = makeCache();
    ucanService = {
      hasSigningKey: vi.fn(() => true),
      createServiceInvocation: vi.fn().mockResolvedValue('ucan-invocation'),
    };

    sessionManager.getSession.mockResolvedValue(makeSession());
    sessionManager.matrixManger.getOracleRoomIdWithHomeServer.mockResolvedValue(
      { roomId: ROOM_ID, roomAlias: '#a:home', oracleRoomFullAlias: '#f:home' },
    );
    sessionManager.updateLastProcessedCount.mockResolvedValue(undefined);
    messagesService.listMessages.mockResolvedValue({
      messages: [makeMessage('human', 'hi'), makeMessage('ai', 'hello')],
    });
    mockedGetHomeServer.mockResolvedValue(HOME_SERVER);

    // Stub the singleton's read path so the SUT never touches Matrix.
    prefsGetSpy = vi
      .spyOn(UserPreferencesService.getInstance(), 'get')
      .mockResolvedValue(undefined);

    matrixGetDisplayName.mockResolvedValue('');

    svc = new SessionHistoryProcessor(
      messagesService as unknown as MessagesService,
      memoryEngine as unknown as MemoryEngineService,
      sessionManager as unknown as SessionManagerService,
      makeConfig({
        ORACLE_NAME,
        MATRIX_BASE_URL,
        MEMORY_ENGINE_URL,
      }),
      cache,
      ucanService as unknown as UcanService,
    );
  });

  afterEach(() => {
    prefsGetSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('processSessionHistory (locking)', () => {
    it('acquires the cache lock on entry and releases it in finally on success', async () => {
      await svc.processSessionHistory({ ...baseParams });

      const cacheKey = `processing:session:${SESSION_ID}`;
      expect(cache.get).toHaveBeenCalledWith(cacheKey);
      expect(cache.set).toHaveBeenCalledWith(cacheKey, true, 5 * 60 * 1000);
      expect(cache.del).toHaveBeenCalledWith(cacheKey);
      const setOrder = cache.set.mock.invocationCallOrder[0];
      const delOrder = cache.del.mock.invocationCallOrder[0];
      expect(delOrder).toBeGreaterThan(setOrder);
    });

    it('releases the lock in finally even when processing throws (retry not blocked)', async () => {
      // Force every retry attempt to fail so the wrapper rethrows.
      sessionManager.getSession.mockRejectedValue(new Error('boom'));
      vi.useFakeTimers();
      const promise = svc.processSessionHistory({ ...baseParams });
      // Capture as pending — don't await yet, the fake clock needs to
      // advance through the retry delays first. Lint rule can't see the
      // deferred `await settled` a few lines down.
      // eslint-disable-next-line vitest/valid-expect
      const settled = expect(promise).rejects.toThrow(/boom/);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
      vi.useRealTimers();

      expect(cache.del).toHaveBeenCalledWith(
        `processing:session:${SESSION_ID}`,
      );
    });

    it('early-returns when the lock is already held (no double processing)', async () => {
      cache.get.mockResolvedValueOnce(true);

      await svc.processSessionHistory({ ...baseParams });

      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
      expect(sessionManager.getSession).not.toHaveBeenCalled();
      expect(memoryEngine.processConversationHistory).not.toHaveBeenCalled();
    });
  });

  describe('processSessionHistoryWithRetry', () => {
    it('retries 3 times with retryDelay between attempts before throwing', async () => {
      sessionManager.getSession.mockRejectedValue(new Error('transient'));
      vi.useFakeTimers();
      const promise = svc.processSessionHistory({ ...baseParams });
      // Capture as pending — don't await yet, the fake clock needs to
      // advance through the retry delays first. Lint rule can't see the
      // deferred `await settled` a few lines down.
      // eslint-disable-next-line vitest/valid-expect
      const settled = expect(promise).rejects.toThrow(/transient/);

      // Attempt 1 fails -> wait 10s -> attempt 2 fails -> wait 10s -> attempt 3 fails -> throw.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      await settled;
      vi.useRealTimers();

      expect(sessionManager.getSession).toHaveBeenCalledTimes(3);
    });

    it('succeeds without rethrowing when a later attempt passes', async () => {
      sessionManager.getSession
        .mockRejectedValueOnce(new Error('flaky-1'))
        .mockRejectedValueOnce(new Error('flaky-2'))
        .mockResolvedValueOnce(makeSession());

      vi.useFakeTimers();
      const promise = svc.processSessionHistory({ ...baseParams });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await promise;
      vi.useRealTimers();

      expect(sessionManager.getSession).toHaveBeenCalledTimes(3);
      expect(memoryEngine.processConversationHistory).toHaveBeenCalledTimes(1);
    });
  });

  describe('processSessionHistoryInternal', () => {
    it('no-ops when sessionManager.getSession returns null', async () => {
      sessionManager.getSession.mockResolvedValue(null);

      await svc.processSessionHistory({ ...baseParams });

      expect(
        sessionManager.matrixManger.getOracleRoomIdWithHomeServer,
      ).not.toHaveBeenCalled();
      expect(messagesService.listMessages).not.toHaveBeenCalled();
      expect(memoryEngine.processConversationHistory).not.toHaveBeenCalled();
    });

    it('no-ops when matrix returns no roomId', async () => {
      sessionManager.matrixManger.getOracleRoomIdWithHomeServer.mockResolvedValue(
        {
          roomId: undefined,
          roomAlias: '#a:home',
          oracleRoomFullAlias: '#f:home',
        },
      );

      await svc.processSessionHistory({ ...baseParams });

      expect(messagesService.listMessages).not.toHaveBeenCalled();
      expect(memoryEngine.processConversationHistory).not.toHaveBeenCalled();
    });

    it('no-ops when messagesResponse.messages is empty', async () => {
      messagesService.listMessages.mockResolvedValue({ messages: [] });

      await svc.processSessionHistory({ ...baseParams });

      expect(memoryEngine.processConversationHistory).not.toHaveBeenCalled();
      expect(sessionManager.updateLastProcessedCount).not.toHaveBeenCalled();
    });

    it('slices newMessages by lastProcessedCount at boundaries 0, mid, and equal-to-length', async () => {
      const messages = [
        makeMessage('human', 'm0'),
        makeMessage('ai', 'm1'),
        makeMessage('human', 'm2'),
        makeMessage('ai', 'm3'),
      ];
      messagesService.listMessages.mockResolvedValue({ messages });

      // Boundary 0 — all messages new.
      sessionManager.getSession.mockResolvedValueOnce(
        makeSession({ lastProcessedCount: 0 }),
      );
      await svc.processSessionHistory({ ...baseParams });
      expect(
        memoryEngine.processConversationHistory.mock.calls[0][0].messages,
      ).toHaveLength(4);
      expect(sessionManager.updateLastProcessedCount).toHaveBeenLastCalledWith({
        sessionId: SESSION_ID,
        did: USER_DID,
        lastProcessedCount: 4,
      });

      // Mid — only the tail past index 2 is new.
      sessionManager.getSession.mockResolvedValueOnce(
        makeSession({ lastProcessedCount: 2 }),
      );
      await svc.processSessionHistory({ ...baseParams });
      expect(
        memoryEngine.processConversationHistory.mock.calls[1][0].messages,
      ).toHaveLength(2);
      expect(sessionManager.updateLastProcessedCount).toHaveBeenLastCalledWith({
        sessionId: SESSION_ID,
        did: USER_DID,
        lastProcessedCount: 4,
      });

      // Equal-to-length — nothing new; memory engine never called.
      sessionManager.getSession.mockResolvedValueOnce(
        makeSession({ lastProcessedCount: 4 }),
      );
      await svc.processSessionHistory({ ...baseParams });
      // Memory engine still only called twice (the equal-length pass is a no-op).
      expect(memoryEngine.processConversationHistory).toHaveBeenCalledTimes(2);
    });

    it('silently skips memory engine processing when UCAN signing key missing', async () => {
      ucanService.hasSigningKey.mockReturnValue(false);

      await svc.processSessionHistory({ ...baseParams });

      expect(ucanService.createServiceInvocation).not.toHaveBeenCalled();
      expect(memoryEngine.processConversationHistory).not.toHaveBeenCalled();
      expect(sessionManager.updateLastProcessedCount).not.toHaveBeenCalled();
    });

    it('skips memory engine + updateLastProcessedCount when UCAN invocation cannot be minted', async () => {
      ucanService.createServiceInvocation.mockResolvedValueOnce(null);

      await svc.processSessionHistory({ ...baseParams });

      expect(memoryEngine.processConversationHistory).not.toHaveBeenCalled();
      expect(sessionManager.updateLastProcessedCount).not.toHaveBeenCalled();
    });

    it('invokes memory engine with transformed messages, roomId, and UCAN invocation, then updates lastProcessedCount', async () => {
      sessionManager.getSession.mockResolvedValue(
        makeSession({ lastProcessedCount: 0, title: 'Hello' }),
      );
      messagesService.listMessages.mockResolvedValue({
        messages: [
          makeMessage('human', 'hi'),
          makeMessage('ai', 'hello'),
          makeMessage('system', 'sys'),
          makeMessage('tool', 'tool reply'),
        ],
      });
      // Display name cascade: prefs blank, matrix returns 'Alice'.
      matrixGetDisplayName.mockResolvedValue('Alice');

      await svc.processSessionHistory({ ...baseParams });

      expect(memoryEngine.processConversationHistory).toHaveBeenCalledTimes(1);
      const call = memoryEngine.processConversationHistory.mock.calls[0][0];
      expect(call.roomId).toBe(ROOM_ID);
      expect(call.ucanInvocation).toBe('ucan-invocation');
      // Matrix base URL trailing-slash stripped + scheme removed for oracleHomeServer.
      expect(call.oracleHomeServer).toBe('matrix.test');
      expect(call.userHomeServer).toBe(HOME_SERVER);
      expect(call.messages).toEqual([
        {
          content: 'hi',
          role_type: 'user',
          role: 'Alice',
          name: 'Alice',
          source_description: 'Chat Session: Hello',
        },
        {
          content: 'hello',
          role_type: 'assistant',
          role: ORACLE_NAME,
          name: ORACLE_NAME,
          source_description: 'Chat Session: Hello',
        },
        {
          content: 'sys',
          role_type: 'system',
          role: 'System',
          name: 'System',
          source_description: 'Chat Session: Hello',
        },
        {
          content: 'tool reply',
          role_type: 'assistant',
          role: ORACLE_NAME,
          name: ORACLE_NAME,
          source_description: 'Chat Session: Hello',
        },
      ]);

      expect(sessionManager.updateLastProcessedCount).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        did: USER_DID,
        lastProcessedCount: 4,
      });
    });

    it('retries when memory engine returns success=false (treats as failure)', async () => {
      memoryEngine.processConversationHistory.mockResolvedValue({
        success: false,
      });
      vi.useFakeTimers();
      const promise = svc.processSessionHistory({ ...baseParams });
      // Capture as pending — don't await yet, the fake clock needs to
      // advance through the retry delays first. Lint rule can't see the
      // deferred `await settled` a few lines down.
      // eslint-disable-next-line vitest/valid-expect
      const settled = expect(promise).rejects.toThrow(/memory engine/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
      vi.useRealTimers();

      expect(memoryEngine.processConversationHistory).toHaveBeenCalledTimes(3);
      expect(sessionManager.updateLastProcessedCount).not.toHaveBeenCalled();
    });
  });

  describe('resolveUserDisplayName cascade', () => {
    it('returns prefs.userName when non-empty', async () => {
      prefsGetSpy.mockResolvedValue({
        userName: '  Bob  ',
        updatedAt: '2026-05-21T00:00:00Z',
      });

      await svc.processSessionHistory({ ...baseParams });

      expect(matrixGetDisplayName).not.toHaveBeenCalled();
      const call = memoryEngine.processConversationHistory.mock.calls[0][0];
      expect(call.messages[0].role).toBe('Bob');
      expect(call.messages[0].name).toBe('Bob');
    });

    it('falls back to Matrix displayName when prefs.userName is blank', async () => {
      prefsGetSpy.mockResolvedValue({
        userName: '   ',
        updatedAt: '2026-05-21T00:00:00Z',
      });
      matrixGetDisplayName.mockResolvedValue('Carol');

      await svc.processSessionHistory({ ...baseParams });

      expect(matrixGetDisplayName).toHaveBeenCalledTimes(1);
      const call = memoryEngine.processConversationHistory.mock.calls[0][0];
      expect(call.messages[0].role).toBe('Carol');
    });

    it('falls back to "Me" when Matrix lookup throws and prefs are missing', async () => {
      matrixGetDisplayName.mockRejectedValue(new Error('matrix down'));

      await svc.processSessionHistory({ ...baseParams });

      const call = memoryEngine.processConversationHistory.mock.calls[0][0];
      expect(call.messages[0].role).toBe('Me');
      expect(call.messages[0].name).toBe('Me');
    });
  });
});
