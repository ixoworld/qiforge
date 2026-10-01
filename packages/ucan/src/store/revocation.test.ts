import { describe, expect, it } from 'vitest';
import {
  InMemoryRevocationStore,
  createUcanStoreRevocationChecker,
} from './revocation.js';

/**
 * Build a fake fetch that records the CID batches it was asked about and
 * answers from a fixed revoked set.
 */
function fakeStore(
  revoked: string[] = [],
  overrides: { status?: number; body?: unknown } = {},
) {
  const calls: string[][] = [];
  const revokedSet = new Set(revoked);

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const parsed: unknown = JSON.parse(String(init?.body ?? '{}'));
    const cids =
      typeof parsed === 'object' &&
      parsed !== null &&
      'cids' in parsed &&
      Array.isArray(parsed.cids)
        ? (parsed.cids as string[])
        : [];
    calls.push(cids);

    const status = overrides.status ?? 200;
    const body = overrides.body ?? {
      revoked: cids.filter((c) => revokedSet.has(c)),
    };

    return new Response(JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  return { calls, fetchImpl };
}

const URL_BASE = 'https://store.ucan.ixo.earth';

describe('InMemoryRevocationStore', () => {
  it('returns only the revoked subset of the queried cids', async () => {
    const store = new InMemoryRevocationStore(['bafy-a']);
    store.revoke('bafy-b');

    expect(await store.check(['bafy-a', 'bafy-c'])).toEqual(['bafy-a']);
    expect(await store.check(['bafy-b', 'bafy-c'])).toEqual(['bafy-b']);
    expect(await store.check(['bafy-c'])).toEqual([]);
    expect(store.size).toBe(2);
  });
});

describe('createUcanStoreRevocationChecker', () => {
  it('reports revoked cids from the store', async () => {
    const { calls, fetchImpl } = fakeStore(['bafy-revoked']);
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    const result = await checker.check(['bafy-clean', 'bafy-revoked']);

    expect(result).toEqual(['bafy-revoked']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['bafy-clean', 'bafy-revoked']);
  });

  it('returns an empty array without any request for an empty input', async () => {
    const { calls, fetchImpl } = fakeStore();
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    expect(await checker.check([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('tolerates a trailing slash on the configured url', async () => {
    let seen = '';
    const fetchImpl = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ revoked: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const checker = createUcanStoreRevocationChecker({
      url: `${URL_BASE}/`,
      fetchImpl,
    });
    await checker.check(['bafy-a']);

    expect(seen).toBe(`${URL_BASE}/api/revocations/check`);
  });

  it('caches a REVOKED verdict permanently and answers later checks with no I/O', async () => {
    const { calls, fetchImpl } = fakeStore(['bafy-revoked']);
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    expect(await checker.check(['bafy-revoked'])).toEqual(['bafy-revoked']);
    expect(await checker.check(['bafy-revoked'])).toEqual(['bafy-revoked']);
    expect(await checker.check(['bafy-revoked'])).toEqual(['bafy-revoked']);

    // Revocation is irreversible, so one lookup settles it forever.
    expect(calls).toHaveLength(1);
  });

  it('caches a CLEAN verdict only for the negative ttl', async () => {
    const { calls, fetchImpl } = fakeStore();
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
      negativeCacheTtlMs: 10_000,
    });

    expect(await checker.check(['bafy-clean'])).toEqual([]);
    expect(await checker.check(['bafy-clean'])).toEqual([]);
    expect(calls).toHaveLength(1);

    // With a zero-length negative TTL every check must hit the store again.
    const fresh = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
      negativeCacheTtlMs: 0,
    });
    await fresh.check(['bafy-clean']);
    await fresh.check(['bafy-clean']);
    expect(calls).toHaveLength(3);
  });

  it('short-circuits entirely when a known-revoked cid is in the batch', async () => {
    const { calls, fetchImpl } = fakeStore(['bafy-revoked']);
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    await checker.check(['bafy-revoked']);
    expect(calls).toHaveLength(1);

    // The chain is already known-dead — no point asking about its siblings.
    const result = await checker.check(['bafy-revoked', 'bafy-unknown']);
    expect(result).toEqual(['bafy-revoked']);
    expect(calls).toHaveLength(1);
  });

  it('deduplicates cids within one check', async () => {
    const { calls, fetchImpl } = fakeStore();
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    await checker.check(['bafy-a', 'bafy-a', 'bafy-b']);

    expect(calls[0]).toEqual(['bafy-a', 'bafy-b']);
  });

  it('splits oversized inputs into batches', async () => {
    const { calls, fetchImpl } = fakeStore(['bafy-7']);
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
      maxBatch: 3,
    });

    const cids = Array.from({ length: 8 }, (_, i) => `bafy-${i}`);
    const result = await checker.check(cids);

    expect(result).toEqual(['bafy-7']);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.length)).toEqual([3, 3, 2]);
  });

  it('throws on a non-2xx response so the validator applies its policy', async () => {
    const { fetchImpl } = fakeStore([], { status: 503 });
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    await expect(checker.check(['bafy-a'])).rejects.toThrow(/503/);
  });

  it('throws on an unexpected response shape', async () => {
    const { fetchImpl } = fakeStore([], { body: { nope: true } });
    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    await expect(checker.check(['bafy-a'])).rejects.toThrow(
      /unexpected response shape/,
    );
  });

  it('throws when the request exceeds the timeout', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      // Never settles on its own; only the abort signal ends it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted')),
        );
      });
    }) as unknown as typeof globalThis.fetch;

    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
      timeoutMs: 20,
    });

    await expect(checker.check(['bafy-a'])).rejects.toThrow(/abort/i);
  });

  it('does not cache a clean verdict when the request failed', async () => {
    let fail = true;
    const calls: string[][] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as {
        cids: string[];
      };
      calls.push(parsed.cids);
      if (fail) {
        fail = false;
        return new Response('nope', { status: 500, statusText: 'Error' });
      }
      return new Response(JSON.stringify({ revoked: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const checker = createUcanStoreRevocationChecker({
      url: URL_BASE,
      fetchImpl,
    });

    await expect(checker.check(['bafy-a'])).rejects.toThrow();
    expect(await checker.check(['bafy-a'])).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
