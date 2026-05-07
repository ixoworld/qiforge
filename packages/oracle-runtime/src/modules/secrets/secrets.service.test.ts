import type { Cache } from 'cache-manager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsService } from './secrets.service.js';

vi.mock('@ixo/matrix', () => {
  const getRoomState = vi.fn(async () => []);
  const getEventById = vi.fn(async () => ({ content: { value: '' } }));
  const fakeClient = { mxClient: { getRoomState } };
  return {
    MatrixManager: {
      getInstance: () => ({
        getClient: () => fakeClient,
        getEventById,
      }),
    },
    __mocks: { getRoomState, getEventById },
  };
});

vi.mock('@ixo/oracles-chain-client', () => ({
  decryptJWE: vi.fn(async (jwe: string) => `decrypted:${jwe}`),
}));

interface CacheMock extends Partial<Cache> {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function makeCache(): CacheMock {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  };
}

async function getMatrixMocks() {
  const mod = (await import('@ixo/matrix')) as unknown as {
    __mocks: {
      getRoomState: ReturnType<typeof vi.fn>;
      getEventById: ReturnType<typeof vi.fn>;
    };
  };
  return mod.__mocks;
}

describe('SecretsService', () => {
  let svc: SecretsService;
  let cache: CacheMock;

  beforeEach(async () => {
    // Reset singleton between tests
    (SecretsService as unknown as { instance?: unknown }).instance = undefined;
    svc = SecretsService.getInstance();
    cache = makeCache();
    svc.setCacheManager(cache as unknown as Cache);
    const matrixMocks = await getMatrixMocks();
    matrixMocks.getRoomState.mockReset();
    matrixMocks.getEventById.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the same singleton instance', () => {
    expect(SecretsService.getInstance()).toBe(svc);
  });

  it('getSecretIndex filters out non-index events and empty content', async () => {
    const matrixMocks = await getMatrixMocks();
    matrixMocks.getRoomState.mockResolvedValueOnce([
      {
        type: 'ixo.room.secret.index',
        state_key: 'OPENAI_KEY',
        content: { eventId: 'evt1', publicKeyId: 'pk1' },
      },
      {
        type: 'm.room.member',
        state_key: 'someone',
        content: { eventId: 'evt2' },
      },
      {
        type: 'ixo.room.secret.index',
        state_key: 'DELETED_SECRET',
        content: {},
      },
      {
        type: 'ixo.room.secret.index',
        state_key: 'NO_EVENT_ID',
        content: { publicKeyId: 'pk2' },
      },
    ]);

    const index = await svc.getSecretIndex('!room1');
    expect(index).toEqual([
      { name: 'OPENAI_KEY', eventId: 'evt1', publicKeyId: 'pk1' },
    ]);
  });

  it('getSecretIndex returns [] on error', async () => {
    const matrixMocks = await getMatrixMocks();
    matrixMocks.getRoomState.mockRejectedValueOnce(new Error('boom'));
    const index = await svc.getSecretIndex('!room1');
    expect(index).toEqual([]);
  });

  it('loadSecretValues uses cache hit when eventId matches', async () => {
    const fakeKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as never;
    svc.setEncryptionKey(fakeKey);

    cache.store.set('secret:!room1:KEY', { value: 'cached', eventId: 'evt1' });

    const result = await svc.loadSecretValues('!room1', [
      { name: 'KEY', eventId: 'evt1', publicKeyId: 'pk1' },
    ]);

    expect(result).toEqual({ KEY: 'cached' });
    const matrixMocks = await getMatrixMocks();
    expect(matrixMocks.getEventById).not.toHaveBeenCalled();
  });

  it('loadSecretValues fetches and decrypts when cache miss', async () => {
    const fakeKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as never;
    svc.setEncryptionKey(fakeKey);

    const matrixMocks = await getMatrixMocks();
    matrixMocks.getEventById.mockResolvedValueOnce({
      content: { value: 'jwe-blob' },
    });

    const result = await svc.loadSecretValues('!room1', [
      { name: 'KEY', eventId: 'evt-new', publicKeyId: 'pk1' },
    ]);

    expect(result).toEqual({ KEY: 'decrypted:jwe-blob' });
    // Cache is updated with the decrypted value
    expect(cache.set).toHaveBeenCalledWith(
      'secret:!room1:KEY',
      { value: 'decrypted:jwe-blob', eventId: 'evt-new' },
      expect.any(Number),
    );
  });

  it('loadSecretValues skips secrets when no encryption key set', async () => {
    const matrixMocks = await getMatrixMocks();
    matrixMocks.getEventById.mockResolvedValueOnce({
      content: { value: 'jwe-blob' },
    });

    const result = await svc.loadSecretValues('!room1', [
      { name: 'KEY', eventId: 'evt-new', publicKeyId: 'pk1' },
    ]);

    expect(result).toEqual({});
  });
});
