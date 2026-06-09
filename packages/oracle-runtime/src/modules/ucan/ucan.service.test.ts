import type { Cache } from 'cache-manager';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationStore, StoredDelegation } from './delegation-store.js';
import { UcanService } from './ucan.service.js';

const { getOracleRoomIdMock, getMatrixHomeServerMock } = vi.hoisted(() => ({
  getOracleRoomIdMock: vi.fn(),
  getMatrixHomeServerMock: vi.fn(),
}));

vi.mock('@ixo/matrix', () => ({
  MatrixManager: {
    getInstance: () => ({
      getOracleRoomIdWithHomeServer: getOracleRoomIdMock,
    }),
  },
}));

vi.mock('@ixo/oracles-chain-client', () => ({
  getMatrixHomeServerCroppedForDid: getMatrixHomeServerMock,
}));

interface DelegationStoreMock {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

function makeDelegationStore(): DelegationStoreMock {
  return {
    read: vi.fn(async () => null as StoredDelegation | null),
    write: vi.fn(async () => undefined),
  };
}

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

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: vi.fn(<T>(key: string): T | undefined => values[key] as T | undefined),
    getOrThrow: vi.fn(<T>(key: string): T => {
      if (!(key in values)) {
        throw new Error(`Config "${key}" missing`);
      }
      return values[key] as T;
    }),
  } as unknown as ConfigService;
}

const ORACLE_DID = 'did:ixo:oracle1';

describe('UcanService', () => {
  let svc: UcanService;
  let cache: CacheMock;
  let cfg: ConfigService;
  let delegationStore: DelegationStoreMock;

  beforeEach(() => {
    cache = makeCache();
    cfg = makeConfig({
      ORACLE_ENTITY_DID: ORACLE_DID,
      BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.example/graphql',
    });
    delegationStore = makeDelegationStore();
    // The canonical user↔oracle room is resolved inside UcanService now; mock
    // the resolution so read/write still target a known room (`!room:home`).
    getMatrixHomeServerMock.mockResolvedValue('home');
    getOracleRoomIdMock.mockResolvedValue({ roomId: '!room:home' });
    svc = new UcanService(
      cfg,
      cache as unknown as Cache,
      delegationStore as unknown as DelegationStore,
    );
  });

  afterEach(() => {
    svc.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('reports oracle DID from config', () => {
    expect(svc.getOracleDid()).toBe(ORACLE_DID);
  });

  it('falls back to oracleDid as the only root issuer when none configured', () => {
    expect(svc.getRootIssuers()).toEqual([ORACLE_DID]);
  });

  it('hasSigningKey starts false and flips after setSigningMnemonic', () => {
    expect(svc.hasSigningKey()).toBe(false);
    svc.setSigningMnemonic('seed words here', ORACLE_DID);
    expect(svc.hasSigningKey()).toBe(true);
  });

  it('cacheDelegation stores raw delegation under the user DID prefix', async () => {
    await svc.cacheDelegation(
      'did:ixo:user1',
      'raw-delegation',
      Math.floor(Date.now() / 1000) + 600,
    );
    expect(cache.set).toHaveBeenCalled();
    const [key, val] =
      (cache.set.mock.calls[0] as unknown as [string, string]) ?? [];
    expect(key).toBe('ucan_delegation_did:ixo:user1');
    expect(val).toBe('raw-delegation');
  });

  it('cacheDelegation skips if expiration already in the past', async () => {
    await svc.cacheDelegation(
      'did:ixo:user1',
      'raw-delegation',
      Math.floor(Date.now() / 1000) - 60,
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('getCachedDelegation returns null when not cached', async () => {
    expect(await svc.getCachedDelegation('did:ixo:nobody')).toBeNull();
  });

  it('getCachedDelegation returns previously cached value', async () => {
    cache.store.set('ucan_delegation_did:ixo:user1', 'raw-delegation');
    expect(await svc.getCachedDelegation('did:ixo:user1')).toBe(
      'raw-delegation',
    );
  });

  it('getRequiredCapabilityURI builds the standard MCP resource pattern', () => {
    const uri = svc.getRequiredCapabilityURI('servername', 'toolname');
    expect(uri).toBe(`ixo:oracle:${ORACLE_DID}:mcp/servername/toolname`);
  });

  it('requiresAuth returns false for unconfigured servers', () => {
    expect(svc.requiresAuth('postgres')).toBe(false);
  });

  it('validateMCPInvocation rejects empty invocation data', async () => {
    const result = await svc.validateMCPInvocation(
      'srv',
      'tool',
      new Uint8Array(),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  it('validateMCPInvocation accepts non-empty (placeholder mode) and detects replays', async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const first = await svc.validateMCPInvocation('srv', 'tool', data);
    expect(first.valid).toBe(true);

    const second = await svc.validateMCPInvocation('srv', 'tool', data);
    expect(second.valid).toBe(false);
    expect(second.error).toMatch(/replay/i);
  });

  describe('getDelegationForUser', () => {
    const USER = 'did:ixo:user1';
    const ROOM = '!room:home';

    it('returns the cached delegation without touching the store (fast path)', async () => {
      cache.store.set(`ucan_delegation_${USER}`, 'cached-raw');

      const result = await svc.getDelegationForUser(USER);

      expect(result).toBe('cached-raw');
      expect(delegationStore.read).not.toHaveBeenCalled();
    });

    it('falls back to the store on cache miss, re-warms the cache, and returns raw', async () => {
      const expiration = Math.floor(Date.now() / 1000) + 600;
      delegationStore.read.mockResolvedValue({
        raw: 'stored-raw',
        issuer: 'did:ixo:user1',
        audience: ORACLE_DID,
        expiration,
        updatedAt: new Date().toISOString(),
      });

      const result = await svc.getDelegationForUser(USER);

      expect(delegationStore.read).toHaveBeenCalledWith(ROOM);
      expect(result).toBe('stored-raw');
      // Re-warmed so mintInvocationForServiceDid finds it downstream.
      expect(await svc.getCachedDelegation(USER)).toBe('stored-raw');
    });

    it('returns null when the store has nothing', async () => {
      delegationStore.read.mockResolvedValue(null);

      expect(await svc.getDelegationForUser(USER)).toBeNull();
    });

    it('returns null (and does not re-warm) when the stored delegation is expired', async () => {
      delegationStore.read.mockResolvedValue({
        raw: 'expired-raw',
        expiration: Math.floor(Date.now() / 1000) - 60,
        updatedAt: new Date().toISOString(),
      });

      expect(await svc.getDelegationForUser(USER)).toBeNull();
      expect(await svc.getCachedDelegation(USER)).toBeNull();
    });

    it('returns null when the store read throws (non-throwing contract)', async () => {
      delegationStore.read.mockRejectedValue(new Error('matrix down'));

      expect(await svc.getDelegationForUser(USER)).toBeNull();
    });
  });

  describe('storeDelegationForUser', () => {
    const USER = 'did:ixo:user1';
    const ROOM = '!room:home';

    it('writes to the store AND warms the in-memory cache', async () => {
      const expiration = Math.floor(Date.now() / 1000) + 600;

      await svc.storeDelegationForUser(USER, 'fresh-raw', {
        issuer: USER,
        audience: ORACLE_DID,
        expiration,
      });

      expect(delegationStore.write).toHaveBeenCalledWith(ROOM, {
        raw: 'fresh-raw',
        issuer: USER,
        audience: ORACLE_DID,
        expiration,
      });
      expect(await svc.getCachedDelegation(USER)).toBe('fresh-raw');
    });
  });
});
