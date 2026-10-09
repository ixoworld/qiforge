import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../plugin-api/types';
import { makeRuntimeContext } from '../test-fixtures';
import { domainFixture } from './fixtures/domain';
import { FIXTURE_DID as did } from './fixtures/setup';
import { cidOf } from './integrity';
import { DomainContextResolver } from './resolver';
import { boundedBytes, createDomainTransport } from './transport';
import type { DocumentRequest, DomainContextOptions } from './types';

const BLOCKSYNC = 'https://iid.example/graphql';
type ReaderFn = NonNullable<DomainContextOptions['readPrivateDocument']>;
const fixtureBytes = new TextEncoder().encode(domainFixture);

function context(
  config: Record<string, unknown> = {},
  extra: Partial<RuntimeContext> = {},
): RuntimeContext {
  return makeRuntimeContext({
    config: { BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC, ...config },
    ...extra,
  });
}

function request(uri: string, overrides: Partial<DocumentRequest> = {}) {
  return {
    did,
    uri,
    cid: 'unused',
    private: false,
    maxBytes: 100,
    ...overrides,
  };
}

function iidResponse(linkedResource: unknown, id = did) {
  return Response.json({
    data: { iids: { nodes: [{ id, linkedResource }] } },
  });
}

/** Stubs `fetch`; returns the mock so a test can read the calls. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boundedBytes', () => {
  it('rejects a declared size above the bound before reading', async () => {
    const response = new Response('oversized', {
      headers: { 'content-length': '9' },
    });
    await expect(boundedBytes(response, 3)).rejects.toThrow(
      'document-too-large',
    );
  });

  it('stops a streamed body that grows past the bound', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64));
      },
    });
    await expect(boundedBytes(new Response(stream), 200)).rejects.toThrow(
      'document-too-large',
    );
  });

  it('refuses a non-2xx response', async () => {
    await expect(
      boundedBytes(new Response('no', { status: 404 }), 10),
    ).rejects.toThrow('document-unavailable');
  });
});

describe('createDomainTransport: origin policy', () => {
  const options: DomainContextOptions = {
    mode: 'observe',
    allowedOrigins: ['https://docs.example'],
  };

  it.each([
    ['an unlisted host', 'https://evil.example/x', 'document-origin-denied'],
    ['plain http', 'http://docs.example/x', 'document-origin-denied'],
    [
      'URL credentials',
      'https://user:pass@docs.example/x',
      'document-origin-denied',
    ],
    [
      'a look-alike host',
      'https://docs.example.evil.example/x',
      'document-origin-denied',
    ],
    ['another port', 'https://docs.example:8443/x', 'document-origin-denied'],
    ['a non-URL', 'not a url', 'unsupported-document-uri'],
    ['ipfs without a gateway', 'ipfs://bafy/x', 'ipfs-gateway-unconfigured'],
  ])('denies %s before fetching', async (_label, uri, code) => {
    const fetcher = stubFetch(() => new Response('x'));
    const transport = createDomainTransport(options, context());
    await expect(transport.read(request(uri))).rejects.toThrow(code);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches an allowlisted https document without following redirects', async () => {
    const fetcher = stubFetch(() => new Response('hello'));
    const transport = createDomainTransport(options, context());
    const bytes = await transport.read(request('https://docs.example/x'));
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('maps ipfs:// to the configured gateway and refuses path tricks', async () => {
    const fetcher = stubFetch(() => new Response('ipfs'));
    const transport = createDomainTransport(
      { mode: 'observe', ipfsGateway: 'https://gateway.example/' },
      context(),
    );
    const cid = await cidOf(fixtureBytes);
    await transport.read(request(`ipfs://${cid}/doc.md`));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `https://gateway.example/ipfs/${cid}/doc.md`,
    );
    for (const uri of [
      'ipfs://',
      `ipfs://${cid}/../${cid}`,
      `ipfs://${cid}?x`,
      `ipfs://${cid}#x`,
      // Not a CID first.
      'ipfs://bafycid/doc.md',
      'ipfs:///doc.md',
      // Dot segments, plain and percent-encoded (the URL parser resolves
      // them, which would leave /ipfs/ for another path on the gateway).
      'ipfs://%2e%2e/%2e%2e/admin',
      'ipfs://.%2e/admin',
      'ipfs://%2E%2E/admin',
      `ipfs://${cid}/%2e%2e/%2e%2e/admin`,
      `ipfs://${cid}/.%2E/x`,
      `ipfs://${cid}/./x`,
      `ipfs://${cid}\\..\\..\\admin`,
    ])
      await expect(transport.read(request(uri))).rejects.toThrow(
        /invalid-ipfs-uri/,
      );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps ipfs:// under the /ipfs/ path of a gateway that has a path prefix', async () => {
    const fetcher = stubFetch(() => new Response('ipfs'));
    const transport = createDomainTransport(
      { mode: 'observe', ipfsGateway: 'https://gateway.example/prefix/' },
      context(),
    );
    const cid = await cidOf(fixtureBytes);
    await transport.read(request(`ipfs://${cid}`));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `https://gateway.example/prefix/ipfs/${cid}`,
    );
    await expect(
      transport.read(request('ipfs://%2e%2e/%2e%2e/%2e%2e/admin')),
    ).rejects.toThrow('invalid-ipfs-uri');
  });

  it('bounds the body by the request', async () => {
    stubFetch(() => new Response('0123456789'));
    const transport = createDomainTransport(options, context());
    await expect(
      transport.read(request('https://docs.example/x', { maxBytes: 4 })),
    ).rejects.toThrow('document-too-large');
  });
});

describe('createDomainTransport: private reads', () => {
  it('refuses a private non-VFS document without a host reader', async () => {
    const fetcher = stubFetch(() => new Response('x'));
    const transport = createDomainTransport(
      { mode: 'observe', allowedOrigins: ['https://docs.example'] },
      context(),
    );
    await expect(
      transport.read(
        request('https://docs.example/private', { private: true }),
      ),
    ).rejects.toThrow('private-reader-unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls the host reader on every private read and bounds its result', async () => {
    const ctx = context();
    const reader = vi.fn<ReaderFn>(async () => fixtureBytes);
    const transport = createDomainTransport(
      { mode: 'observe', readPrivateDocument: reader },
      ctx,
    );
    const resolver = new DomainContextResolver();
    const privateRequest = {
      did,
      uri: 'https://private.example/domain.md',
      cid: await cidOf(fixtureBytes),
      private: true,
      maxBytes: 1024 * 1024,
    };
    await resolver.bytes(privateRequest, transport);
    await resolver.bytes(privateRequest, transport);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader.mock.calls[0]?.[1]).toBe(ctx);
    reader.mockRejectedValueOnce(new Error('revoked'));
    await expect(resolver.bytes(privateRequest, transport)).rejects.toThrow(
      'revoked',
    );
    await expect(
      transport.read({ ...privateRequest, maxBytes: 10 }),
    ).rejects.toThrow('document-too-large');
  });

  function vfsContext(bearer: 'ok' | 'no-delegation') {
    const base = makeRuntimeContext();
    const getServiceDelegation = vi.fn<
      RuntimeContext['ucan']['getServiceDelegation']
    >(async () =>
      bearer === 'ok'
        ? { token: 'delegation-car', with: 'ixo:filesystem:user' }
        : { error: 'no-delegation' },
    );
    const createInvocationFromDelegation = vi.fn<
      RuntimeContext['ucan']['createInvocationFromDelegation']
    >(async () => ({
      invocation: 'vfs-invocation',
    }));
    const ctx = context(
      {
        VFS_BASE_URL: 'https://vfs.example',
        UCAN_STORE_URL: 'https://store.example',
      },
      {
        ucan: {
          ...base.ucan,
          getServiceDelegation,
          createInvocationFromDelegation,
        },
      },
    );
    return { ctx, getServiceDelegation, createInvocationFromDelegation };
  }

  it('reads a private VFS file with a fresh fs/read UCAN bearer', async () => {
    const fetcher = stubFetch(() => new Response('secret'));
    const { ctx, getServiceDelegation, createInvocationFromDelegation } =
      vfsContext('ok');
    const transport = createDomainTransport({ mode: 'observe' }, ctx);
    const uri = 'https://vfs.example/api/fs/files/file-1/content';
    expect(transport.isPublic?.(request(uri))).toBe(false);
    await transport.read(request(uri, { private: true }));
    await transport.read(request(uri, { private: true }));
    expect(getServiceDelegation).toHaveBeenCalledTimes(2);
    expect(getServiceDelegation.mock.calls[0]?.[1]).toMatchObject({
      storeUrl: 'https://store.example/',
      resource: 'ixo:filesystem',
      requiredAbility: 'fs/read',
    });
    expect(createInvocationFromDelegation.mock.calls[0]?.[2]).toMatchObject({
      can: 'fs/read',
    });
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer vfs-invocation');
  });

  it('denies a VFS read the user has not delegated', async () => {
    const fetcher = stubFetch(() => new Response('secret'));
    const { ctx } = vfsContext('no-delegation');
    const transport = createDomainTransport({ mode: 'observe' }, ctx);
    await expect(
      transport.read(
        request('https://vfs.example/api/fs/files/file-1/content', {
          private: true,
        }),
      ),
    ).rejects.toThrow('document-access-denied');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads public Matrix media through the authenticated client endpoint', async () => {
    const fetcher = stubFetch(() => new Response('media'));
    const base = makeRuntimeContext();
    const botCredentials = vi.fn(async () => ({
      baseUrl: 'https://matrix.example',
      userId: '@oracle:matrix.example',
      accessToken: 'bot-token',
      deviceId: 'DEVICE',
    }));
    const ctx = context(
      { MATRIX_BASE_URL: 'https://matrix.example' },
      { matrix: { ...base.matrix, botCredentials } },
    );
    const transport = createDomainTransport({ mode: 'observe' }, ctx);
    await transport.read(
      request(
        'https://matrix.example/_matrix/media/v3/download/matrix.example/abc',
      ),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://matrix.example/_matrix/client/v1/media/download/matrix.example/abc',
    );
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer bot-token');
  });
});

describe('createDomainTransport: IID anchor lookup', () => {
  it('resolves the {id}#dom shorthand without trusting other resources', async () => {
    const cid = await cidOf(fixtureBytes);
    const fetcher = stubFetch((url, init) => {
      expect(url).toBe(BLOCKSYNC);
      expect(init?.redirect).toBe('error');
      return iidResponse([
        {
          id: '{id}#other',
          proof: 'x',
          serviceEndpoint: 'https://evil.example',
        },
        {
          id: '{id}#dom',
          proof: cid,
          serviceEndpoint: 'https://docs.example/domain.md',
          encrypted: 'false',
        },
      ]);
    });
    const transport = createDomainTransport({ mode: 'observe' }, context());
    expect(await transport.resolve(did)).toMatchObject({
      did,
      cid,
      uri: 'https://docs.example/domain.md',
      private: false,
      source: BLOCKSYNC,
    });
    const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ variables: { id: did } });
  });

  it('resolves the full <did>#dom form and reads encrypted as private', async () => {
    const cid = await cidOf(fixtureBytes);
    stubFetch(() =>
      iidResponse([
        {
          id: `${did}#dom`,
          proof: cid,
          serviceEndpoint: 'https://docs.example/domain.md',
          encrypted: 'true',
        },
      ]),
    );
    const transport = createDomainTransport({ mode: 'observe' }, context());
    expect((await transport.resolve(did))?.private).toBe(true);
  });

  it('returns null when the IID has no domain anchor', async () => {
    stubFetch(() => iidResponse([]));
    const transport = createDomainTransport({ mode: 'observe' }, context());
    expect(await transport.resolve(did)).toBeNull();
  });

  it('rejects ambiguous anchors instead of choosing one', async () => {
    const resource = {
      proof: await cidOf(fixtureBytes),
      serviceEndpoint: 'https://docs.example',
    };
    stubFetch(() =>
      iidResponse([
        { ...resource, id: '{id}#dom' },
        { ...resource, id: `${did}#dom` },
      ]),
    );
    const transport = createDomainTransport({ mode: 'observe' }, context());
    await expect(transport.resolve(did)).rejects.toThrow(
      'invalid-anchor-ambiguous',
    );
    expect(
      (await new DomainContextResolver().load(did, transport)).status,
    ).toBe('invalid');
  });

  it('rejects a domain anchor without a proof', async () => {
    stubFetch(() =>
      iidResponse([
        { id: '{id}#dom', serviceEndpoint: 'https://docs.example' },
      ]),
    );
    const transport = createDomainTransport({ mode: 'observe' }, context());
    await expect(transport.resolve(did)).rejects.toThrow(
      'invalid-anchor-resources',
    );
  });

  it.each([
    ['an oversized proof', () => `bafk${'a'.repeat(200_000)}`],
    ['a CID one character over the bound', () => `b${'a'.repeat(128)}`],
    ['a proof that is not a CID', () => 'not-a-cid'],
  ])(
    'rejects %s and never hands it on to provenance',
    async (_label, proof) => {
      stubFetch((url) =>
        url === BLOCKSYNC
          ? iidResponse([
              {
                id: '{id}#dom',
                proof: proof(),
                serviceEndpoint: 'https://docs.example/domain.md',
              },
            ])
          : new Response(fixtureBytes),
      );
      const transport = createDomainTransport(
        { mode: 'observe', allowedOrigins: ['https://docs.example'] },
        context(),
      );
      await expect(transport.resolve(did)).rejects.toThrow(
        'invalid-anchor-resources',
      );
      const snapshot = await new DomainContextResolver().load(did, transport);
      expect(snapshot).toEqual({
        did,
        status: 'invalid',
        stale: false,
        findings: ['invalid-anchor-resources'],
      });
    },
  );

  it('rejects an oversized service endpoint', async () => {
    stubFetch(() =>
      iidResponse([
        {
          id: '{id}#dom',
          proof: 'bafkreigweoca5xyrjtop3vneqaziqdaufcnqhgjxmwrq2gksqzjcqfvwli',
          serviceEndpoint: `https://docs.example/${'x'.repeat(4096)}`,
        },
      ]),
    );
    const transport = createDomainTransport({ mode: 'observe' }, context());
    await expect(transport.resolve(did)).rejects.toThrow(
      'invalid-anchor-resources',
    );
  });

  it.each([
    [
      'GraphQL errors',
      () => Response.json({ data: { iids: { nodes: [] } }, errors: [{}] }),
    ],
    ['an unknown IID', () => Response.json({ data: { iids: { nodes: [] } } })],
    ['another IID', () => iidResponse([], 'did:ixo:entity:other')],
    ['a malformed body', () => Response.json({ nope: true })],
  ])('treats %s as unavailable', async (_label, respond) => {
    stubFetch(respond);
    const transport = createDomainTransport({ mode: 'observe' }, context());
    await expect(transport.resolve(did)).rejects.toThrow('iid-unavailable');
  });

  it('resolves and verifies end to end through fetch', async () => {
    const cid = await cidOf(fixtureBytes);
    const fetcher = stubFetch((url) =>
      url === BLOCKSYNC
        ? iidResponse([
            {
              id: '{id}#dom',
              proof: cid,
              serviceEndpoint: 'https://docs.example/domain.md',
              encrypted: 'false',
            },
          ])
        : new Response(fixtureBytes),
    );
    const transport = createDomainTransport(
      { mode: 'observe', allowedOrigins: ['https://docs.example'] },
      context(),
    );
    expect(
      (await new DomainContextResolver().load(did, transport)).status,
    ).toBe('verified');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
