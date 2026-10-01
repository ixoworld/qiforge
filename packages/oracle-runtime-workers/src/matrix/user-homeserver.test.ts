import { describe, expect, it, vi } from 'vitest';
import {
  type CachedUserServerName,
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

    const unregistered = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { iids: { nodes: [] } } }), {
          status: 200,
        }),
    );
    await expect(
      lookupUserServerName('did:ixo:other', deps(cache, unregistered)),
    ).resolves.toEqual({
      serverName: 'oracle.example',
      source: 'unregistered',
    });
    expect(cache.has('did:ixo:other')).toBe(false);
  });
});
