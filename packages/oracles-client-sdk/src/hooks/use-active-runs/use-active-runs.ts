import {
  useQuery,
  useQueryClient,
  type InfiniteData,
  type Query,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useOraclesContext } from '../../providers/oracles-provider/oracles-context.js';
import { isCredentialRefusal } from '../../utils/auth-renewal.js';
import { RequestError } from '../../utils/request.js';
import { type IChatSession } from '../use-oracle-sessions/types.js';
import { oracleSessionsQueryKey } from '../use-oracle-sessions/use-oracle-sessions.js';
import { useOraclesConfig } from '../use-oracles-config.js';
import { type ActiveRunsResponse, type ChatRunSummary } from './types.js';

/** Poll cadence while one of the user's chats has an active run. */
export const ACTIVE_RUNS_BUSY_POLL_MS = 4_000;
/** Poll cadence while none has (and after a failed poll). */
export const ACTIVE_RUNS_IDLE_POLL_MS = 30_000;
/** How long a runtime without the route is left alone before it is asked again. */
export const ACTIVE_RUNS_UNSUPPORTED_REPROBE_MS = 10 * 60_000;

/**
 * The 404 a runtime that predates the route answers: the path falls through
 * to `GET /runs/:runId` there. Any other 404 (a wrong base URL, the shell's
 * generic not-found) is an ordinary failure, not "unsupported".
 */
const UNSUPPORTED_MESSAGE = 'Run active not found';

function isUnsupportedAnswer(err: unknown): boolean {
  return (
    RequestError.isRequestError(err) &&
    err.status === 404 &&
    err.message === UNSUPPORTED_MESSAGE
  );
}

/** The oracle refused the poll's credentials (polling waits for a focus). */
function isRefusedCredentials(err: unknown): boolean {
  return (
    RequestError.isRequestError(err) &&
    isCredentialRefusal(err.status, err.code)
  );
}

export interface UseActiveRunsOptions {
  baseUrl?: string;
}

/** What a `useActiveRuns` query caches. */
export interface ActiveRunsData {
  /** False once the runtime answered 404: it predates `GET /runs/active`. */
  supported: boolean;
  runs: ChatRunSummary[];
}

/** Query-key prefix of every `useActiveRuns` query of an oracle. */
export const activeRunsQueryKey = (oracleDid: string) =>
  ['oracle-active-runs', oracleDid] as const;

const NO_RUNS: ChatRunSummary[] = [];

const BUSY_RANK: Record<ChatRunSummary['status'], number> = {
  running: 0,
  recovering: 1,
  queued: 2,
  finished: 3,
  aborted: 3,
  interrupted: 3,
  failed: 3,
};

/**
 * The run each session is busy with: the running or recovering one, else
 * the oldest queued one (`runs` is oldest first) — the run the runtime's
 * `GET /sessions/:id/run` reports for that session.
 */
function bySessionOf(
  runs: readonly ChatRunSummary[],
): Record<string, ChatRunSummary> {
  const bySession: Record<string, ChatRunSummary> = {};
  for (const run of runs) {
    const current = bySession[run.sessionId];
    if (!current || BUSY_RANK[run.status] < BUSY_RANK[current.status])
      bySession[run.sessionId] = run;
  }
  return bySession;
}

function pollIntervalOf(
  query: Query<ActiveRunsData, Error, ActiveRunsData, readonly unknown[]>,
): number | false {
  const { data, status, error } = query.state;
  if (status === 'error') {
    // Refused credentials: no background renewal can fix them without the
    // user, so polling waits for the next window focus.
    if (isRefusedCredentials(error)) return false;
    return ACTIVE_RUNS_IDLE_POLL_MS;
  }
  // A runtime without the route (it may be upgraded meanwhile).
  if (data?.supported === false) return ACTIVE_RUNS_UNSUPPORTED_REPROBE_MS;
  return data && data.runs.length > 0
    ? ACTIVE_RUNS_BUSY_POLL_MS
    : ACTIVE_RUNS_IDLE_POLL_MS;
}

/** No refetch on focus, mount or reconnect while the runtime lacks the route. */
const unlessUnsupported = (
  query: Query<ActiveRunsData, Error, ActiveRunsData, readonly unknown[]>,
): boolean => query.state.data?.supported !== false;

