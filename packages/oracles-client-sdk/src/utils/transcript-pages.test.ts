import { describe, expect, it, vi } from 'vitest';
import { RequestError } from './request.js';
import {
  appendTail,
  fetchHistoryPage,
  flattenPages,
  type HistoryPage,
  mergeHistory,
} from './transcript-pages.js';

type M = { id: string; content: string };
const m = (id: string): M => ({ id, content: id });
const page = (
  ids: string[],
  extra: Partial<HistoryPage<M>> = {},
): HistoryPage<M> => ({
  messages: ids.map(m),
  prevCursor: null,
  nextCursor: ids[ids.length - 1] ?? null,
  hasOlder: false,
  hasNewer: false,
  ...extra,
});

describe('fetchHistoryPage', () => {
  it('asks the paged route with the query and returns its page', async () => {
    const request = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://o/sessions/%24s%2F1/messages?limit=20&before=h5',
      );
      return page(['h3', 'a3', 'h4', 'a4'], {
        hasOlder: true,
        prevCursor: 'h3',
        hasNewer: true,
      });
    });
    const got = await fetchHistoryPage<M>(
      request as never,
      'https://o',
      '$s/1',
      { limit: 20, before: 'h5' },
    );
    expect(got).toMatchObject({
      prevCursor: 'h3',
      nextCursor: 'a4',
      hasOlder: true,
      hasNewer: true,
    });
    expect(got.legacy).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('falls back to the whole transcript when the runtime has no paged route', async () => {
    const request = vi.fn(async (url: string) => {
      if (url.includes('/sessions/'))
        throw new RequestError('Cannot GET', { status: 404 });
      expect(url).toBe('https://o/messages/s1');
      return { messages: [m('h1'), m('a1')] };
    });
    const got = await fetchHistoryPage<M>(request as never, 'https://o', 's1', {
      limit: 20,
    });
    expect(got).toEqual({
      messages: [m('h1'), m('a1')],
      prevCursor: null,
      nextCursor: null,
      hasOlder: false,
      hasNewer: false,
      legacy: true,
    });
    // Older or newer than "everything" is nothing, and never a second request.
    const older = await fetchHistoryPage<M>(
      request as never,
      'https://o',
      's1',
      { limit: 20, before: 'h1' },
    );
    expect(older).toEqual({
      messages: [],
      prevCursor: null,
      nextCursor: null,
      hasOlder: false,
      hasNewer: false,
      legacy: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('lets every other failure through', async () => {
    const request = vi.fn(async () => {
      throw new RequestError('nope', { status: 401 });
    });
    await expect(
      fetchHistoryPage<M>(request as never, 'https://o', 's1', { limit: 20 }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('flattenPages + mergeHistory', () => {
  it('flattens newest-first pages into an oldest-first transcript and, idle, the history is the truth', () => {
    const pages = [page(['h2', 'a2']), page(['h1', 'a1'])]; // newest page first
    const history = flattenPages(pages);
    expect(history.map((x) => x.id)).toEqual(['h1', 'a1', 'h2', 'a2']);
    // The streamed copy of turn 2 (other ids) is dropped once the runtime's copy is in.
    const shown = [m('h1'), m('a1'), m('req-2'), m('req-2-ai')];
    expect(mergeHistory(history, shown, false)).toBe(history);
  });

  it('keeps the turn in flight on top of the history while streaming', () => {
    const history = [m('h1'), m('a1'), m('h2'), m('a2')];
    const shown = [m('h2'), m('a2'), m('req-3'), m('req-3-ai')];
    const merged = mergeHistory(history, shown, true);
    expect(merged.map((x) => x.id)).toEqual([
      'h1',
      'a1',
      'h2',
      'a2',
      'req-3',
      'req-3-ai',
    ]);
    expect(mergeHistory(history, [m('h2')], true)).toBe(history);
  });
});

describe('appendTail', () => {
  it('appends new turns to the newest page (the first) and moves its cursor', () => {
    const pages = [page(['h2', 'a2']), page(['h1', 'a1'], { hasOlder: false })]; // newest page first
    const folded = appendTail(pages, page(['h3', 'a3'], { hasNewer: true }));
    expect(folded).toHaveLength(2);
    expect(folded[0]!.messages.map((x) => x.id)).toEqual([
      'h2',
      'a2',
      'h3',
      'a3',
    ]);
    expect(folded[0]).toMatchObject({ nextCursor: 'a3', hasNewer: true });
    expect(folded[1]).toBe(pages[1]); // untouched pages keep their identity
    expect(pages[0]!.messages).toHaveLength(2); // input untouched
  });

  it('replaces a re-sent turn in place (the cursor had split it)', () => {
    const pages = [page(['h1', 'a1', 'h2', 'a2-calling'])];
    const folded = appendTail(pages, page(['h2', 'a2-calling', 'r2']));
    expect(folded[0]!.messages.map((x) => x.id)).toEqual([
      'h1',
      'a1',
      'h2',
      'a2-calling',
      'r2',
    ]);
    expect(folded[0]!.nextCursor).toBe('r2');
  });

  it('starts from the tail when nothing was loaded', () => {
    expect(appendTail([], page(['h1']))).toEqual([page(['h1'])]);
  });
});
