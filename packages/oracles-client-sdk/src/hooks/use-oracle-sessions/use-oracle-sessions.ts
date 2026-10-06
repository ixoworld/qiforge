import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { useOraclesContext } from '../../providers/oracles-provider/oracles-context.js';
import { useOraclesConfig } from '../use-oracles-config.js';
import { type IChatSession } from './types.js';

export interface UseOracleSessionsOptions {
  baseUrl?: string;
  limit?: number;
}

export const useOracleSessions = (
  oracleDid: string,
  overrides?: UseOracleSessionsOptions,
) => {
  const queryClient = useQueryClient();
  const { wallet, authedRequest } = useOraclesContext();

  const { config, isReady: isConfigReady } = useOraclesConfig(
    oracleDid,
    overrides,
  );

  const apiUrl = overrides?.baseUrl ?? config.apiUrl ?? '';
  const limit = overrides?.limit ?? 20;

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery<
    {
      sessions: IChatSession[];
      total?: number;
    },
    Error,
    InfiniteData<{ sessions: IChatSession[]; total?: number }, number>,
    readonly unknown[],
    number
  >({
    // The user is part of the key: the query client outlives an account
    // switch, and a list cached for one user is never shown to another.
    queryKey: ['oracle-sessions', oracleDid, limit, wallet?.did],
    queryFn: async ({ pageParam }) => {
      const offset = pageParam ?? 0;
      const params = new URLSearchParams();
      params.set('limit', limit.toString());
      params.set('offset', offset.toString());
      const url = `${apiUrl}/sessions?${params.toString()}`;
      return authedRequest<{ sessions: IChatSession[]; total?: number }>(
        url,
        'GET',
        {},
        oracleDid,
      );
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const total = lastPage.total ?? 0;
      const currentOffset = allPages.reduce(
        (sum, page) => sum + page.sessions.length,
        0,
      );
      // If we've loaded all sessions or the last page was empty, no more pages
      if (currentOffset >= total || lastPage.sessions.length === 0) {
        return undefined;
      }
      return currentOffset;
    },
    enabled: Boolean(overrides?.baseUrl ?? config.apiUrl),
    retry: false,
  });

  // Flatten all pages into a single array
  const sessions = useMemo(() => {
    return data?.pages.flatMap((page) => page.sessions) ?? [];
  }, [data?.pages]);

  // Get total from the first page (should be consistent across pages)
  const total = data?.pages[0]?.total ?? 0;

  const {
    mutateAsync: createSession,
    isPending: isCreatingSession,
    isError: isCreateSessionError,
  } = useMutation({
    mutationFn: () =>
      authedRequest<IChatSession>(`${apiUrl}/sessions`, 'POST', {}, oracleDid),
    onSettled: async () => {
      // Invalidate and refetch to get the new session
      await queryClient.invalidateQueries({
        queryKey: ['oracle-sessions', oracleDid],
      });
    },
  });

  const {
    mutateAsync: deleteSession,
    isPending: isDeletingSession,
    isError: isDeleteSessionError,
  } = useMutation({
    mutationFn: (sessionId: string) =>
      authedRequest<void>(
        `${apiUrl}/sessions/${sessionId}`,
        'DELETE',
        {},
        oracleDid,
      ),
    onSettled: async () => {
      // Invalidate and refetch to remove the deleted session
      await queryClient.invalidateQueries({
        queryKey: ['oracle-sessions', oracleDid],
      });
    },
  });

  return {
    sessions,
    total,
    isLoading,
    error,
    // Infinite scroll functions
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    // Mutations
    createSession,
    isCreatingSession,
    isCreateSessionError,
    deleteSession,
    isDeletingSession,
    isDeleteSessionError,
    refetch,
    isConfigReady,
  };
};