/**
 * Which of the user's chats on this oracle are running right now, from
 * `GET /runs/active` — for a status on every row of a chat list, whichever
 * client (Portal, Matrix, a channel) sent the message. Task runs are not
 * listed.
 *
 * Polls every 4 s while something runs and every 30 s otherwise (and
 * after a failed poll), only while the tab is visible (TanStack's
 * `refetchIntervalInBackground: false`), plus once when the window regains
 * focus. The polls spend their own per-user budget on the runtime (the
 * `poll` key of `RATE_LIMIT`), apart from the user's messages; every
 * mounted instance runs its own timer, so mount it once per oracle rather
 * than once per row.
 *
 * A poll is a background request: it never mints a delegation (no wallet
 * prompt). When the oracle refuses its credentials even after a fresh
 * invocation, polling pauses until the window is focused again. A runtime
 * that predates the route answers 404 `Run active not found`: polling
 * slows to one probe every 10 min and `isSupported` is `false`.
 *
 * A busy session missing from a loaded `useOracleSessions` list (a chat
 * started elsewhere) refreshes that list once.
 */
export const useActiveRuns = (
  oracleDid: string,
  overrides?: UseActiveRunsOptions,
) => {
  const queryClient = useQueryClient();
  const { wallet, authedRequest } = useOraclesContext();
  const { config } = useOraclesConfig(oracleDid, overrides);
  const apiUrl = overrides?.baseUrl ?? config.apiUrl ?? '';

  const { data, isLoading, error, refetch } = useQuery<
    ActiveRunsData,
    Error,
    ActiveRunsData,
    readonly unknown[]
  >({
    // The user is part of the key: the query client outlives an account
    // switch, and one user's runs are never shown to another.
    queryKey: [...activeRunsQueryKey(oracleDid), wallet?.did],
    queryFn: async () => {
      try {
        const { runs } = await authedRequest<ActiveRunsResponse>(
          `${apiUrl}/runs/active`,
          'GET',
          {},
          oracleDid,
          { background: true },
        );
        return { supported: true, runs };
      } catch (err) {
        if (isUnsupportedAnswer(err)) return { supported: false, runs: [] };
        throw err;
      }
    },
    // Signed out (no wallet): nothing to ask, rather than a failing poll
    // every 30 s.
    enabled: Boolean(apiUrl && oracleDid && wallet?.did),
    retry: false,
    // Fresh for one busy poll, so a focus right after a poll (or a second
    // mount) does not ask again. A number: `@tanstack/react-query` takes a
    // function here only from versions later than this package's floor.
    staleTime: ACTIVE_RUNS_BUSY_POLL_MS,
    refetchInterval: pollIntervalOf,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: unlessUnsupported,
    refetchOnMount: unlessUnsupported,
    refetchOnReconnect: unlessUnsupported,
  });

  const runs = data?.runs ?? NO_RUNS;
  const bySession = useMemo(() => bySessionOf(runs), [runs]);

  // A busy chat the loaded session list lacks was started elsewhere (a
  // Matrix room, a channel, another tab): refresh the list, once per chat.
  const refreshedFor = useRef(new Set<string>());
  useEffect(() => {
    const lists = queryClient.getQueriesData<
      InfiniteData<{ sessions: IChatSession[] }, number>
    >({ queryKey: oracleSessionsQueryKey(oracleDid) });
    const listed = new Set<string>();
    let loaded = false;
    for (const [, list] of lists) {
      if (!list) continue;
      loaded = true;
      for (const page of list.pages)
        for (const session of page.sessions) listed.add(session.sessionId);
    }
    if (!loaded) return;
    const missing = Object.keys(bySession).filter(
      (sessionId) =>
        !listed.has(sessionId) && !refreshedFor.current.has(sessionId),
    );
    if (missing.length === 0) return;
    for (const sessionId of missing) refreshedFor.current.add(sessionId);
    void queryClient.invalidateQueries({
      queryKey: oracleSessionsQueryKey(oracleDid),
    });
  }, [bySession, oracleDid, queryClient]);

  return {
    /** Every active run, oldest first (a session can have a running and queued ones). */
    runs,
    /** The run each busy session is on, by session id. */
    bySession,
    /** How many chats have an active run. */
    count: Object.keys(bySession).length,
    /** False after the runtime answered 404 `Run active not found` (it has no `GET /runs/active`). */
    isSupported: data?.supported !== false,
    isLoading,
    error,
    refetch,
  };
};
