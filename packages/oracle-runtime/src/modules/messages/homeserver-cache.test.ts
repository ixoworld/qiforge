import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeServerCache } from './homeserver-cache.js';

vi.mock('@ixo/oracles-chain-client', () => ({
  getMatrixHomeServerCroppedForDid: vi.fn(),
}));

const mockedGetHomeServer = vi.mocked(getMatrixHomeServerCroppedForDid);

const USER_DID = 'did:ixo:user-1';
const HOME_SERVER = 'home.server';
const TTL_MS = 60 * 60 * 1000;

describe('HomeServerCache', () => {
  let cache: HomeServerCache;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:00:00.000Z'));
    mockedGetHomeServer.mockResolvedValue(HOME_SERVER);
    cache = new HomeServerCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls getMatrixHomeServerCroppedForDid and caches on first get()', async () => {
    const result = await cache.get(USER_DID);

    expect(result).toBe(HOME_SERVER);
    expect(mockedGetHomeServer).toHaveBeenCalledTimes(1);
    expect(mockedGetHomeServer).toHaveBeenCalledWith(USER_DID);
  });

  it('reuses the cached value on a second call within the 1h TTL', async () => {
    await cache.get(USER_DID);
    vi.advanceTimersByTime(TTL_MS - 1);

    const second = await cache.get(USER_DID);

    expect(second).toBe(HOME_SERVER);
    expect(mockedGetHomeServer).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the cached entry has expired', async () => {
    await cache.get(USER_DID);
    mockedGetHomeServer.mockResolvedValueOnce('new.home.server');
    vi.advanceTimersByTime(TTL_MS + 1);

    const second = await cache.get(USER_DID);

    expect(second).toBe('new.home.server');
    expect(mockedGetHomeServer).toHaveBeenCalledTimes(2);
  });

  it('documents that concurrent gets for the same DID double-fetch (no locking)', async () => {
    // Current implementation has no in-flight de-duplication: if two callers
    // hit get() before the first awaited fetch resolves, both observe an empty
    // cache and trigger the chain lookup. This test pins the behavior so a
    // future fix (adding a single-flight map) is an intentional change, not
    // an accidental regression.
    let resolveFetch: (value: string) => void = () => undefined;
    mockedGetHomeServer.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    mockedGetHomeServer.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolve(HOME_SERVER);
        }),
    );

    const first = cache.get(USER_DID);
    const second = cache.get(USER_DID);

    expect(mockedGetHomeServer).toHaveBeenCalledTimes(2);

    resolveFetch(HOME_SERVER);
    await expect(first).resolves.toBe(HOME_SERVER);
    await expect(second).resolves.toBe(HOME_SERVER);
  });
});
