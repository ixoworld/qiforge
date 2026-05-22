import {
  type ChatSession,
  type SessionManagerService,
} from '@ixo/common';
import { SqliteSaver } from '@ixo/sqlite-saver';
import { AIMessage, HumanMessage, type BaseMessage } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { makeConfig } from '../../testing/nest-doubles.js';
import {
  PostMessageSyncer,
  type PostSyncInput,
} from './post-message-syncer.js';
import {
  makeCheckpointSync,
  makeSessionManagerStub,
} from './__test-fixtures__/deps.js';

vi.mock('@ixo/sqlite-saver', () => ({
  SqliteSaver: {
    fromDatabase: vi.fn(() => ({ getTuple: vi.fn() })),
  },
}));

vi.mock('@ixo/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ixo/common')>()),
  transformGraphStateMessageToListMessageResponse: vi.fn(
    (messages: BaseMessage[]) => ({
      messages: messages.map((m) => ({
        content: String(m.content),
        type: m.type,
        id: m.id ?? 'id',
      })),
      total: messages.length,
    }),
  ),
}));

const USER_DID = 'did:ixo:user-1';
const SESSION_ID = 'sess-1';
const LANGCHAIN_THREAD_ID = 'sess-1';
const ROOM_ID = '!room:home';
const ORACLE_NAME = 'TestOracle';
const ORACLE_DID = 'did:ixo:oracle';
const ORACLE_ENTITY_DID = 'did:ixo:oracle-entity';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: SESSION_ID,
    lastUpdatedAt: '2026-05-21T00:00:00.000Z',
    createdAt: '2026-05-20T00:00:00.000Z',
    oracleName: ORACLE_NAME,
    oracleDid: ORACLE_DID,
    oracleEntityDid: ORACLE_ENTITY_DID,
    lastProcessedCount: 7,
    roomId: ROOM_ID,
    ...overrides,
  };
}

function makeInput(overrides: Partial<PostSyncInput> = {}): PostSyncInput {
  return {
    did: USER_DID,
    sessionId: SESSION_ID,
    langchainThreadId: LANGCHAIN_THREAD_ID,
    roomId: ROOM_ID,
    targetSession: makeSession(),
    ...overrides,
  };
}

interface ServiceUnderTest {
  svc: PostMessageSyncer;
  checkpointSync: ReturnType<typeof makeCheckpointSync>;
  sessions: ReturnType<typeof makeSessionManagerStub>;
}

function build(): ServiceUnderTest {
  const checkpointSync = makeCheckpointSync();
  const sessions = makeSessionManagerStub();
  const config = makeConfig({
    ORACLE_NAME,
    ORACLE_DID,
    ORACLE_ENTITY_DID,
  });
  const svc = new PostMessageSyncer(
    checkpointSync as unknown as UserMatrixSqliteSyncService,
    sessions as unknown as SessionManagerService,
    config,
  );
  checkpointSync.getUserDatabaseNoSync.mockResolvedValue({ handle: 'db' });
  sessions.syncSessionSet.mockResolvedValue(makeSession());
  vi.mocked(SqliteSaver.fromDatabase).mockReturnValue({
    getTuple: vi.fn().mockResolvedValue({
      checkpoint: { channel_values: { messages: [] } },
    }),
  } as unknown as ReturnType<typeof SqliteSaver.fromDatabase>);
  return { svc, checkpointSync, sessions };
}

describe('PostMessageSyncer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('run', () => {
    it('returns synchronously (void) and schedules a microtask', async () => {
      const { svc, checkpointSync } = build();

      const result = svc.run(makeInput());

      expect(result).toBeUndefined();
      expect(checkpointSync.markUserInactive).not.toHaveBeenCalled();

      await vi.waitFor(() =>
        expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1),
      );
    });

    it('always calls markUserInactive in finally on the success path', async () => {
      const { svc, checkpointSync, sessions } = build();

      svc.run(makeInput());

      await vi.waitFor(() =>
        expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1),
      );
      expect(checkpointSync.markUserInactive).toHaveBeenCalledWith(USER_DID);
      expect(sessions.syncSessionSet).toHaveBeenCalledTimes(1);
    });

    it('calls markUserInactive when getUserDatabaseNoSync throws', async () => {
      const { svc, checkpointSync, sessions } = build();
      checkpointSync.getUserDatabaseNoSync.mockRejectedValueOnce(
        new Error('db gone'),
      );

      svc.run(makeInput());

      await vi.waitFor(() =>
        expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1),
      );
      expect(checkpointSync.markUserInactive).toHaveBeenCalledWith(USER_DID);
      expect(sessions.syncSessionSet).not.toHaveBeenCalled();
    });

    it('calls markUserInactive when sessions.syncSessionSet throws', async () => {
      const { svc, checkpointSync, sessions } = build();
      sessions.syncSessionSet.mockRejectedValueOnce(new Error('write failed'));

      svc.run(makeInput());

      await vi.waitFor(() =>
        expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1),
      );
      expect(checkpointSync.markUserInactive).toHaveBeenCalledWith(USER_DID);
    });

    it('calls sessions.syncSessionSet with messages mapped from the transformed list', async () => {
      const { svc, sessions } = build();
      const messages = [new HumanMessage('hello'), new AIMessage('world')];
      vi.mocked(SqliteSaver.fromDatabase).mockReturnValueOnce({
        getTuple: vi.fn().mockResolvedValue({
          checkpoint: { channel_values: { messages } },
        }),
      } as unknown as ReturnType<typeof SqliteSaver.fromDatabase>);

      svc.run(makeInput());

      await vi.waitFor(() =>
        expect(sessions.syncSessionSet).toHaveBeenCalledTimes(1),
      );
      expect(sessions.syncSessionSet).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        oracleName: ORACLE_NAME,
        did: USER_DID,
        messages: ['hello', 'world'],
        oracleDid: ORACLE_DID,
        oracleEntityDid: ORACLE_ENTITY_DID,
        lastProcessedCount: 7,
        roomId: ROOM_ID,
      });
    });

    it('reads from the cached connection via getUserDatabaseNoSync (NOT getUserDatabase)', async () => {
      const { svc, checkpointSync } = build();
      const db = { handle: 'cached-db' };
      checkpointSync.getUserDatabaseNoSync.mockResolvedValueOnce(db);

      svc.run(makeInput());

      await vi.waitFor(() =>
        expect(checkpointSync.markUserInactive).toHaveBeenCalledTimes(1),
      );
      expect(checkpointSync.getUserDatabaseNoSync).toHaveBeenCalledWith(
        USER_DID,
      );
      expect(checkpointSync.getUserDatabase).not.toHaveBeenCalled();
      expect(SqliteSaver.fromDatabase).toHaveBeenCalledWith(db);
    });

    it('coalesces missing targetSession.lastProcessedCount to 0', async () => {
      const { svc, sessions } = build();
      const targetSession = makeSession();
      // Force the field off without `as any`: ChatSession allows partial via
      // override map; we mutate via index access to preserve typing.
      Reflect.deleteProperty(targetSession, 'lastProcessedCount');

      svc.run(makeInput({ targetSession }));

      await vi.waitFor(() =>
        expect(sessions.syncSessionSet).toHaveBeenCalledTimes(1),
      );
      expect(sessions.syncSessionSet).toHaveBeenCalledWith(
        expect.objectContaining({ lastProcessedCount: 0 }),
      );
    });
  });
});
