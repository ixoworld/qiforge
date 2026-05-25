import type { Cache } from 'cache-manager';
import { describe, expect, it, vi } from 'vitest';
import { BlobStoreService } from './blob-store.service.js';

interface CacheMock extends Partial<Cache> {
  store: Map<string, { value: unknown; ttlMs: number }>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function makeCache(): CacheMock {
  const store = new Map<string, { value: unknown; ttlMs: number }>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)?.value),
    set: vi.fn(async (k: string, v: unknown, ttlMs: number) => {
      store.set(k, { value: v, ttlMs });
    }),
  };
}

function makeService(cache: CacheMock): BlobStoreService {
  return new BlobStoreService(cache as unknown as Cache);
}

describe('BlobStoreService', () => {
  describe('isValidBlobId', () => {
    it('accepts a well-formed id', () => {
      const svc = makeService(makeCache());
      expect(svc.isValidBlobId('blob_0123456789abcdef')).toBe(true);
    });

    it('rejects wrong prefix, wrong length, non-hex, non-string', () => {
      const svc = makeService(makeCache());
      expect(svc.isValidBlobId('foo_0123456789abcdef')).toBe(false);
      expect(svc.isValidBlobId('blob_short')).toBe(false);
      expect(svc.isValidBlobId('blob_zzzzzzzzzzzzzzzz')).toBe(false);
      expect(svc.isValidBlobId(123)).toBe(false);
      expect(svc.isValidBlobId(null)).toBe(false);
    });
  });

  describe('put', () => {
    it('returns a fresh blob_<16 hex> id and stores under the namespaced key', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const id = await svc.put({
        userDid: 'did:ixo:user-a',
        name: 'ucan_invocation',
        value: 'CAR_BYTES',
      });
      expect(id).toMatch(/^blob_[0-9a-f]{16}$/);
      expect(cache.store.has(`blob:did:ixo:user-a:${id}`)).toBe(true);
      expect(cache.store.get(`blob:did:ixo:user-a:${id}`)?.value).toEqual({
        name: 'ucan_invocation',
        value: 'CAR_BYTES',
      });
    });

    it('uses default TTL when none provided and converts seconds → ms', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const id = await svc.put({
        userDid: 'did:ixo:user',
        name: 'n',
        value: 'v',
      });
      expect(cache.store.get(`blob:did:ixo:user:${id}`)?.ttlMs).toBe(
        BlobStoreService.DEFAULT_TTL_SECONDS * 1000,
      );
    });

    it('clamps TTL above MAX_TTL_SECONDS down to the ceiling', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const id = await svc.put({
        userDid: 'u',
        name: 'n',
        value: 'v',
        ttlSeconds: BlobStoreService.MAX_TTL_SECONDS * 10,
      });
      expect(cache.store.get(`blob:u:${id}`)?.ttlMs).toBe(
        BlobStoreService.MAX_TTL_SECONDS * 1000,
      );
    });

    it('clamps TTL <= 0 up to 1 second', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const id = await svc.put({
        userDid: 'u',
        name: 'n',
        value: 'v',
        ttlSeconds: 0,
      });
      expect(cache.store.get(`blob:u:${id}`)?.ttlMs).toBe(1000);
    });

    it('throws when userDid is missing', async () => {
      const svc = makeService(makeCache());
      await expect(
        svc.put({ userDid: '', name: 'n', value: 'v' }),
      ).rejects.toThrow(/userDid is required/);
    });

    it('throws when value is empty or non-string', async () => {
      const svc = makeService(makeCache());
      await expect(
        svc.put({ userDid: 'u', name: 'n', value: '' }),
      ).rejects.toThrow(/non-empty string/);
      await expect(
        svc.put({
          userDid: 'u',
          name: 'n',
          value: 123 as unknown as string,
        }),
      ).rejects.toThrow(/non-empty string/);
    });
  });

  describe('get', () => {
    it('returns the stored payload for the owning user', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const id = await svc.put({
        userDid: 'did:ixo:owner',
        name: 'n',
        value: 'V',
      });
      await expect(
        svc.get({ userDid: 'did:ixo:owner', blobId: id }),
      ).resolves.toEqual({ name: 'n', value: 'V' });
    });

    it('returns null for a different userDid (cross-user isolation)', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const id = await svc.put({
        userDid: 'did:ixo:owner',
        name: 'n',
        value: 'V',
      });
      await expect(
        svc.get({ userDid: 'did:ixo:intruder', blobId: id }),
      ).resolves.toBeNull();
    });

    it('returns null on missing userDid, malformed id, or cache miss', async () => {
      const svc = makeService(makeCache());
      await expect(
        svc.get({ userDid: '', blobId: 'blob_0123456789abcdef' }),
      ).resolves.toBeNull();
      await expect(
        svc.get({ userDid: 'u', blobId: 'not-a-blob-id' }),
      ).resolves.toBeNull();
      await expect(
        svc.get({ userDid: 'u', blobId: 'blob_0000000000000000' }),
      ).resolves.toBeNull();
    });
  });
});
