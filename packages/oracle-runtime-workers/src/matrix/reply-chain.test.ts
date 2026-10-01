import { describe, expect, it } from 'vitest';
import {
  readRelatesTo,
  resolveReplyChainRoot,
  ThreadRootCache,
  type MatrixRelatesTo,
} from './reply-chain';

/** `undefined` = an event with no relation; a missing key = an unknown event. */
function graph(events: Record<string, MatrixRelatesTo | undefined>) {
  const fetched: string[] = [];
  const fetchRelatesTo = async (
    id: string,
  ): Promise<MatrixRelatesTo | null> => {
    fetched.push(id);
    return id in events ? (events[id] ?? {}) : null;
  };
  return { fetchRelatesTo, fetched };
}

describe('resolveReplyChainRoot', () => {
  it("uses the event's own m.thread relation without fetching", async () => {
    const { fetchRelatesTo, fetched } = graph({});
    const cache = new ThreadRootCache();
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { rel_type: 'm.thread', event_id: '$root' },
        fetchRelatesTo,
        cache,
      }),
    ).resolves.toBe('$root');
    expect(fetched).toEqual([]);
    expect(cache.get('$e')).toBe('$root');
  });

  it('a bare message (no relation) roots its own thread — Node keys the session on it', async () => {
    const { fetchRelatesTo, fetched } = graph({});
    const cache = new ThreadRootCache();
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: undefined,
        fetchRelatesTo,
        cache,
      }),
    ).resolves.toBe('$e');
    expect(fetched).toEqual([]);
    expect(cache.get('$e')).toBe('$e');
  });

  it('walks a quote-reply chain up to the threaded ancestor and memoises the path', async () => {
    // $reply2 → $reply1 → $threaded (m.thread → $root)
    const { fetchRelatesTo, fetched } = graph({
      $reply1: { 'm.in_reply_to': { event_id: '$threaded' } },
      $threaded: { rel_type: 'm.thread', event_id: '$root' },
    });
    const cache = new ThreadRootCache();
    await expect(
      resolveReplyChainRoot({
        eventId: '$reply2',
        relatesTo: { 'm.in_reply_to': { event_id: '$reply1' } },
        fetchRelatesTo,
        cache,
      }),
    ).resolves.toBe('$root');
    expect(fetched).toEqual(['$reply1', '$threaded']);
    // Every event on the path now resolves without a fetch.
    for (const id of ['$reply2', '$reply1', '$threaded'])
      expect(cache.get(id)).toBe('$root');
    const again = graph({});
    await expect(
      resolveReplyChainRoot({
        eventId: '$reply3',
        relatesTo: { 'm.in_reply_to': { event_id: '$reply1' } },
        fetchRelatesTo: again.fetchRelatesTo,
        cache,
      }),
    ).resolves.toBe('$root');
    expect(again.fetched).toEqual([]);
  });

  it('a quote-reply chain that ends on a bare message is rooted on that message', async () => {
    const { fetchRelatesTo } = graph({
      $q: { 'm.in_reply_to': { event_id: '$root' } }, // a quote-reply of the root
      $root: undefined, // the bare message that opened the conversation
    });
    const cache = new ThreadRootCache();
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$q' } },
        fetchRelatesTo,
        cache,
      }),
    ).resolves.toBe('$root');
    // The whole path is memoised on the root.
    expect(cache.get('$e')).toBe('$root');
    expect(cache.get('$q')).toBe('$root');
    expect(cache.get('$root')).toBe('$root');
  });

  it('terminates on cycles, missing events and fetch failures at the last event reached', async () => {
    const cyc = graph({
      $a: { 'm.in_reply_to': { event_id: '$b' } },
      $b: { 'm.in_reply_to': { event_id: '$a' } },
    });
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$a' } },
        fetchRelatesTo: cyc.fetchRelatesTo,
        cache: new ThreadRootCache(),
      }),
    ).resolves.toBe('$b');
    // The quoted event cannot be fetched (redacted, before the bot joined):
    // it is still the best root there is.
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$missing' } },
        fetchRelatesTo: async () => null,
        cache: new ThreadRootCache(),
      }),
    ).resolves.toBe('$missing');
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$boom' } },
        fetchRelatesTo: async () => {
          throw new Error('network');
        },
        cache: new ThreadRootCache(),
      }),
    ).resolves.toBe('$boom');
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$a' } },
        fetchRelatesTo: cyc.fetchRelatesTo,
        cache: new ThreadRootCache(),
        maxHops: 1,
      }),
    ).resolves.toBe('$a');
  });

  it('readRelatesTo tolerates non-object content', () => {
    expect(readRelatesTo(null)).toBeUndefined();
    expect(readRelatesTo({ body: 'x' })).toBeUndefined();
    expect(
      readRelatesTo({
        'm.relates_to': { rel_type: 'm.thread', event_id: '$r' },
      }),
    ).toEqual({ rel_type: 'm.thread', event_id: '$r' });
  });

  it('the cache is bounded', () => {
    const cache = new ThreadRootCache(2);
    cache.set('$1', 'a');
    cache.set('$2', 'b');
    cache.set('$3', 'c');
    expect(cache.get('$1')).toBeUndefined();
    expect(cache.get('$3')).toBe('c');
  });
});
