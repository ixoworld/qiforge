import { type MatrixManager } from '@ixo/matrix';
import { type Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionManagerService,
  type IDatabaseSyncService,
} from './session-manager.service.js';
import { generateSessionTitle } from './session-title.js';

vi.mock('@ixo/matrix', () => ({
  MatrixManager: { getInstance: vi.fn() },
}));

vi.mock('@ixo/oracles-chain-client', () => ({
  getMatrixHomeServerCroppedForDid: vi.fn(),
}));

vi.mock('./session-title.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-title.js')>()),
  generateSessionTitle: vi.fn(),
}));

const SESSION_ID = '$root-event:home';
const DID = 'did:ixo:user-1';
const ROOM_ID = '!room:home';

interface SessionRow {
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

function makeDb(overrides: Partial<SessionRow> = {}) {
  const row: SessionRow = {
    session_id: SESSION_ID,
    title: 'Untitled',
    last_updated_at: '2026-05-20T00:00:00.000Z',
    created_at: '2026-05-20T00:00:00.000Z',
    oracle_name: 'TestOracle',
    oracle_did: 'did:ixo:oracle',
    oracle_entity_did: 'did:ixo:oracle-entity',
    last_processed_count: 3,
    user_context: null,
    room_id: ROOM_ID,
    slack_thread_ts: 'ts-1',
    ...overrides,
  };
  const titleWrites: string[] = [];

  const isPlaceholder = (title: string | null): boolean =>
    title === null || title.trim() === '' || title.toLowerCase() === 'untitled';

  const db = {
    prepare: (sql: string) => ({
      get: () => row,
      all: () => [],
      run: (...params: unknown[]) => {
        if (sql.includes('SET title')) {
          if (!isPlaceholder(row.title)) return { changes: 0 };
          row.title = String(params[0]);
          titleWrites.push(row.title);
          return { changes: 1 };
        }
        if (sql.includes('SET last_updated_at')) {
          row.last_updated_at = String(params[0]);
          row.last_processed_count = params[1] as number | null;
          row.slack_thread_ts = params[2] as string | null;
          return { changes: 1 };
        }
        return { changes: 0 };
      },
    }),
  };

  return { db: db as unknown as Database, row, titleWrites };
}

function build(dbOverrides: Partial<SessionRow> = {}) {
  const { db, row, titleWrites } = makeDb(dbOverrides);
  const syncService: IDatabaseSyncService = {
    getUserDatabase: vi.fn().mockResolvedValue(db),
  };
  const matrix = { editMessage: vi.fn().mockResolvedValue(undefined) };
  const service = new SessionManagerService(
    syncService,
    matrix as unknown as MatrixManager,
  );
  return { service, row, titleWrites, matrix };
}

function syncInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    did: DID,
    oracleName: 'TestOracle',
    oracleDid: 'did:ixo:oracle',
    oracleEntityDid: 'did:ixo:oracle-entity',
    roomId: ROOM_ID,
    messages: [
      { type: 'human' as const, content: 'my care visit ran over' },
      { type: 'ai' as const, content: 'Log it and notify your supervisor.' },
    ],
    ...overrides,
  };
}

describe('SessionManagerService title generation', () => {
  beforeEach(() => {
    vi.mocked(generateSessionTitle).mockReset();
    vi.mocked(generateSessionTitle).mockResolvedValue('Care Visit Logging');
  });

  it('names an untitled session once and renames the Matrix root event', async () => {
    const { service, row, matrix } = build();

    const session = await service.syncSessionSet(syncInput());

    expect(session.title).toBe('Care Visit Logging');
    expect(row.title).toBe('Care Visit Logging');
    expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(matrix.editMessage).toHaveBeenCalledTimes(1);
    expect(matrix.editMessage).toHaveBeenCalledWith({
      messageId: SESSION_ID,
      roomId: ROOM_ID,
      message: 'Care Visit Logging',
      isOracleAdmin: true,
    });
  });

  it('generates one title for concurrent post-turn syncs', async () => {
    const { service, titleWrites, matrix } = build();
    let release: (title: string) => void = () => undefined;
    vi.mocked(generateSessionTitle).mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    const first = service.syncSessionSet(syncInput());
    const second = service.syncSessionSet(syncInput());
    release('Care Visit Logging');
    const [a, b] = await Promise.all([first, second]);

    expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(titleWrites).toEqual(['Care Visit Logging']);
    expect(matrix.editMessage).toHaveBeenCalledTimes(1);
    expect(a.title).toBe('Care Visit Logging');
    expect(b.title).toBe('Care Visit Logging');
  });

  it('never re-names a session that already has a title', async () => {
    const { service, matrix } = build({ title: 'Care Visit Logging' });

    const session = await service.syncSessionSet(syncInput());

    expect(session.title).toBe('Care Visit Logging');
    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(matrix.editMessage).not.toHaveBeenCalled();
  });

  it('keeps the title another writer landed first, without a second rename', async () => {
    const { service, row, matrix } = build();
    vi.mocked(generateSessionTitle).mockImplementation(async () => {
      // Another process (or replica) titled the row while the model ran.
      row.title = 'Visit Overrun Reporting';
      return 'Care Visit Logging';
    });

    const session = await service.syncSessionSet(syncInput());

    expect(row.title).toBe('Visit Overrun Reporting');
    expect(session.title).toBe('Visit Overrun Reporting');
    expect(matrix.editMessage).not.toHaveBeenCalled();
  });

  it('holds the placeholder when the conversation cannot be named yet', async () => {
    const { service, row, matrix } = build();
    vi.mocked(generateSessionTitle).mockResolvedValue(null);

    const session = await service.syncSessionSet(
      syncInput({ messages: [{ type: 'human', content: 'hi' }] }),
    );

    expect(session.title).toBe('Untitled');
    expect(row.title).toBe('Untitled');
    expect(matrix.editMessage).not.toHaveBeenCalled();
  });

  it('preserves the Slack thread binding when the caller omits it', async () => {
    const { service, row } = build();

    await service.syncSessionSet(syncInput());

    expect(row.slack_thread_ts).toBe('ts-1');
  });
});
