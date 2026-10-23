import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOraclesContext } from '../../providers/oracles-provider/oracles-context.js';
import { oracleSessionsQueryKey } from '../use-oracle-sessions/use-oracle-sessions.js';
import { useOraclesConfig } from '../use-oracles-config.js';
import { activeRunsQueryKey, type ActiveRunsData } from './use-active-runs.js';

export interface UseAbortSessionOptions {
  baseUrl?: string;
}

/**
 * Stop the current message of any session with `POST /messages/abort` —
 * a chat-list row's Stop, for a session that is not the mounted chat
 * (`useChat().abortStream` stops only that one). The runtime ends the
 * session's active run, a message still waiting in admission and one queued
 * behind a superseded run (each `aborted`; the reply so far is kept);
 * messages sent with `multitask: 'enqueue'` behind it still start. Resolves
 * with `{ success }` (false when the session had nothing to stop); the
 * runtime answers once the stopped run has ended (at most ~5 s).
 *
 * The session leaves `useActiveRuns` at once (put back if the request
 * fails); afterwards the active runs and the session lists (whose rows
 * carry `activeRun`) are refreshed.
 */
export const useAbortSession = (
  oracleDid: string,
  overrides?: UseAbortSessionOptions,
) => {
  const queryClient = useQueryClient();
  const { authedRequest } = useOraclesContext();
  const { config } = useOraclesConfig(oracleDid, overrides);
  const apiUrl = overrides?.baseUrl ?? config.apiUrl ?? '';

  const { mutateAsync, isPending, error } = useMutation({
    mutationFn: async (sessionId: string) => {
      if (!apiUrl) throw new Error("The oracle's API URL is not known yet");
      return authedRequest<{ success: boolean }>(
        `${apiUrl}/messages/abort`,
        'POST',
        {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        },
        oracleDid,
      );
    },
    onMutate: async (sessionId: string) => {
      const queryKey = activeRunsQueryKey(oracleDid);
      // A poll in flight must not put the run back after the removal.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueriesData<ActiveRunsData>({
        queryKey,
      });
      queryClient.setQueriesData<ActiveRunsData>({ queryKey }, (cached) =>
        cached
          ? {
              ...cached,
              runs: cached.runs.filter((run) => run.sessionId !== sessionId),
            }
          : cached,
      );
      return { previous };
    },
    onError: (_error, _sessionId, context) => {
      for (const [key, data] of context?.previous ?? [])
        queryClient.setQueryData(key, data);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: activeRunsQueryKey(oracleDid),
        }),
        queryClient.invalidateQueries({
          queryKey: oracleSessionsQueryKey(oracleDid),
        }),
      ]);
    },
  });

  return {
    abortSession: mutateAsync,
    isAborting: isPending,
    error,
  };
};
