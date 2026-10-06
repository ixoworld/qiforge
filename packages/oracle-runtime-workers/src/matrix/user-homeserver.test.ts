import { describe, expect, it, vi } from 'vitest';
import {
  BLOCKSYNC_LOOKUP_TIMEOUT_MS,
  type CachedUserServerName,
  UNREGISTERED_CACHE_TTL_MS,
  extractUrlDomain,
  fetchUserMatrixServerName,
  lookupUserServerName,
  matrixServerNameFromServices,
  normalizeMatrixHomeServerUrl,
  UserServerNameUnavailableError,
} from './user-homeserver';

describe('user homeserver resolution', () => {
  it('normalises registration-supplied service endpoints', () => {
    expect(normalizeMatrixHomeServerUrl(' https://mx.ixo.earth/ \r\n')).toBe(
      'https://mx.ixo.earth',
    );
    expect(normalizeMatrixHomeServerUrl('devmx.ixo.earth')).toBe(
      'https://devmx.ixo.earth',
    );
    expect(normalizeMatrixHomeServerUrl('')).toBe('');
    expect(normalizeMatrixHomeServerUrl(undefined)).toBe('');
  });

  it('extracts the Matrix server name from a URL', () => {
    expect(extractUrlDomain('https://devmx.ixo.earth/')).toBe(
      'devmx.ixo.earth',
    );
    expect(extractUrlDomain('https://mx.mike-test.ixo.world:443/x')).toBe(
      'mx.mike-test.ixo.world',
    );
    expect(extractUrlDomain('not a url/with/path')).toBe('not a url');
  });

  it('picks the MatrixHomeServer service and ignores others', () => {
    expect(
      matrixServerNameFromServices([
        { type: 'LinkedDomains', serviceEndpoint: 'https://ixo.world' },
        {
          type: 'MatrixHomeServer',
          serviceEndpoint: 'https://DevMX.ixo.earth/',
        },
      ]),
    ).toBe('devmx.ixo.earth');
    expect(matrixServerNameFromServices([])).toBeNull();
    expect(matrixServerNameFromServices(undefined)).toBeNull();
  });

  it('resolves through Blocksync and returns null for unknown DIDs', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const vars = JSON.parse(String(init?.body)).variables as { id: string };
        const nodes =
          vars.id === 'did:ixo:known'
            ? [
                {
                  id: vars.id,
                  service: [
                    {
                      type: 'MatrixHomeServer',
                      serviceEndpoint: 'https://devmx.ixo.earth',
                    },
                  ],
                },
              ]
            : [];
        return new Response(JSON.stringify({ data: { iids: { nodes } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    await expect(
      fetchUserMatrixServerName(
        'https://bs/graphql',
        'did:ixo:known',
        fetchImpl,
      ),
    ).resolves.toBe('devmx.ixo.earth');
    await expect(
      fetchUserMatrixServerName(
        'https://bs/graphql',
        'did:ixo:unknown',
        fetchImpl,
      ),
    ).resolves.toBeNull();
  });

  it('throws on transport failure so callers can fall back deliberately', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));
    await expect(
      fetchUserMatrixServerName('https://bs/graphql', 'did:ixo:x', fetchImpl),
    ).rejects.toThrow(/502/);
  });
});

