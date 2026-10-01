import { describe, expect, it, vi } from 'vitest';
import {
  extractUrlDomain,
  fetchUserMatrixServerName,
  matrixServerNameFromServices,
  normalizeMatrixHomeServerUrl,
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
