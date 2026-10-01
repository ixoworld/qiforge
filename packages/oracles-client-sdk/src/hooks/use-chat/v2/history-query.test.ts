import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  flattenPages,
  type HistoryPage,
} from '../../../utils/transcript-pages.js';
import { type HistoryData, historyQueryOptions } from './history-query.js';
import type { IMessage } from './types.js';

type Page = HistoryPage<IMessage>;
const m = (id: string): IMessage => ({ id, type: 'ai', content: id });

/** A four-turn transcript served two turns per page, newest page first. */
function server(): (url: string) => Promise<Page> {
  const pages: Record<string, Page> = {
    newest: {
      messages: [m('h3'), m('a3'), m('h4'), m('a4')],
      prevCursor: 'h3',
      nextCursor: 'a4',
      hasOlder: true,
      hasNewer: false,
    },
    h3: {
      messages: [m('h1'), m('a1'), m('h2'), m('a2')],
      prevCursor: null,
      nextCursor: 'a2',
      hasOlder: false,
      hasNewer: true,
    },
  };
  return async (url) => {
    const before = new URL(url).searchParams.get('before');
    return pages[before ?? 'newest']!;
  };
}

describe('historyQueryOptions', () => {
  it('a refetch of a two-page history starts from the newest turns and keeps both pages', async () => {
    const request = vi.fn(server());
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = historyQueryOptions({
      oracleDid: 'did:o',
      sessionId: 's',
      apiUrl: 'https://o',
      pageSize: 2,
      request: request as never,
    });

    // First load, then the reader scrolls up: the older page is loaded next.
    await client.fetchInfiniteQuery({ ...options, pages: 2 });
    const loaded = client.getQueryData<HistoryData>(options.queryKey)!;
    expect(loaded.pages.map((p) => p.messages[0]!.id)).toEqual(['h3', 'h1']); // newest page first
    expect(loaded.pageParams).toEqual([null, 'h3']);
    expect(flattenPages(loaded.pages).map((x) => x.id)).toEqual([
      'h1',
      'a1',
      'h2',
      'a2',
      'h3',
      'a3',
      'h4',
      'a4',
    ]);

    // Leaving the page and coming back refetches: it must start at the newest
    // turns again (no cursor), then walk back through the pages that were loaded.
    request.mockClear();
    await client.refetchQueries({ queryKey: options.queryKey });
    const again = client.getQueryData<HistoryData>(options.queryKey)!;
    expect(
      request.mock.calls.map(([url]) =>
        new URL(url).searchParams.get('before'),
      ),
    ).toEqual([null, 'h3']);
    expect(again.pages.map((p) => p.messages[0]!.id)).toEqual(['h3', 'h1']);
    expect(flattenPages(again.pages).at(-1)?.id).toBe('a4');
  });

  it('stops paging older once the first message is loaded', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = historyQueryOptions({
      oracleDid: 'did:o',
      sessionId: 's',
      apiUrl: 'https://o',
      pageSize: 2,
      request: server() as never,
    });
    await client.fetchInfiniteQuery({ ...options, pages: 5 });
    const data = client.getQueryData<HistoryData>(options.queryKey)!;
    expect(data.pages).toHaveLength(2);
    expect(options.getNextPageParam(data.pages[1]!)).toBeUndefined();
  });
});
