import {
  oracleCapsuleReleaseDigest,
  parseDomain,
} from '@ixo/domain.md/workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capsuleFixture } from './fixtures/capsule';
import { domainFixture } from './fixtures/domain';
import {
  anchorOf,
  FIXTURE_DID as did,
  domainFor,
  hostileIndex,
  servedDomains,
  withFrontmatter,
} from './fixtures/setup';
import { record } from './document';
import { boundFindings, FINDINGS_TRUNCATED, MAX_FINDINGS } from './findings';
import { cidOf } from './integrity';
import { LruMap } from './lru';
import {
  DomainContextResolver,
  MAX_FRONTMATTER_BYTES,
  MAX_FRONTMATTER_ARRAY_ITEMS,
  MAX_FRONTMATTER_DEPTH,
  exceedsFrontmatterShape,
  PARSED_CACHE_CHARS,
  PINNED_ANCHOR_SOURCE,
} from './resolver';
import type { DomainAnchor, DomainTransport } from './types';
import { domainValidator } from './validator';

async function setup(text = domainFixture) {
  const served = await servedDomains({ [did]: text });
  return { ...served, anchor: anchorOf(served.anchors, did) };
}

/** A promise with its resolve/reject handles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DomainContextResolver: verification', () => {
  it('verifies the fixture against the shared domain.md schema', async () => {
    const { transport, anchor } = await setup();
    const snapshot = await new DomainContextResolver().load(did, transport);
    expect(snapshot.status).toBe('verified');
    expect(snapshot.anchor).toEqual(anchor);
    expect(snapshot.document?.raw).toBe(domainFixture);
    // The resolver verified the CID itself; what it cannot check stays listed.
    expect(snapshot.findings).not.toContain('unresolved:cid-verification');
    expect(snapshot.findings).toContain('unresolved:did-iid-resolution');
    expect(snapshot.findings).toContain('unresolved:capability-revocation');
  });

  it('does not inject mismatched or malformed content', async () => {
    const { transport } = await setup();
    transport.read.mockResolvedValue(new TextEncoder().encode('tampered'));
    const result = await new DomainContextResolver().load(did, transport);
    expect(result.status).toBe('invalid');
    expect(result.findings).toContain('cid-mismatch');
    expect(result.document).toBeUndefined();
  });

  it('rejects a UTF-8 byte-order mark even when the CID names those bytes', async () => {
    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(domainFixture),
    ]);
    const { transport, anchors } = await setup();
    anchors.set(did, { ...anchorOf(anchors, did), cid: await cidOf(bom) });
    transport.read.mockResolvedValue(bom);
    const result = await new DomainContextResolver().load(did, transport);
    expect(result.status).toBe('invalid');
    expect(result.findings).toContain('utf8-bom');
  });

  it('refuses a CID that is not CIDv1 raw sha2-256', async () => {
    const { transport, anchors } = await setup();
    anchors.set(did, {
      ...anchorOf(anchors, did),
      // CIDv0 (dag-pb) of the empty string.
      cid: 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
    });
    const result = await new DomainContextResolver().load(did, transport);
    expect(result.status).toBe('invalid');
    expect(result.findings).toContain('unsupported-cid-codec');
  });

  it('rejects a document for the wrong domain even when its CID verifies', async () => {
    const { transport, anchor } = await setup();
    transport.resolve.mockResolvedValue({
      ...anchor,
      did: 'did:ixo:entity:other',
    });
    const result = await new DomainContextResolver().load(
      'did:ixo:entity:other',
      transport,
    );
    expect(result.status).toBe('invalid');
    expect(result.findings).toContain('domain-identity-mismatch');
    expect(result.document).toBeUndefined();
  });

  it('rejects an index that is not on an anchored or runtime profile', async () => {
    const text = withFrontmatter((front) => {
      Object.assign(front, {
        conformance: {
          spec_version: '1.0.0-rc.3',
          schema: 'urn:ixo:domain-md:schema:1.0.0-rc.3',
          profile: 'persisted_draft',
        },
      });
    });
    const { transport } = await setup(text);
    const result = await new DomainContextResolver().load(did, transport);
    expect(result.status).not.toBe('verified');
    expect(result.document).toBeUndefined();
  });

  it('refuses a malformed DID before any lookup', async () => {
    const { transport } = await setup();
    const result = await new DomainContextResolver().load(
      'did:web:example.com',
      transport,
    );
    expect(result).toMatchObject({
      status: 'invalid',
      findings: ['invalid-anchor-did'],
    });
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it('reports a missing anchor as missing', async () => {
    const { transport } = await setup();
    transport.resolve.mockResolvedValue(null);
    expect(await new DomainContextResolver().load(did, transport)).toEqual({
      did,
      status: 'missing',
      stale: false,
      findings: ['anchor-missing'],
    });
  });
});

describe('DomainContextResolver: anchor cache', () => {
  it('reuses anchors until the TTL expires', async () => {
    let now = 0;
    const resolver = new DomainContextResolver({ now: () => now });
    const { transport } = await setup();
    expect((await resolver.load(did, transport)).status).toBe('verified');
    await resolver.load(did, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(1);
    now = 300_001;
    await resolver.load(did, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(2);
    // Same CID: the public bytes come from the content cache.
    expect(transport.read).toHaveBeenCalledTimes(1);
  });

  it('honours a custom TTL', async () => {
    let now = 0;
    const resolver = new DomainContextResolver({ now: () => now });
    const { transport } = await setup();
    await resolver.load(did, transport, { ttlMs: 1000 });
    now = 999;
    await resolver.load(did, transport, { ttlMs: 1000 });
    expect(transport.resolve).toHaveBeenCalledTimes(1);
    now = 1000;
    await resolver.load(did, transport, { ttlMs: 1000 });
    expect(transport.resolve).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent anchor lookups across sessions', async () => {
    const resolver = new DomainContextResolver();
    const { transport, anchor } = await setup();
    const lookup = deferred<DomainAnchor | null>();
    transport.resolve.mockReturnValueOnce(lookup.promise);
    const loads = [1, 2, 3].map(() => resolver.load(did, transport));
    lookup.resolve(anchor);
    const snapshots = await Promise.all(loads);
    expect(snapshots.map((s) => s.status)).toEqual([
      'verified',
      'verified',
      'verified',
    ]);
    expect(transport.resolve).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after invalidate and keeps the earlier snapshot stable', async () => {
    const resolver = new DomainContextResolver();
    const { transport } = await setup();
    const first = await resolver.load(did, transport);
    resolver.invalidate(did);
    const next = await setup(
      domainFixture.replace(
        'Public Biodiversity Dataset',
        'Renamed Biodiversity Dataset',
      ),
    );
    transport.resolve.mockResolvedValue(next.anchor);
    transport.read.mockImplementation(next.transport.read);
    const second = await resolver.load(did, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(2);
    expect(second.anchor?.cid).toBe(next.anchor.cid);
    expect(second.document?.raw).toContain('Renamed Biodiversity Dataset');
    expect(first.document?.raw).toBe(domainFixture);
  });

  it('labels a stale fallback but never falls back after a confirmed removal', async () => {
    let now = 0;
    const resolver = new DomainContextResolver({ now: () => now });
    const { transport } = await setup();
    await resolver.load(did, transport);
    now = 300_001;
    transport.resolve.mockRejectedValueOnce(new Error('offline'));
    const stale = await resolver.load(did, transport);
    expect(stale.status).toBe('verified');
    expect(stale.stale).toBe(true);
    expect(stale.findings).toContain('anchor-stale');
    transport.resolve.mockResolvedValueOnce(null);
    expect((await resolver.load(did, transport)).status).toBe('missing');
  });

  it('retains the verified stale fallback after an explicit refresh fails', async () => {
    const { transport } = await setup();
    const resolver = new DomainContextResolver();
    expect((await resolver.load(did, transport)).status).toBe('verified');
    resolver.invalidate(did);
    transport.resolve.mockRejectedValueOnce(new Error('offline'));
    const next = await resolver.load(did, transport);
    expect(next.status).toBe('verified');
    expect(next.stale).toBe(true);
    expect(next.findings).toContain('anchor-stale');
    transport.resolve.mockResolvedValueOnce(null);
    expect((await resolver.load(did, transport)).status).toBe('missing');
    transport.resolve.mockRejectedValueOnce(new Error('offline'));
    resolver.invalidate(did);
    expect((await resolver.load(did, transport)).status).toBe('unavailable');
  });

  it('never falls back to a cached anchor when the new one is invalid', async () => {
    const resolver = new DomainContextResolver();
    const { transport } = await setup();
    await resolver.load(did, transport);
    resolver.invalidate(did);
    transport.resolve.mockRejectedValueOnce(
      new Error('invalid-anchor-ambiguous'),
    );
    const result = await resolver.load(did, transport);
    expect(result.status).toBe('invalid');
    expect(result.stale).toBe(false);
    expect(result.document).toBeUndefined();
    expect(result.findings).toEqual(['invalid-anchor-ambiguous']);
    // The disowned revision is gone: an outage now has nothing to fall back to.
    resolver.invalidate(did);
    transport.resolve.mockRejectedValueOnce(new Error('offline'));
    expect((await resolver.load(did, transport)).status).toBe('unavailable');
  });

  it('cancels one subscriber without cancelling the shared lookup', async () => {
    const resolver = new DomainContextResolver();
    const { transport, anchor } = await setup();
    const lookup = deferred<DomainAnchor | null>();
    transport.resolve.mockReturnValueOnce(lookup.promise);
    const controller = new AbortController();
    const cancelled = resolver.load(did, transport, {
      signal: controller.signal,
    });
    const other = resolver.load(did, transport);
    controller.abort(new Error('cancelled'));
    await expect(cancelled).rejects.toThrow('cancelled');
    lookup.resolve(anchor);
    expect((await other).status).toBe('verified');
    expect(transport.resolve).toHaveBeenCalledTimes(1);
  });

  it('does not let a pre-refresh lookup repopulate the next-turn cache', async () => {
    const { anchor, transport } = await setup();
    const resolver = new DomainContextResolver();
    const lookup = deferred<DomainAnchor | null>();
    transport.resolve.mockReturnValueOnce(lookup.promise);
    const pending = resolver.load(did, transport);
    resolver.invalidate(did);
    lookup.resolve(anchor);
    expect((await pending).status).toBe('verified');
    transport.resolve.mockResolvedValueOnce(null);
    expect((await resolver.load(did, transport)).status).toBe('missing');
    expect(transport.resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps a post-refresh lookup deduplicated when the older lookup finishes', async () => {
    const { anchor, transport } = await setup();
    const resolver = new DomainContextResolver();
    const older = deferred<DomainAnchor | null>();
    const newer = deferred<DomainAnchor | null>();
    transport.resolve
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const olderLoad = resolver.load(did, transport);
    resolver.invalidate(did);
    const newerLoad = resolver.load(did, transport);
    older.resolve(anchor);
    await olderLoad;
    const subscriber = resolver.load(did, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(2);
    newer.resolve(null);
    expect((await newerLoad).status).toBe('missing');
    expect((await subscriber).status).toBe('missing');
    expect((await resolver.load(did, transport)).status).toBe('missing');
    expect(transport.resolve).toHaveBeenCalledTimes(2);
  });

  it('does not let an older invalid lookup erase a newer confirmed binding', async () => {
    const { transport, anchor } = await setup();
    const resolver = new DomainContextResolver();
    const older = deferred<DomainAnchor | null>();
    transport.resolve.mockReturnValueOnce(older.promise);
    const olderLoad = resolver.load(did, transport);
    resolver.invalidate(did);
    transport.resolve.mockResolvedValueOnce(anchor);
    expect((await resolver.load(did, transport)).status).toBe('verified');
    older.reject(new Error('invalid-anchor-ambiguous'));
    expect((await olderLoad).status).toBe('invalid');
    expect((await resolver.load(did, transport)).status).toBe('verified');
    expect(transport.resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 32 anchors', async () => {
    const resolver = new DomainContextResolver();
    const { transport } = await setup();
    transport.resolve.mockResolvedValue(null);
    for (let i = 0; i < 33; i++)
      await resolver.load(`did:ixo:entity:e${i}`, transport);
    expect(transport.resolve).toHaveBeenCalledTimes(33);
    await resolver.load('did:ixo:entity:e32', transport);
    expect(transport.resolve).toHaveBeenCalledTimes(33);
    await resolver.load('did:ixo:entity:e0', transport);
    expect(transport.resolve).toHaveBeenCalledTimes(34);
  });
});

describe('DomainContextResolver: content and parse caches', () => {
  it('parses an index once per CID across loads and sessions', async () => {
    let now = 0;
    const resolver = new DomainContextResolver({ now: () => now });
    const { transport } = await setup();
    const lint = vi.spyOn(domainValidator, 'lint');
    const first = await resolver.load(did, transport);
    now = 600_000;
    const second = await resolver.load(did, transport);
    expect(first.status).toBe('verified');
    expect(second.status).toBe('verified');
    expect(lint).toHaveBeenCalledTimes(1);
    expect(second.document).toBe(first.document);
    // Each load returns its own snapshot (per-turn mutations stay per turn).
    expect(second).not.toBe(first);
    expect(second.findings).not.toBe(first.findings);
  });

  it('caches the brief per CID', async () => {
    const resolver = new DomainContextResolver();
    const { transport } = await setup();
    const first = await resolver.load(did, transport);
    const second = await resolver.load(did, transport);
    const brief = resolver.brief(first);
    expect(brief?.tokens).toBeGreaterThan(0);
    expect(resolver.brief(second)).toBe(brief);
  });

  it('caches an invalid parse too, so tampered bytes are not re-linted', async () => {
    const text = 'not a domain';
    const { transport } = await setup(text);
    const lint = vi.spyOn(domainValidator, 'lint');
    const resolver = new DomainContextResolver();
    expect((await resolver.load(did, transport)).status).toBe('invalid');
    resolver.invalidate(did);
    expect((await resolver.load(did, transport)).status).toBe('invalid');
    expect(lint).toHaveBeenCalledTimes(1);
  });

  it('rechecks private reads but still reuses the parse of verified bytes', async () => {
    const resolver = new DomainContextResolver();
    const { anchor, transport } = await setup();
    anchor.private = true;
    const lint = vi.spyOn(domainValidator, 'lint');
    await resolver.load(did, transport);
    expect((await resolver.load(did, transport)).status).toBe('verified');
    expect(transport.read).toHaveBeenCalledTimes(2);
    expect(lint).toHaveBeenCalledTimes(1);
    transport.read.mockRejectedValueOnce(new Error('access-revoked'));
    const revoked = await resolver.load(did, transport);
    expect(revoked.status).toBe('unavailable');
    expect(revoked.findings).toContain('access-revoked');
    expect(revoked.document).toBeUndefined();
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

  it('caches decoded public text by CID and never private text', async () => {
    const { anchor, transport } = await setup();
    const resolver = new DomainContextResolver();
    const request = { ...anchor, maxBytes: 1024 * 1024 };
    expect(await resolver.readText(request, transport)).toBe(domainFixture);
    await resolver.readText(request, transport);
    expect(transport.read).toHaveBeenCalledTimes(1);
    const privateRequest = { ...request, private: true };
    await resolver.readText(privateRequest, transport);
    await resolver.readText(privateRequest, transport);
    expect(transport.read).toHaveBeenCalledTimes(3);
  });

  it('bounds the parsed-index cache by index text, not only by count', async () => {
    // Five valid indexes of about 900 Ki characters each: 4.5 Mi in all,
    // over the 4 Mi bound, so the least recently used one is evicted.
    const padding = `\n${'Padding narrative line.\n'.repeat(38_000)}`;
    const dids = [0, 1, 2, 3, 4].map((i) => `did:ixo:entity:big${i}`);
    const { transport } = await servedDomains(
      Object.fromEntries(dids.map((d) => [d, domainFor(d) + padding])),
    );
    const size = (domainFor(dids[0] ?? '') + padding).length;
    expect(size).toBeGreaterThan(PARSED_CACHE_CHARS / 5);
    expect(size).toBeLessThanOrEqual(PARSED_CACHE_CHARS / 4);
    const lint = vi.spyOn(domainValidator, 'lint');
    const resolver = new DomainContextResolver();
    for (const d of dids)
      expect((await resolver.load(d, transport)).status).toBe('verified');
    expect(lint).toHaveBeenCalledTimes(5);
    // The four most recent stay parsed ...
    await resolver.load(dids[4] ?? '', transport);
    await resolver.load(dids[1] ?? '', transport);
    expect(lint).toHaveBeenCalledTimes(5);
    // ... the first was evicted by weight (16 entries would fit by count).
    expect((await resolver.load(dids[0] ?? '', transport)).status).toBe(
      'verified',
    );
    expect(lint).toHaveBeenCalledTimes(6);
  });

  it('caches an invalid parse as a small record without the index text', async () => {
    // Large invalid indexes keep none of their text, so they never push a
    // valid index out by weight (and are still not linted twice).
    const padding = `\n${'Padding narrative line.\n'.repeat(38_000)}`;
    const valid = [0, 1, 2, 3].map((i) => `did:ixo:entity:big${i}`);
    const invalid = [0, 1, 2, 3, 4, 5].map((i) => `did:ixo:entity:bad${i}`);
    const { transport } = await servedDomains({
      ...Object.fromEntries(valid.map((d) => [d, domainFor(d) + padding])),
      ...Object.fromEntries(
        invalid.map((d) => [d, `not a domain: ${d}${padding}`]),
      ),
    });
    const lint = vi.spyOn(domainValidator, 'lint');
    const resolver = new DomainContextResolver();
    for (const d of valid)
      expect((await resolver.load(d, transport)).status).toBe('verified');
    for (const d of invalid) {
      const result = await resolver.load(d, transport);
      expect(result.status).toBe('invalid');
      expect(result.document).toBeUndefined();
    }
    expect(lint).toHaveBeenCalledTimes(10);
    for (const d of [...valid, ...invalid]) {
      resolver.invalidate(d);
      await resolver.load(d, transport);
    }
    expect(lint).toHaveBeenCalledTimes(10);
  });

  it('enforces the byte bound on cached content', async () => {
    const { anchor, transport } = await setup();
    const resolver = new DomainContextResolver();
    await resolver.bytes({ ...anchor, maxBytes: 1024 * 1024 }, transport);
    await expect(
      resolver.bytes({ ...anchor, maxBytes: 10 }, transport),
    ).rejects.toThrow('document-too-large');
  });
});

describe('DomainContextResolver: durable-run pins', () => {
  it('loads the pinned revision without asking Blocksync', async () => {
    const { transport, anchor } = await setup();
    const snapshot = await new DomainContextResolver().load(did, transport, {
      pinned: { cid: anchor.cid, uri: anchor.uri, private: false },
    });
    expect(snapshot.status).toBe('verified');
    expect(snapshot.anchor).toMatchObject({
      cid: anchor.cid,
      source: PINNED_ANCHOR_SOURCE,
    });
    expect(transport.resolve).not.toHaveBeenCalled();
  });

  it('keeps the pinned revision even after the IID moved on', async () => {
    const pinned = await setup();
    const current = await setup(
      domainFixture.replace('Initial passive rc.3 example.', 'Second release.'),
    );
    current.transport.read.mockImplementation(async (request) =>
      request.uri === pinned.anchor.uri && request.cid === pinned.anchor.cid
        ? new TextEncoder().encode(domainFixture)
        : new TextEncoder().encode(
            domainFixture.replace(
              'Initial passive rc.3 example.',
              'Second release.',
            ),
          ),
    );
    const snapshot = await new DomainContextResolver().load(
      did,
      current.transport,
      {
        pinned: {
          cid: pinned.anchor.cid,
          uri: pinned.anchor.uri,
          private: false,
        },
      },
    );
    expect(snapshot.anchor?.cid).toBe(pinned.anchor.cid);
    expect(snapshot.document?.raw).toBe(domainFixture);
  });

  it('falls back to a fresh resolution when the pinned bytes are gone', async () => {
    const { transport, anchor } = await setup();
    transport.read.mockRejectedValueOnce(new Error('document-unavailable'));
    const snapshot = await new DomainContextResolver().load(did, transport, {
      pinned: { cid: anchor.cid, uri: anchor.uri, private: false },
    });
    expect(snapshot.status).toBe('verified');
    expect(snapshot.anchor?.source).toBe('https://iid.example');
    expect(snapshot.findings[0]).toBe('pinned-revision-unavailable');
    expect(transport.resolve).toHaveBeenCalledTimes(1);
  });

  it('falls back when the pinned bytes no longer match the pinned CID', async () => {
    const { transport, anchor } = await setup();
    const other = await cidOf(new TextEncoder().encode('older revision'));
    const snapshot = await new DomainContextResolver().load(did, transport, {
      pinned: { cid: other, uri: anchor.uri, private: false },
    });
    expect(snapshot.status).toBe('verified');
    expect(snapshot.anchor?.cid).toBe(anchor.cid);
    expect(snapshot.findings).toContain('pinned-revision-unavailable');
  });
});

describe('DomainContextResolver: capsule inspection', () => {
  async function capsuleDomain(
    mutate?: (manifest: typeof capsuleFixture) => void,
  ) {
    const manifest = structuredClone(capsuleFixture);
    manifest.domains.oracle.id = did;
    mutate?.(manifest);
    manifest.metadata.release_digest = oracleCapsuleReleaseDigest(manifest);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestCid = await cidOf(manifestBytes);
    const hex = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', manifestBytes)),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const document = parseDomain(domainFixture).document;
    if (!document) throw new Error('fixture invalid');
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
    const served = await setup(source);
    served.files.set('https://docs.example/capsule', manifestBytes);
    return served;
  }

  it('inspects a capsule without activating its Master skill or tools', async () => {
    const { transport } = await capsuleDomain();
    const snapshot = await new DomainContextResolver().load(did, transport);
    expect(snapshot.status).toBe('verified');
    expect(snapshot.capsule).toMatchObject({
      status: 'inspected-not-activated',
      release: '0.1.0',
      master: { id: 'master', entrypoint: 'SKILL.md' },
      requestedToolCount: 0,
    });
    expect(snapshot.capsule?.externalChecksRequired?.length).toBeGreaterThan(0);
    expect(snapshot.findings).toContain('capsule-oracle-revision-differs');
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it('validates the capsule once per manifest CID', async () => {
    const { transport } = await capsuleDomain();
    const validate = vi.spyOn(domainValidator, 'validateOracleCapsule');
    const resolver = new DomainContextResolver();
    await resolver.load(did, transport);
    resolver.invalidate(did);
    const second = await resolver.load(did, transport);
    expect(second.capsule?.status).toBe('inspected-not-activated');
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('marks a capsule bound to another oracle as invalid', async () => {
    const { transport } = await capsuleDomain((manifest) => {
      manifest.domains.oracle.id = 'did:ixo:entity:someone-else';
    });
    const snapshot = await new DomainContextResolver().load(did, transport);
    expect(snapshot.status).toBe('verified');
    expect(snapshot.capsule?.status).toBe('invalid');
    expect(snapshot.findings).toContain('capsule-inspection-failed');
  });

  it('reports an unreadable capsule as unavailable, not invalid', async () => {
    const { transport, files } = await capsuleDomain();
    files.delete('https://docs.example/capsule');
    const snapshot = await new DomainContextResolver().load(did, transport);
    expect(snapshot.status).toBe('verified');
    expect(snapshot.capsule?.status).toBe('unavailable');
    expect(snapshot.findings).toContain('capsule-unavailable');
  });
});

describe('DomainContextResolver: bounded findings', () => {
  it('keeps a hostile index at the entry bound to a few codes, well under 500 ms', async () => {
    // 62 malformed entries plus the fixture's two: exactly the 64 allowed.
    const text = hostileIndex(did, MAX_FRONTMATTER_ARRAY_ITEMS - 2);
    const { transport } = await setup(text);
    const resolver = new DomainContextResolver();
    // Load the library first, so the timing covers parsing only.
    await domainValidator.parseDomain(domainFixture);
    const lint = vi.spyOn(domainValidator, 'lint');
    const started = performance.now();
    const snapshot = await resolver.load(did, transport);
    expect(performance.now() - started).toBeLessThan(500);
    // The validator really did report one finding per bad field ...
    const report = await lint.mock.results[0]?.value;
    expect(report?.findings.length).toBeGreaterThan(1_000);
    // ... the snapshot keeps each code once.
    expect(snapshot.status).toBe('invalid');
    expect(snapshot.findings).not.toContain('index-too-large');
    expect(snapshot.findings).toEqual([...new Set(snapshot.findings)]);
    expect(snapshot.findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
    expect(JSON.stringify(snapshot.findings).length).toBeLessThan(1024);
  });

  it('refuses an index over the entry bound without linting it, and caches that', async () => {
    const { transport } = await setup(hostileIndex(did, 1000));
    const lint = vi.spyOn(domainValidator, 'lint');
    const resolver = new DomainContextResolver();
    const started = performance.now();
    const snapshot = await resolver.load(did, transport);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(snapshot).toMatchObject({
      status: 'invalid',
      findings: ['index-too-large'],
    });
    expect(snapshot.document).toBeUndefined();
    expect(lint).not.toHaveBeenCalled();
    // The next turn pays nothing: no parse, no lint.
    const parse = vi.spyOn(domainValidator, 'parseDomain');
    resolver.invalidate(did);
    expect((await resolver.load(did, transport)).findings).toEqual([
      'index-too-large',
    ]);
    expect(parse).not.toHaveBeenCalled();
    expect(lint).not.toHaveBeenCalled();
  });

  it('refuses one entry over the bound, and an oversized frontmatter before parsing', async () => {
    const lint = vi.spyOn(domainValidator, 'lint');
    const parse = vi.spyOn(domainValidator, 'parseDomain');
    const over = await setup(
      hostileIndex(did, MAX_FRONTMATTER_ARRAY_ITEMS - 1),
    );
    expect(
      (await new DomainContextResolver().load(did, over.transport)).findings,
    ).toEqual(['index-too-large']);
    const padded = withFrontmatter((front) => {
      front['x-padding'] = 'p'.repeat(MAX_FRONTMATTER_BYTES);
    });
    const big = await setup(padded);
    parse.mockClear();
    expect(
      (await new DomainContextResolver().load(did, big.transport)).findings,
    ).toEqual(['index-too-large']);
    expect(parse).not.toHaveBeenCalled();
    expect(lint).not.toHaveBeenCalled();
  });

  it('refuses a long list or deep nesting anywhere in the frontmatter, unlinted', async () => {
    const lint = vi.spyOn(domainValidator, 'lint');
    const refused = async (text: string) => {
      const { transport } = await setup(text);
      return (await new DomainContextResolver().load(did, transport)).findings;
    };
    // A list outside documents.entries, at the bound and one over it.
    const rights = (count: number) =>
      withFrontmatter((front) => {
        front.rights = {
          ...record(front.rights),
          entries: Array.from({ length: count }, (_, i) => ({ id: `r${i}` })),
        };
      });
    expect(await refused(rights(MAX_FRONTMATTER_ARRAY_ITEMS))).not.toContain(
      'index-too-large',
    );
    expect(lint).toHaveBeenCalledTimes(1);
    lint.mockClear();
    expect(await refused(rights(MAX_FRONTMATTER_ARRAY_ITEMS + 1))).toEqual([
      'index-too-large',
    ]);
    // A list nested inside a list item.
    expect(
      await refused(
        withFrontmatter((front) => {
          front['x-nested'] = [
            { tags: Array.from({ length: 65 }, (_, i) => `t${i}`) },
          ];
        }),
      ),
    ).toEqual(['index-too-large']);
    // Nesting deeper than the bound (the frontmatter mapping is depth 1).
    const nested = (depth: number): unknown =>
      depth <= 0 ? 'leaf' : { next: nested(depth - 1) };
    expect(
      await refused(
        withFrontmatter((front) => {
          front['x-deep'] = nested(MAX_FRONTMATTER_DEPTH);
        }),
      ),
    ).toEqual(['index-too-large']);
    expect(lint).not.toHaveBeenCalled();
    expect(
      await refused(
        withFrontmatter((front) => {
          front['x-deep'] = nested(MAX_FRONTMATTER_DEPTH - 2);
        }),
      ),
    ).not.toContain('index-too-large');
    expect(lint).toHaveBeenCalledTimes(1);
  });

  it('exceedsFrontmatterShape checks lists and depth at every level', () => {
    const list = (n: number) => Array.from({ length: n }, () => 0);
    expect(exceedsFrontmatterShape({ a: list(64) })).toBe(false);
    expect(exceedsFrontmatterShape({ a: { b: [{ c: list(65) }] } })).toBe(true);
    let deep: unknown = 'leaf';
    for (let i = 0; i < MAX_FRONTMATTER_DEPTH - 1; i++) deep = [deep];
    expect(exceedsFrontmatterShape({ deep })).toBe(false);
    expect(exceedsFrontmatterShape({ deep: [deep] })).toBe(true);
    expect(exceedsFrontmatterShape(undefined)).toBe(false);
  });

  it('cuts more than 32 distinct codes, from lint, checks and outcomes together', async () => {
    const { transport } = await setup();
    const lint = domainValidator.lint.bind(domainValidator);
    vi.spyOn(domainValidator, 'lint').mockImplementation(async (...args) => {
      const report = await lint(...args);
      return {
        ...report,
        findings: [
          ...report.findings,
          ...Array.from({ length: 100 }, (_, i) => ({
            severity: 'warning' as const,
            code: `synthetic-${i % 50}`,
            message: 'synthetic',
            path: '/',
            location: { line: 1, column: 1 },
          })),
        ],
      };
    });
    const resolver = new DomainContextResolver();
    const snapshot = await resolver.load(did, transport);
    expect(snapshot.status).toBe('verified');
    expect(snapshot.findings).toHaveLength(MAX_FINDINGS);
    expect(snapshot.findings.at(-1)).toBe(FINDINGS_TRUNCATED);
    // First-seen order: the synthetic codes kept are the first ones reported.
    const synthetic = snapshot.findings.filter((code) =>
      code.startsWith('synthetic-'),
    );
    expect(synthetic.length).toBeGreaterThan(20);
    expect(synthetic).toEqual(synthetic.map((_, i) => `synthetic-${i}`));
    // A stale fallback still ends in the marker, inside the bound.
    resolver.invalidate(did);
    transport.resolve.mockRejectedValueOnce(new Error('offline'));
    const stale = await resolver.load(did, transport);
    expect(stale.findings).toHaveLength(MAX_FINDINGS);
    expect(stale.findings.at(-1)).toBe(FINDINGS_TRUNCATED);
  });

  it('boundFindings deduplicates, keeps order and is idempotent', () => {
    expect(boundFindings(['b', 'a', 'b'])).toEqual(['b', 'a']);
    const many = Array.from({ length: 40 }, (_, i) => `code-${i}`);
    const cut = boundFindings(many);
    expect(cut).toHaveLength(MAX_FINDINGS);
    expect(cut.slice(0, -1)).toEqual(many.slice(0, MAX_FINDINGS - 1));
    expect(cut.at(-1)).toBe(FINDINGS_TRUNCATED);
    expect(boundFindings([...cut, 'late'])).toEqual(cut);
    expect(boundFindings(['a', FINDINGS_TRUNCATED, 'b'])).toEqual([
      'a',
      'b',
      FINDINGS_TRUNCATED,
    ]);
  });
});

describe('LruMap', () => {
  it('evicts the least recently used entries by count and weight', () => {
    const map = new LruMap<string, string>({
      maxEntries: 3,
      maxWeight: 10,
      weigh: (value) => value.length,
    });
    map.set('a', 'aaaa');
    map.set('b', 'bbbb');
    map.get('a');
    map.set('c', 'cc');
    expect(map.weight).toBe(10);
    map.set('d', 'd');
    expect(map.has('b')).toBe(false);
    expect(map.has('a')).toBe(true);
    map.set('e', 'eeeeeeeeeee');
    expect(map.has('e')).toBe(false);
    expect(map.size).toBe(3);
  });
});
