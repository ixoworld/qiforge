import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
  createBlobStore,
  createMatrixAdapter,
  sweepExpiredBlobs,
} from './ambient';

describe('createMatrixAdapter', () => {
  it('forwards a caller-pinned transaction id to the gateway, and an empty options object without one', async () => {
    const sendEvent = vi.fn().mockResolvedValue('$ev');
    const matrix = createMatrixAdapter({ sendEvent } as never);

    await matrix.postEvent(
      '!room',
      'ixo.action.log',
      { a: 1 },
      { txnId: 'action-log-1' },
    );
    expect(sendEvent).toHaveBeenLastCalledWith(
      '!room',
      'ixo.action.log',
      '{"a":1}',
      { txnId: 'action-log-1' },
    );

    await matrix.postToRoom('!room', { body: 'hi' });
    expect(sendEvent).toHaveBeenLastCalledWith(
      '!room',
      'm.room.message',
      '{"body":"hi"}',
      {},
    );
  });
});

describe('sweepExpiredBlobs', () => {
  it('deletes expired blobs a page at a time, keeps live ones, and leaves other keys alone', async () => {
    const stub = env.RESULT_STORE_TEST.get(
      env.RESULT_STORE_TEST.idFromName('blob-sweep'),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = state.storage;
      const blobs = createBlobStore(storage);
      const expired: string[] = [];
      for (let i = 0; i < 5; i += 1)
        expired.push(
          await blobs.put({
            userDid: 'did:ixo:u',
            name: `old-${i}`,
            value: 'x',
            ttlSeconds: 1,
          }),
        );
      const live = await blobs.put({
        userDid: 'did:ixo:u',
        name: 'live',
        value: 'y',
        ttlSeconds: 3600,
      });
      await storage.put('meta:other', 'kept');
      const later = Date.now() + 5_000;

      // Pages of two: the sweep walks the prefix and says where to go on.
      let deleted = 0;
      let pages = 0;
      let next: string | null | undefined;
      do {
        const swept = await sweepExpiredBlobs(storage, {
          limit: 2,
          now: later,
          ...(next ? { startAfter: next } : {}),
        });
        deleted += swept.deleted;
        next = swept.next;
        pages += 1;
      } while (next !== null);
      expect(deleted).toBe(5);
      // Six blobs: three full pages, then an empty one that ends the walk.
      expect(pages).toBe(4);
      for (const id of expired)
        expect(await storage.get(`blob:did:ixo:u:${id}`)).toBeUndefined();
      expect(await blobs.get({ userDid: 'did:ixo:u', blobId: live })).toEqual({
        name: 'live',
        value: 'y',
      });
      expect(await storage.get('meta:other')).toBe('kept');
      // Nothing left to do: one page, the end reached.
      expect(await sweepExpiredBlobs(storage, { now: later })).toEqual({
        deleted: 0,
        next: null,
      });
    });
  });
});
