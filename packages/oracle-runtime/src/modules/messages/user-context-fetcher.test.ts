import type { MemoryEngineService } from '@ixo/common';
import type { Cache } from '@nestjs/cache-manager';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '../../testing/nest-doubles.js';
import type { UcanService } from '../ucan/ucan.service.js';
import { UserContextFetcher } from './user-context-fetcher.js';

const MEMORY_ENGINE_URL = 'https://memory.example';
const ORACLE_DID = 'did:ixo:oracle';
const USER_DID = 'did:ixo:user-1';
const SESSION_ID = 'sess-1';
const ROOM_ID = '!room:home.server';
const INVOCATION = 'ucan-invocation-base64';

const CACHE_KEY = `user-context:room:${ROOM_ID}`;
const FAILURE_KEY = `user-context:room:${ROOM_ID}:unavailable`;

function makeCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  };
}

function makeUcanService() {
  return {
    hasSigningKey: vi.fn().mockReturnValue(true),
    createServiceInvocation: vi.fn().mockResolvedValue(INVOCATION),
  };
}

function makeMemoryEngine() {
  return {
    gatherUserContext: vi.fn(),
  };
}

function makeFetcher(opts: {
  cache: ReturnType<typeof makeCache>;
  memoryEngine: ReturnType<typeof makeMemoryEngine> | null;
  ucanService: ReturnType<typeof makeUcanService>;
  config?: ConfigService;
}): UserContextFetcher {
  const config = opts.config ?? makeConfig({ MEMORY_ENGINE_URL, ORACLE_DID });
  return new UserContextFetcher(
    opts.cache as unknown as Cache,
    opts.memoryEngine as unknown as MemoryEngineService | null,
    opts.ucanService as unknown as UcanService,
    config,
  );
}

describe('UserContextFetcher.fetch', () => {
  let cache: ReturnType<typeof makeCache>;
  let ucanService: ReturnType<typeof makeUcanService>;
  let memoryEngine: ReturnType<typeof makeMemoryEngine>;

  beforeEach(() => {
    vi.resetAllMocks();
    cache = makeCache();
    ucanService = makeUcanService();
    memoryEngine = makeMemoryEngine();
  });

  it('returns undefined when memoryEngine is null', async () => {
    const fetcher = makeFetcher({ cache, memoryEngine: null, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toBeUndefined();
    expect(cache.get).not.toHaveBeenCalled();
    expect(ucanService.createServiceInvocation).not.toHaveBeenCalled();
  });

  it('returns undefined when ucanService.hasSigningKey() is false', async () => {
    ucanService.hasSigningKey.mockReturnValue(false);
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toBeUndefined();
    expect(cache.get).not.toHaveBeenCalled();
    expect(memoryEngine.gatherUserContext).not.toHaveBeenCalled();
  });

  it('returns cached value and short-circuits the engine call on cache hit', async () => {
    const cached = { identity: { name: 'Alice' } };
    cache.get.mockResolvedValue(cached);
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toEqual(cached);
    expect(ucanService.createServiceInvocation).not.toHaveBeenCalled();
    expect(memoryEngine.gatherUserContext).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('on cache miss mints invocation, calls gatherUserContext, then caches result', async () => {
    cache.get.mockResolvedValue(undefined);
    const fetched = { identity: { name: 'Bob' }, work: { role: 'eng' } };
    memoryEngine.gatherUserContext.mockResolvedValue(fetched);
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(ucanService.createServiceInvocation).toHaveBeenCalledWith(
      MEMORY_ENGINE_URL,
      USER_DID,
      'ixo:memory',
      // Must claim the granted ability, not '*' — a '*' claim is satisfiable
      // only by a '*' grant, and the delegation grants 'memory/*'.
      { can: 'memory/*' },
    );
    expect(memoryEngine.gatherUserContext).toHaveBeenCalledWith({
      oracleDid: ORACLE_DID,
      roomId: ROOM_ID,
      oracleToken: '',
      userToken: '',
      oracleHomeServer: '',
      userHomeServer: '',
      ucanInvocation: INVOCATION,
    });
    expect(result).toEqual(fetched);
    expect(cache.set).toHaveBeenCalledWith(
      CACHE_KEY,
      fetched,
      expect.any(Number),
    );
  });

  it('returns undefined, negative-caches, and does not rethrow when createServiceInvocation throws', async () => {
    cache.get.mockResolvedValue(undefined);
    ucanService.createServiceInvocation.mockRejectedValue(
      new Error('did:web resolution failed'),
    );
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toBeUndefined();
    expect(memoryEngine.gatherUserContext).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith(
      FAILURE_KEY,
      true,
      expect.any(Number),
    );
    expect(cache.set).not.toHaveBeenCalledWith(
      CACHE_KEY,
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns undefined and negative-caches when createServiceInvocation resolves to null', async () => {
    cache.get.mockResolvedValue(undefined);
    ucanService.createServiceInvocation.mockResolvedValue(null);
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toBeUndefined();
    expect(memoryEngine.gatherUserContext).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith(
      FAILURE_KEY,
      true,
      expect.any(Number),
    );
  });

  it('returns undefined and negative-caches (never the positive key) when gatherUserContext throws', async () => {
    cache.get.mockResolvedValue(undefined);
    memoryEngine.gatherUserContext.mockRejectedValue(new Error('engine boom'));
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toBeUndefined();
    expect(cache.set).toHaveBeenCalledWith(
      FAILURE_KEY,
      true,
      expect.any(Number),
    );
    expect(cache.set).not.toHaveBeenCalledWith(
      CACHE_KEY,
      expect.anything(),
      expect.anything(),
    );
  });

  it('short-circuits without minting when the failure marker is cached', async () => {
    cache.get.mockImplementation((key: string) =>
      Promise.resolve(key === FAILURE_KEY ? true : undefined),
    );
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toBeUndefined();
    expect(ucanService.createServiceInvocation).not.toHaveBeenCalled();
    expect(memoryEngine.gatherUserContext).not.toHaveBeenCalled();
  });

  it('keys the cache by roomId (not sessionId) so a new session in the same room reuses it', async () => {
    cache.get.mockResolvedValue(undefined);
    const fetched = { identity: { name: 'Carol' } };
    memoryEngine.gatherUserContext.mockResolvedValue(fetched);
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(cache.get).toHaveBeenCalledWith(CACHE_KEY);
    expect(cache.get).not.toHaveBeenCalledWith(`user-context:${SESSION_ID}`);
    expect(cache.set).toHaveBeenCalledWith(
      CACHE_KEY,
      fetched,
      expect.any(Number),
    );
  });

  it('stops blocking at the cap but the late gather still warms the cache', async () => {
    vi.useFakeTimers();
    try {
      cache.get.mockResolvedValue(undefined);
      const fetched = { identity: { name: 'Slowpoke' } };
      // Resolves after 5s — past the 3s blocking cap.
      memoryEngine.gatherUserContext.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(fetched), 5_000);
          }),
      );
      const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

      const fetchPromise = fetcher.fetch({
        roomId: ROOM_ID,
        userDid: USER_DID,
        sessionId: SESSION_ID,
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await expect(fetchPromise).resolves.toBeUndefined();
      expect(cache.set).not.toHaveBeenCalledWith(
        CACHE_KEY,
        expect.anything(),
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(2_100);
      expect(cache.set).toHaveBeenCalledWith(
        CACHE_KEY,
        fetched,
        expect.any(Number),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
