import {
  parseDomain,
  oracleCapsuleReleaseDigest,
} from '@ixo/domain.md/workers';
import { capsuleFixture } from './fixtures/capsule';
import { describe, expect, it, vi } from 'vitest';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { DomainContextResolver } from './resolver';
import { domainFixture } from './fixtures/domain';
import type { DomainAnchor, DomainTransport } from './types';
import { boundedBytes, createDomainTransport } from './transport';
import { prepareDomainContext } from './turn-context';
import { makeRuntimeContext } from '../test-fixtures';

const did = 'did:ixo:entity:fixture';
async function setup(text = domainFixture) {
  const bytes = new TextEncoder().encode(text);
  const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString();
  const anchor: DomainAnchor = {
    did,
    cid,
    uri: 'https://docs.example/domain.md',
    private: false,
    resolvedAt: 0,
    source: 'https://iid.example',
  };
  const transport = {
    resolve: vi.fn(async (): Promise<DomainAnchor | null> => anchor),
    read: vi.fn(async () => bytes),
  } satisfies DomainTransport;
  return { anchor, transport, bytes };
}
describe('verified domain snapshots', () => {
  it('validates the shared schema and reuses anchors until TTL expiry', async () => {
    let now = 0;
    const resolver = new DomainContextResolver(() => now);
    const { transport } = await setup();
    expect((await resolver.load(did, transport)).status).toBe('verified');
    await resolver.load(did, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(1);
    now = 300001;
    await resolver.load(did, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(2);
    expect(transport.read).toHaveBeenCalledTimes(1);
  });
  it('deduplicates concurrent anchor resolution', async () => {
    const resolver = new DomainContextResolver();
    const { transport } = await setup();
    await Promise.all([
      resolver.load(did, transport),
      resolver.load(did, transport),
    ]);
    expect(transport.resolve).toHaveBeenCalledTimes(1);
  });
  it('labels stale fallback but never falls back after a confirmed removal', async () => {
    let now = 0;
    const resolver = new DomainContextResolver(() => now);
    const { transport } = await setup();
    await resolver.load(did, transport);
    now = 300001;
    transport.resolve.mockRejectedValueOnce(new Error('offline'));
    const stale = await resolver.load(did, transport);
    expect(stale.status).toBe('verified');
    expect(stale.stale).toBe(true);
    transport.resolve.mockResolvedValueOnce(null);
    expect((await resolver.load(did, transport)).status).toBe('missing');
  });
  it('does not inject mismatched or malformed content', async () => {
    const resolver = new DomainContextResolver();
    const { transport } = await setup();
    transport.read.mockResolvedValue(new TextEncoder().encode('tampered'));
    const result = await resolver.load(did, transport);
    expect(result.status).toBe('invalid');
    expect(result.document).toBeUndefined();
  });
  it('rejects a document for the wrong domain even when its CID verifies', async () => {
    const { transport } = await setup();
    const result = await new DomainContextResolver().load(
      'did:ixo:entity:other',
      transport,
    );
    expect(result.status).toBe('invalid');
    expect(result.document).toBeUndefined();
  });
  it('rechecks private reads rather than sharing a content cache', async () => {
    const resolver = new DomainContextResolver();
    const { anchor, transport } = await setup();
    anchor.private = true;
    await resolver.load(did, transport);
    await resolver.load(did, transport);
    expect(transport.read).toHaveBeenCalledTimes(2);
  });
  it('refreshes on explicit invalidation and keeps the old turn snapshot stable', async () => {
    const resolver = new DomainContextResolver();
    const { transport } = await setup();
    const first = await resolver.load(did, transport);
    resolver.invalidate(did);
    const next = await setup(
      domainFixture.replace('Climate Dataset', 'New Dataset'),
    );
    transport.resolve.mockResolvedValue(next.anchor);
    transport.read.mockResolvedValue(next.bytes);
    await resolver.load(did, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(2);
    expect(first.document?.raw).toBe(domainFixture);
  });
  it('caps document responses before allocating an unbounded body', async () => {
    await expect(boundedBytes(new Response('oversized'), 3)).rejects.toThrow(
      'document-too-large',
    );
  });
  it('denies arbitrary URLs and unsupported private reads before fetching', async () => {
    const ctx = makeRuntimeContext();
    const transport = createDomainTransport(
      { mode: 'observe', allowedOrigins: ['https://docs.example'] },
      ctx,
    );
    await expect(
      transport.read({
        did,
        uri: 'https://evil.example/x',
        cid: 'unused',
        private: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow('document-origin-denied');
    await expect(
      transport.read({
        did,
        uri: 'https://docs.example/private',
        cid: 'unused',
        private: true,
        maxBytes: 100,
      }),
    ).rejects.toThrow('private-reader-unavailable');
  });
  it('does not resolve subjects from a missing or cleared binding', async () => {
    const resolver = new DomainContextResolver();
    const load = vi.spyOn(resolver, 'load').mockResolvedValue({
      did,
      status: 'missing',
      stale: false,
      findings: [],
    });
    const ctx = makeRuntimeContext();
    const result = await prepareDomainContext({
      options: { mode: 'observe' },
      resolver,
      ctx,
      oracleDid: did,
      subjectDid: null,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.prompt).toContain('oracle-constitution');
    expect(result.prompt).not.toContain('"role":"subject-domain"');
  });
});

it('inspects a capsule without activating its Master skill or tools', async () => {
  const manifest = structuredClone(capsuleFixture);
  manifest.domains.oracle.id = did;
  manifest.metadata.release_digest = oracleCapsuleReleaseDigest(manifest);
  const manifestText = JSON.stringify(manifest);
  const manifestBytes = new TextEncoder().encode(manifestText);
  const digest = await sha256.digest(manifestBytes);
  const manifestCid = CID.createV1(0x55, digest).toString();
  const hex = [...digest.digest]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const document = parseDomain(domainFixture).document;
  if (!document) throw new Error('Fixture invalid');
  document.frontmatter['x-oracle-capsule'] = {
    contract: 'ixo.earth/oracle-capsule/v0alpha1',
    manifest: {
      uri: 'https://docs.example/capsule',
      cid: manifestCid,
      sha256: hex,
      version: manifest.metadata.release,
      schema: manifest.schema,
      media_type: 'application/vnd.ixo.oracle-capsule+json',
    },
  };
  const source = `---\n${JSON.stringify(document.frontmatter)}\n---\n${document.sections.map((s) => s.content).join('\n')}`;
  const { transport, bytes } = await setup(source);
  transport.read.mockImplementation(async (request?: { uri: string }) =>
    request?.uri.endsWith('/capsule') ? manifestBytes : bytes,
  );
  const snapshot = await new DomainContextResolver().load(did, transport);
  expect(snapshot.status).toBe('verified');
  expect(snapshot.capsule?.status).toBe('inspected-not-activated');
  expect(snapshot.capsule?.externalChecksRequired?.length).toBeGreaterThan(0);
  expect(transport.read).toHaveBeenCalledTimes(2);
});

it('cancels one subscriber without cancelling the shared anchor lookup', async () => {
  const resolver = new DomainContextResolver();
  const { transport, anchor } = await setup();
  let finish!: (value: DomainAnchor) => void;
  transport.resolve.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const cancelled = resolver.load(did, transport, 300000, controller.signal);
  const other = resolver.load(did, transport);
  controller.abort(new Error('cancelled'));
  await expect(cancelled).rejects.toThrow('cancelled');
  finish(anchor);
  expect((await other).status).toBe('verified');
  expect(transport.resolve).toHaveBeenCalledTimes(1);
});

it('loads Pass-1 linked context through the same read boundary and preserves permissions', async () => {
  const { transport } = await setup();
  const resolver = new DomainContextResolver();
  const snapshot = await resolver.load(did, transport);
  const documents = snapshot.document?.frontmatter.documents;
  if (
    !documents ||
    typeof documents !== 'object' ||
    !('entries' in documents) ||
    !Array.isArray(documents.entries)
  )
    throw new Error('fixture');
  for (const entry of documents.entries)
    if (entry && typeof entry === 'object' && 'disclosure_pass' in entry)
      Object.assign(entry, {
        disclosure_pass: 1,
        freshness: { last_verified: null, max_age: null },
      });
  vi.spyOn(resolver, 'load').mockResolvedValue(snapshot);
  const read = vi
    .spyOn(resolver, 'bytes')
    .mockResolvedValue(
      new TextEncoder().encode('Constitutional operating guidance'),
    );
  const result = await prepareDomainContext({
    options: { mode: 'observe' },
    resolver,
    ctx: makeRuntimeContext(),
    oracleDid: did,
  });
  expect(read).toHaveBeenCalled();
  expect(result.prompt).toContain('Constitutional operating guidance');
  expect(result.prompt).toContain('permissions');
  expect(snapshot.documentsRead?.length).toBeGreaterThan(0);
});

it('resolves an IID shorthand anchor without trusting unrelated resources', async () => {
  const { anchor, bytes } = await setup();
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    String(input) === 'https://iid.example'
      ? Response.json({
          data: {
            iids: {
              nodes: [
                {
                  id: did,
                  linkedResource: [
                    { id: '{id}#other' },
                    {
                      id: '{id}#dom',
                      proof: anchor.cid,
                      serviceEndpoint: anchor.uri,
                      encrypted: 'false',
                    },
                  ],
                },
              ],
            },
          },
        })
      : new Response(bytes),
  );
  vi.stubGlobal('fetch', fetcher);
  try {
    const ctx = makeRuntimeContext({
      config: { BLOCKSYNC_GRAPHQL_URL: 'https://iid.example' },
    });
    const transport = createDomainTransport(
      { mode: 'observe', allowedOrigins: ['https://docs.example'] },
      ctx,
    );
    expect(
      (await new DomainContextResolver().load(did, transport)).status,
    ).toBe('verified');
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('rejects ambiguous IID anchors instead of choosing a more permissive one', async () => {
  const { anchor } = await setup();
  const resource = { proof: anchor.cid, serviceEndpoint: anchor.uri };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        data: {
          iids: {
            nodes: [
              {
                id: did,
                linkedResource: [
                  { ...resource, id: '{id}#dom' },
                  { ...resource, id: `${did}#dom` },
                ],
              },
            ],
          },
        },
      }),
    ),
  );
  try {
    const ctx = makeRuntimeContext({
      config: { BLOCKSYNC_GRAPHQL_URL: 'https://iid.example' },
    });
    const transport = createDomainTransport({ mode: 'observe' }, ctx);
    expect(
      (await new DomainContextResolver().load(did, transport)).status,
    ).toBe('invalid');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('uses the current authorized private adapter on every private read', async () => {
  const { anchor, bytes } = await setup();
  const reader = vi.fn(async () => bytes);
  const transport = createDomainTransport(
    { mode: 'observe', readPrivateDocument: reader },
    makeRuntimeContext(),
  );
  const resolver = new DomainContextResolver();
  const request = { ...anchor, private: true, maxBytes: 1024 * 1024 };
  await resolver.bytes(request, transport);
  await resolver.bytes(request, transport);
  expect(reader).toHaveBeenCalledTimes(2);
  reader.mockRejectedValueOnce(new Error('revoked'));
  await expect(resolver.bytes(request, transport)).rejects.toThrow('revoked');
});

it('does not cache an authenticated transport merely because the anchor says unencrypted', async () => {
  const { anchor, transport } = await setup();
  const authenticated: DomainTransport = {
    ...transport,
    isPublic: () => false,
  };
  const resolver = new DomainContextResolver();
  await resolver.bytes({ ...anchor, maxBytes: 1024 * 1024 }, authenticated);
  transport.read.mockRejectedValueOnce(new Error('access-revoked'));
  await expect(
    resolver.bytes({ ...anchor, maxBytes: 1024 * 1024 }, authenticated),
  ).rejects.toThrow('access-revoked');
});
