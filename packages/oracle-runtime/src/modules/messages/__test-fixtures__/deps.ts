import { type ChatSession } from '@ixo/common';
import { vi } from 'vitest';
import { type PreparedRequest } from '../request-preparer.js';

/**
 * Stub for `UserMatrixSqliteSyncService`. Only the methods the chat
 * pipeline touches are present — `markUserActive`/`markUserInactive`
 * (ref-count contract), `getUserCheckpointer` (initial sync), and
 * `getUserCheckpointerNoSync` (cached connection used by
 * `PostMessageSyncer`). The `getUserDatabase*` pair is still stubbed for
 * `RequestPreparer`, which needs the raw connection rather than a saver.
 */
export function makeCheckpointSync() {
  return {
    markUserActive: vi.fn(),
    markUserInactive: vi.fn(),
    getUserDatabase: vi.fn(),
    getUserDatabaseNoSync: vi.fn(),
    getUserCheckpointer: vi.fn(),
    getUserCheckpointerNoSync: vi.fn(),
  };
}

/**
 * Stub for `SessionManagerService` plus its embedded `matrixManger`.
 * Returns `vi.fn()` for every method the chat pipeline calls so tests
 * can target individual methods with `.mockResolvedValueOnce(...)`.
 */
export function makeSessionManagerStub() {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    getSession: vi.fn(),
    updateLastProcessedCount: vi.fn(),
    syncSessionSet: vi.fn(),
    matrixManger: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getOracleRoomIdWithHomeServer: vi.fn(),
      getDisplayName: vi.fn(),
      getEventById: vi.fn(),
      onMessage: vi.fn(() => () => undefined),
      init: vi.fn().mockResolvedValue(undefined),
      // The bridge calls `getClient()?.mxClient.setTyping(...)` around each
      // delivery; `undefined` makes the optional chain a no-op in tests.
      getClient: vi.fn(() => undefined),
    },
  };
}

/**
 * Build a `PreparedRequest` with sensible defaults that downstream
 * consumers (`SseStreamRunner`, `BatchInvoker`, `MessagesService`) can
 * use as-is. Pass `overrides` to mutate any field per-test.
 */
export function makePrepared(
  overrides: Partial<PreparedRequest> = {},
): PreparedRequest {
  const baseSession: ChatSession = {
    sessionId: 'sess-1',
    lastUpdatedAt: '2026-05-21T00:00:00.000Z',
    createdAt: '2026-05-20T00:00:00.000Z',
    oracleName: 'TestOracle',
    oracleDid: 'did:ixo:oracle',
    oracleEntityDid: 'did:ixo:oracle-entity',
    lastProcessedCount: 0,
    roomId: '!room:home',
  };
  return {
    sessionId: 'sess-1',
    langchainThreadId: 'sess-1',
    roomId: '!room:home',
    homeServerName: 'home.server',
    requestId: 'req-1',
    runnableConfig: {
      configurable: {
        thread_id: 'sess-1',
        requestId: 'req-1',
        sessionId: 'sess-1',
      },
    },
    targetSession: baseSession,
    timezone: 'UTC',
    currentTime: '2026-05-21T00:00:00Z',
    ...overrides,
  };
}
