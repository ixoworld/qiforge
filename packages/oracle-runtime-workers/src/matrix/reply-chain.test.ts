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

  it('a bare message (no relation) is the main timeline', async () => {
    const { fetchRelatesTo } = graph({});
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: undefined,
        fetchRelatesTo,
        cache: new ThreadRootCache(),
      }),
    ).resolves.toBeNull();
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

  it('a quote-reply chain that ends on a bare main-timeline message stays in the main timeline', async () => {
    const { fetchRelatesTo } = graph({
      $bot: undefined, // bare reply from the bot in the main timeline
    });
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$bot' } },
        fetchRelatesTo,
        cache: new ThreadRootCache(),
      }),
    ).resolves.toBeNull();
  });

  it('terminates on cycles, missing events and fetch failures', async () => {
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
    ).resolves.toBeNull();
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$missing' } },
        fetchRelatesTo: async () => null,
        cache: new ThreadRootCache(),
      }),
    ).resolves.toBeNull();
    await expect(
      resolveReplyChainRoot({
        eventId: '$e',
        relatesTo: { 'm.in_reply_to': { event_id: '$boom' } },
        fetchRelatesTo: async () => {
          throw new Error('network');
        },
        cache: new ThreadRootCache(),
      }),
    ).resolves.toBeNull();
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
