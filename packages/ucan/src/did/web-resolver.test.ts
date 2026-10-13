import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@ucanto/principal';
import type { DID } from '@ucanto/interface';
import { createWebDIDResolver } from './web-resolver.js';
import { base58Encode } from './utils.js';

async function documentFetch() {
  const signer = await ed25519.Signer.generate();
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({
        verificationMethod: [
          {
            id: '#key-1',
            type: 'Ed25519VerificationKey2020',
            publicKeyMultibase: signer.did().slice('did:key:'.length),
          },
        ],
      }),
      { status: 200 },
    );
  };
  return { fetch, urls };
}

const httpsCases: Array<[DID, string]> = [
  [
    'did:web:localhost.evil.com',
    'https://localhost.evil.com/.well-known/did.json',
  ],
  ['did:web:localhostfoo.com', 'https://localhostfoo.com/.well-known/did.json'],
  [
    'did:web:127.0.0.1.evil.com',
    'https://127.0.0.1.evil.com/.well-known/did.json',
  ],
  [
    'did:web:localhost%3Aevil.com',
    'https://localhost:evil.com/.well-known/did.json',
  ],
  ['did:web:example.com', 'https://example.com/.well-known/did.json'],
];

const loopbackCases: Array<[DID, string]> = [
  ['did:web:localhost', 'http://localhost/.well-known/did.json'],
  ['did:web:localhost%3A8080', 'http://localhost:8080/.well-known/did.json'],
  ['did:web:127.0.0.1', 'http://127.0.0.1/.well-known/did.json'],
  ['did:web:127.0.0.1%3A3000:svc', 'http://127.0.0.1:3000/svc/did.json'],
  ['did:web:%5B%3A%3A1%5D', 'http://[::1]/.well-known/did.json'],
  ['did:web:%5B%3A%3A1%5D%3A3000', 'http://[::1]:3000/.well-known/did.json'],
];

describe('createWebDIDResolver', () => {
  it.each(httpsCases)('fetches %s over https', async (did, url) => {
    const { fetch, urls } = await documentFetch();
    await createWebDIDResolver({ fetch })(did);
    expect(urls).toEqual([url]);
  });

  it.each(loopbackCases)(
    'fetches the loopback host %s over http',
    async (did, url) => {
      const { fetch, urls } = await documentFetch();
      await createWebDIDResolver({ fetch })(did);
      expect(urls).toEqual([url]);
    },
  );

  it('skips a non-Ed25519 multibase key and returns the Ed25519 one', async () => {
    const signer = await ed25519.Signer.generate();
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          verificationMethod: [
            {
              id: '#raw',
              type: 'Ed25519VerificationKey2020',
              publicKeyMultibase:
                'z' + base58Encode(new Uint8Array(32).fill(3)),
            },
            {
              id: '#key-1',
              type: 'Ed25519VerificationKey2020',
              publicKeyMultibase: signer.did().slice('did:key:'.length),
            },
          ],
        }),
        { status: 200 },
      );

    const result = await createWebDIDResolver({ fetch })('did:web:example.com');
    expect(result).toEqual({ ok: [signer.did()] });
  });

  describe('timeout', () => {
    it('fails a stalled fetch after the timeout', async () => {
      let signal: AbortSignal | null | undefined;
      const fetch: typeof globalThis.fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal;
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        });

      const result = await createWebDIDResolver({ fetch, timeoutMs: 50 })(
        'did:web:example.com',
      );

      expect(signal).toBeInstanceOf(AbortSignal);
      expect('error' in result && result.error.name).toBe(
        'DIDKeyResolutionError',
      );
    });

    it('fails after the timeout even when the fetch ignores the signal', async () => {
      const fetch: typeof globalThis.fetch = () => new Promise(() => {});

      const result = await createWebDIDResolver({ fetch, timeoutMs: 50 })(
        'did:web:example.com',
      );

      expect('error' in result && result.error.name).toBe(
        'DIDKeyResolutionError',
      );
    });

    it('refuses an invalid timeout', () => {
      for (const timeoutMs of [0, -1, Number.NaN, Infinity]) {
        expect(() => createWebDIDResolver({ timeoutMs })).toThrow(RangeError);
      }
    });
  });

  describe('cache', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fetches on every call when the cache is off (the default)', async () => {
      const { fetch, urls } = await documentFetch();
      const resolver = createWebDIDResolver({ fetch });

      await resolver('did:web:example.com');
      await resolver('did:web:example.com');

      expect(urls).toHaveLength(2);
    });

    it('fetches once for concurrent and repeated resolutions inside the TTL, again after it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { fetch, urls } = await documentFetch();
      const resolver = createWebDIDResolver({ fetch, cacheTtlMs: 60_000 });

      const [a, b] = await Promise.all([
        resolver('did:web:example.com'),
        resolver('did:web:example.com'),
      ]);
      expect(a).toEqual(b);
      expect('ok' in a).toBe(true);
      expect(urls).toHaveLength(1);

      vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
      await resolver('did:web:example.com');
      expect(urls).toHaveLength(1);

      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      await resolver('did:web:example.com');
      expect(urls).toHaveLength(2);
    });

    it('never caches a failure', async () => {
      const ok = await documentFetch();
      let calls = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        calls += 1;
        if (calls === 1) return new Response('unavailable', { status: 503 });
        return ok.fetch(input, init);
      };
      const resolver = createWebDIDResolver({ fetch, cacheTtlMs: 60_000 });

      expect('error' in (await resolver('did:web:example.com'))).toBe(true);
      expect('ok' in (await resolver('did:web:example.com'))).toBe(true);
      expect(calls).toBe(2);
    });

    it('keeps at most cacheMaxEntries DIDs', async () => {
      const { fetch, urls } = await documentFetch();
      const resolver = createWebDIDResolver({
        fetch,
        cacheTtlMs: 60_000,
        cacheMaxEntries: 2,
      });

      await resolver('did:web:a.example');
      await resolver('did:web:b.example');
      await resolver('did:web:c.example');
      await resolver('did:web:c.example');
      expect(urls).toHaveLength(3);
      await resolver('did:web:a.example');
      expect(urls).toHaveLength(4);
    });

    it('refuses invalid cache options', () => {
      for (const options of [
        { cacheTtlMs: -1 },
        { cacheTtlMs: Number.NaN },
        { cacheTtlMs: 1_000, cacheMaxEntries: 0 },
      ]) {
        expect(() => createWebDIDResolver(options)).toThrow(RangeError);
      }
    });
  });

  it('uses the global fetch current at lookup time, not at creation', async () => {
    const resolver = createWebDIDResolver();
    const { fetch, urls } = await documentFetch();
    vi.stubGlobal('fetch', fetch);
    try {
      expect('ok' in (await resolver('did:web:example.com'))).toBe(true);
      expect(urls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
