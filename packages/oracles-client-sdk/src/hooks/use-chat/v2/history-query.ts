import type { InfiniteData } from '@tanstack/react-query';
import {
  fetchHistoryPage,
  type HistoryPage,
  type HistoryRequest,
} from '../../../utils/transcript-pages.js';
import type { IMessage } from './types.js';

export type HistoryData = InfiniteData<HistoryPage<IMessage>, string | null>;

/**
 * The history as an infinite query: page 0 is the NEWEST page and older
 * pages are appended after it (`fetchNextPage` = load earlier turns).
 *
 * The order matters: a refetch — on remount, or explicitly — re-fetches the
 * loaded pages starting from the first page's parameter and walks on with
 * `getNextPageParam`. With the newest page first that parameter is "no
 * cursor", so a refetch always starts from the latest turns and walks back
 * through what had been loaded. (Newest-last, with older pages prepended,
 * would make a refetch start from the oldest loaded page and stop there —
 * the conversation would come back showing only old messages.)
 */
export function historyQueryOptions(input: {
  oracleDid: string;
  sessionId: string;
  apiUrl: string | null | undefined;
  pageSize: number;
  request: HistoryRequest;
}) {
  const { oracleDid, sessionId, apiUrl, pageSize, request } = input;
  return {
    queryKey: [oracleDid, 'messages', sessionId] as const,
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      if (!apiUrl) throw new Error('the oracle API URL is not known yet');
      return fetchHistoryPage<IMessage>(request, apiUrl, sessionId, {
        limit: pageSize,
        ...(pageParam ? { before: pageParam } : {}),
      });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: HistoryPage<IMessage>) =>
      lastPage.hasOlder && lastPage.prevCursor
        ? lastPage.prevCursor
        : undefined,
  };
}