describe('lookupUserServerName (cached sender-server lookup)', () => {
  const DID = 'did:ixo:ixo1user';
  const TTL = 6 * 60 * 60_000;
  const NOW = 1_800_000_000_000;
  const blocksyncDown = vi.fn(
    async () => new Response('unavailable', { status: 503 }),
  );
  const registersDevmx = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            iids: {
              nodes: [
                {
                  id: DID,
                  service: [
                    {
                      type: 'MatrixHomeServer',
                      serviceEndpoint: 'https://devmx.ixo.earth',
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
  );

  /** Blocksync knows the DID, and its document names no MatrixHomeServer. */
  const namesNoServer = (did: string) => async () =>
    new Response(
      JSON.stringify({
        data: { iids: { nodes: [{ id: did, service: [] }] } },
      }),
    );

  function deps(
    cache: Map<string, CachedUserServerName>,
    fetchImpl: typeof fetch,
  ) {
    return {
      blocksyncGraphqlUrl: 'https://bs/graphql',
      defaultServerName: 'oracle.example',
      ttlMs: TTL,
      now: () => NOW,
      readCache: async (did: string) => cache.get(did),
      writeCache: async (did: string, entry: CachedUserServerName) => {
        cache.set(did, entry);
      },
      fetchImpl,
    };
  }

  it("Blocksync down with nothing cached: no answer at all, never the oracle's own server", async () => {
    const cache = new Map<string, CachedUserServerName>();
    await expect(
      lookupUserServerName(DID, deps(cache, blocksyncDown)),
    ).rejects.toBeInstanceOf(UserServerNameUnavailableError);
    expect(cache.size).toBe(0);
  });

  it('Blocksync down with an expired cache entry: the stale server is used, and the entry is left as it was', async () => {
    const stale = { serverName: 'devmx.ixo.earth', at: NOW - TTL - 1 };
    const cache = new Map([[DID, stale]]);
    const lookup = await lookupUserServerName(DID, deps(cache, blocksyncDown));
    expect(lookup).toMatchObject({
      serverName: 'devmx.ixo.earth',
      source: 'stale',
    });
    expect(lookup.error).toBeInstanceOf(Error);
    expect(cache.get(DID)).toEqual(stale);
  });

  it('serves a fresh entry without asking Blocksync, refreshes an expired one, and defaults only for a DID that names no server', async () => {
    const fetchImpl = vi.fn(registersDevmx);
    const cache = new Map([
      [DID, { serverName: 'cached.example', at: NOW - 1_000 }],
    ]);
    await expect(
      lookupUserServerName(DID, deps(cache, fetchImpl)),
    ).resolves.toEqual({ serverName: 'cached.example', source: 'cache' });
    expect(fetchImpl).not.toHaveBeenCalled();

    cache.set(DID, { serverName: 'cached.example', at: NOW - TTL });
    await expect(
      lookupUserServerName(DID, deps(cache, fetchImpl)),
    ).resolves.toEqual({ serverName: 'devmx.ixo.earth', source: 'blocksync' });
    expect(cache.get(DID)).toEqual({ serverName: 'devmx.ixo.earth', at: NOW });

    const unregistered = vi.fn(namesNoServer('did:ixo:other'));
    await expect(
      lookupUserServerName('did:ixo:other', deps(cache, unregistered)),
    ).resolves.toEqual({
      serverName: 'oracle.example',
      source: 'unregistered',
    });
    // "No homeserver" is an answer, cached for the short negative TTL.
    expect(cache.get('did:ixo:other')).toEqual({
      serverName: 'oracle.example',
      at: NOW,
      unregistered: true,
    });
    await expect(
      lookupUserServerName('did:ixo:other', deps(cache, unregistered)),
    ).resolves.toEqual({
      serverName: 'oracle.example',
      source: 'unregistered',
    });
    expect(unregistered).toHaveBeenCalledTimes(1);
  });

  it('asks again once the negative TTL has passed, and takes the homeserver the DID registered since', async () => {
    let now = NOW;
    let registered = false;
    const fetchImpl = vi.fn(async () =>
      registered ? registersDevmx() : namesNoServer(DID)(),
    );
    const cache = new Map<string, CachedUserServerName>();
    const lookup = () =>
      lookupUserServerName(DID, { ...deps(cache, fetchImpl), now: () => now });
    expect((await lookup()).source).toBe('unregistered');
    registered = true;
    now += UNREGISTERED_CACHE_TTL_MS - 1;
    expect((await lookup()).source).toBe('unregistered');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(lookup()).resolves.toEqual({
      serverName: 'devmx.ixo.earth',
      source: 'blocksync',
    });
    expect(UNREGISTERED_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it('caches nothing for a DID Blocksync has no record of yet', async () => {
    const notIndexed = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { iids: { nodes: [] } } })),
    );
    const cache = new Map<string, CachedUserServerName>();
    await expect(
      lookupUserServerName(DID, deps(cache, notIndexed)),
    ).resolves.toEqual({
      serverName: 'oracle.example',
      source: 'unregistered',
    });
    expect(cache.size).toBe(0);
    await lookupUserServerName(DID, deps(cache, notIndexed));
    expect(notIndexed).toHaveBeenCalledTimes(2);
  });

  it('an expired "unregistered" entry stands in for a failed refresh with the default, not a stale server', async () => {
    const cache = new Map<string, CachedUserServerName>([
      [
        DID,
        {
          serverName: 'old-default.example',
          at: NOW - TTL - 1,
          unregistered: true,
        },
      ],
    ]);
    await expect(
      lookupUserServerName(DID, deps(cache, blocksyncDown)),
    ).resolves.toMatchObject({ serverName: 'oracle.example', source: 'stale' });
  });

  it('a Blocksync that never answers is cut off: by the default bound, or sooner by the caller', async () => {
    const hangs: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        // Like fetch: an aborted signal rejects at once or when it aborts.
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    const cache = new Map<string, CachedUserServerName>();
    const caller = new AbortController();
    const pending = lookupUserServerName(DID, {
      ...deps(cache, hangs),
      signal: caller.signal,
    });
    caller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toBeInstanceOf(
      UserServerNameUnavailableError,
    );
    // Without a caller signal the request carries the default bound.
    let seen: AbortSignal | undefined;
    await fetchUserMatrixServerName(
      'https://bs/graphql',
      DID,
      async (_i, init) => {
        seen = init?.signal ?? undefined;
        return Response.json({ data: { iids: { nodes: [] } } });
      },
    );
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
    expect(BLOCKSYNC_LOOKUP_TIMEOUT_MS).toBe(5_000);
  });
});
