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
  const config =
    opts.config ?? makeConfig({ MEMORY_ENGINE_URL, ORACLE_DID });
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
      `user-context:${SESSION_ID}`,
      fetched,
      expect.any(Number),
    );
  });

  it('returns undefined and does not rethrow when createServiceInvocation throws', async () => {
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
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns undefined when createServiceInvocation resolves to null', async () => {
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
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns undefined and does NOT cache when gatherUserContext throws', async () => {
    cache.get.mockResolvedValue(undefined);
    memoryEngine.gatherUserContext.mockRejectedValue(new Error('engine boom'));
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    const result = await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(result).toBeUndefined();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('uses sessionId (not roomId) for the cache key — regression check', async () => {
    cache.get.mockResolvedValue(undefined);
    const fetched = { identity: { name: 'Carol' } };
    memoryEngine.gatherUserContext.mockResolvedValue(fetched);
    const fetcher = makeFetcher({ cache, memoryEngine, ucanService });

    await fetcher.fetch({
      roomId: ROOM_ID,
      userDid: USER_DID,
      sessionId: SESSION_ID,
    });

    expect(cache.get).toHaveBeenCalledWith(`user-context:${SESSION_ID}`);
    expect(cache.get).not.toHaveBeenCalledWith(`user-context:${ROOM_ID}`);
    expect(cache.set).toHaveBeenCalledWith(
      `user-context:${SESSION_ID}`,
      fetched,
      expect.any(Number),
    );
  });
});
