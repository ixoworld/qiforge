import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@ucanto/principal';
import { createIxoDIDResolver } from './ixo-resolver.js';
import { base58Encode } from './utils.js';

const DID = 'did:ixo:ixo1resolvertest' as const;
const INDEXER = 'https://blocksync.example/graphql';

async function ed25519Key() {
  const signer = await ed25519.Signer.generate();
  const did = signer.did();
  return { did, multibase: did.slice('did:key:'.length) };
}

function documentResponse(
  verificationMethod: Array<Record<string, string>>,
): Response {
  return new Response(
    JSON.stringify({
      data: { iids: { nodes: [{ id: DID, verificationMethod }] } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A fetch that serves one DID document and counts its calls. */
function countingFetch(verificationMethod: Array<Record<string, string>>): {
  fetch: typeof globalThis.fetch;
  calls: () => number;
} {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls += 1;
    return documentResponse(verificationMethod);
  };
  return { fetch, calls: () => calls };
}

describe('createIxoDIDResolver', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('verification methods', () => {
    it('skips a non-Ed25519 multibase key listed before the Ed25519 one', async () => {
      const good = await ed25519Key();
      // secp256k1 multicodec (0xe7 0x01) + 33-byte compressed key.
      const secp256k1 =
        'z' +
        base58Encode(
          new Uint8Array([0xe7, 0x01, 0x02, ...new Uint8Array(32).fill(9)]),
        );
      // A raw 32-byte key in base58btc with no multicodec prefix.
      const raw = 'z' + base58Encode(new Uint8Array(32).fill(5));
      const { fetch } = countingFetch([
        {
          id: `${DID}#signing-1`,
          type: 'EcdsaSecp256k1',
          publicKeyMultibase: secp256k1,
        },
        {
          id: `${DID}#signing-2`,
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: raw,
        },
        {
          id: `${DID}#key-1`,
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: good.multibase,
        },
      ]);

      const resolver = createIxoDIDResolver({ indexerUrl: INDEXER, fetch });
      const result = await resolver(DID);

      expect(result).toEqual({ ok: [good.did] });
    });

    it('reports an error when no method is an Ed25519 key', async () => {
      const { fetch } = countingFetch([
        {
          id: `${DID}#signing-1`,
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: 'z' + base58Encode(new Uint8Array(16).fill(1)),
        },
      ]);
      const resolver = createIxoDIDResolver({ indexerUrl: INDEXER, fetch });
      const result = await resolver(DID);
      expect('error' in result).toBe(true);
    });
  });

  describe('timeout', () => {
    it('rejects a stalled fetch after the timeout', async () => {
      const fetch: typeof globalThis.fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        });
      const resolver = createIxoDIDResolver({
        indexerUrl: INDEXER,
        fetch,
        timeoutMs: 50,
      });

      const started = Date.now();
      const result = await resolver(DID);

      expect(Date.now() - started).toBeLessThan(2_000);
      expect('error' in result && result.error.name).toBe(
        'DIDKeyResolutionError',
      );
    });

    it('rejects after the timeout even when the fetch ignores the signal', async () => {
      const fetch: typeof globalThis.fetch = () => new Promise(() => {});
      const resolver = createIxoDIDResolver({
        indexerUrl: INDEXER,
        fetch,
        timeoutMs: 50,
      });

      const result = await resolver(DID);

      expect('error' in result && result.error.name).toBe(
        'DIDKeyResolutionError',
      );
    });

    it('passes an abort signal to fetch by default', async () => {
      const good = await ed25519Key();
      let signal: AbortSignal | null | undefined;
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        signal = init?.signal;
        return documentResponse([
          {
            id: `${DID}#key-1`,
            type: 'Ed25519VerificationKey2020',
            publicKeyMultibase: good.multibase,
          },
        ]);
      };
      const resolver = createIxoDIDResolver({ indexerUrl: INDEXER, fetch });
      await resolver(DID);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('refuses an invalid timeout', () => {
      for (const timeoutMs of [0, -1, Number.NaN, Infinity]) {
        expect(() =>
          createIxoDIDResolver({ indexerUrl: INDEXER, timeoutMs }),
        ).toThrow(RangeError);
      }
    });
  });

  describe('cache', () => {
    it('fetches on every call when the cache is off (the default)', async () => {
      const good = await ed25519Key();
      const counter = countingFetch([
        {
          id: `${DID}#key-1`,
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: good.multibase,
        },
      ]);
      const resolver = createIxoDIDResolver({
        indexerUrl: INDEXER,
        fetch: counter.fetch,
      });

      await resolver(DID);
      await resolver(DID);

      expect(counter.calls()).toBe(2);
    });

    it('fetches once for concurrent and repeated resolutions inside the TTL, again after it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const good = await ed25519Key();
      const counter = countingFetch([
        {
          id: `${DID}#key-1`,
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: good.multibase,
        },
      ]);
      const resolver = createIxoDIDResolver({
        indexerUrl: INDEXER,
        fetch: counter.fetch,
        cacheTtlMs: 60_000,
      });

      const concurrent = await Promise.all([resolver(DID), resolver(DID)]);
      expect(concurrent).toEqual([{ ok: [good.did] }, { ok: [good.did] }]);
      expect(counter.calls()).toBe(1);

      vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
      expect(await resolver(DID)).toEqual({ ok: [good.did] });
      expect(counter.calls()).toBe(1);

      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
      expect(await resolver(DID)).toEqual({ ok: [good.did] });
      expect(counter.calls()).toBe(2);
    });

    it('never caches a failure', async () => {
      const good = await ed25519Key();
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) return new Response('unavailable', { status: 503 });
        return documentResponse([
          {
            id: `${DID}#key-1`,
            type: 'Ed25519VerificationKey2020',
            publicKeyMultibase: good.multibase,
          },
        ]);
      };
      const resolver = createIxoDIDResolver({
        indexerUrl: INDEXER,
        fetch,
        cacheTtlMs: 60_000,
      });

      expect('error' in (await resolver(DID))).toBe(true);
      expect(await resolver(DID)).toEqual({ ok: [good.did] });
      expect(calls).toBe(2);
    });

    it('does not let a caller mutate the cached keys', async () => {
      const good = await ed25519Key();
      const counter = countingFetch([
        {
          id: `${DID}#key-1`,
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: good.multibase,
        },
      ]);
      const resolver = createIxoDIDResolver({
        indexerUrl: INDEXER,
        fetch: counter.fetch,
        cacheTtlMs: 60_000,
      });

      const first = await resolver(DID);
      if ('ok' in first) first.ok.push('did:key:zInjected');
      expect(await resolver(DID)).toEqual({ ok: [good.did] });
    });

    it('keeps at most cacheMaxEntries DIDs', async () => {
      const good = await ed25519Key();
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls += 1;
        return documentResponse([
          {
            id: 'x#key-1',
            type: 'Ed25519VerificationKey2020',
            publicKeyMultibase: good.multibase,
          },
        ]);
      };
      const resolver = createIxoDIDResolver({
        indexerUrl: INDEXER,
        fetch,
        cacheTtlMs: 60_000,
        cacheMaxEntries: 2,
      });

      await resolver('did:ixo:a');
      await resolver('did:ixo:b');
      await resolver('did:ixo:c');
      expect(calls).toBe(3);
      // `a` was the oldest and was evicted; `c` is still cached.
      await resolver('did:ixo:c');
      expect(calls).toBe(3);
      await resolver('did:ixo:a');
      expect(calls).toBe(4);
    });

    it('refuses invalid cache options', () => {
      for (const options of [
        { cacheTtlMs: -1 },
        { cacheTtlMs: Number.NaN },
        { cacheTtlMs: 1_000, cacheMaxEntries: 0 },
        { cacheTtlMs: 1_000, cacheMaxEntries: 1.5 },
      ]) {
        expect(() =>
          createIxoDIDResolver({ indexerUrl: INDEXER, ...options }),
        ).toThrow(RangeError);
      }
    });
  });

  it('uses the global fetch current at lookup time, not at creation', async () => {
    const resolver = createIxoDIDResolver({ indexerUrl: INDEXER });
    const good = await ed25519Key();
    const counter = countingFetch([
      {
        id: `${DID}#key-1`,
        type: 'Ed25519VerificationKey2020',
        publicKeyMultibase: good.multibase,
      },
    ]);
    vi.stubGlobal('fetch', counter.fetch);
    try {
      expect(await resolver(DID)).toEqual({ ok: [good.did] });
      expect(counter.calls()).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
