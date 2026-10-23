// @vitest-environment jsdom
import {
  defaultScheduler,
  focusManager,
  notifyManager,
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
} from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthedRequestOptions,
  IOraclesContextProps,
  IWalletProps,
} from '../../providers/oracles-provider/types.js';
import { BACKGROUND_INVOCATION_UNAVAILABLE } from '../../utils/auth-renewal.js';
import { RequestError } from '../../utils/request.js';
import type { IChatSession } from '../use-oracle-sessions/types.js';
import { oracleSessionsQueryKey } from '../use-oracle-sessions/use-oracle-sessions.js';
import {
  isActiveRunStatus,
  isWaitingOnUser,
  type ChatRunSummary,
} from './types.js';
import { useAbortSession } from './use-abort-session.js';
import {
  ACTIVE_RUNS_BUSY_POLL_MS,
  ACTIVE_RUNS_IDLE_POLL_MS,
  ACTIVE_RUNS_UNSUPPORTED_REPROBE_MS,
  activeRunsQueryKey,
  useActiveRuns,
} from './use-active-runs.js';

const ORACLE = 'did:ixo:oracle';
const BASE_URL = 'https://oracle.test';

vi.mock('@ixo/oracles-chain-client/react', () => ({
  Authz: { getOracleAuthZConfig: async () => ({}) },
  gqlClient: {
    GetEntityById: async () => ({
      entity: {
        service: [
          { id: '{id}#api', type: 'oracleService', serviceEndpoint: BASE_URL },
        ],
      },
    }),
  },
}));

let context: IOraclesContextProps;
vi.mock('../../providers/oracles-provider/oracles-context.js', () => ({
  useOraclesContext: () => context,
}));

type Call = {
  url: string;
  method: string;
  body?: unknown;
  requestOptions?: AuthedRequestOptions;
};

const WALLET: IWalletProps = {
  did: 'did:ixo:user',
  address: 'ixo1user',
  matrix: { accessToken: 'mx', homeServer: 'hs' },
};

/**
 * An `authedRequest` that answers `GET /runs/active` from `answers` in turn
 * (the last one repeats; an Error is thrown) and `POST /messages/abort`
 * with `abort()` (default `{ success: true }`), through a JSON round trip.
 */
function oracle(
  answers: Array<ChatRunSummary[] | Error>,
  o: {
    wallet?: IWalletProps | null;
    abort?: () => Promise<{ success: boolean }>;
  } = {},
) {
  const calls: Call[] = [];
  let next = 0;
  const authedRequest = async <T,>(
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    options?: RequestInit,
    _oracleDid?: string,
    requestOptions?: AuthedRequestOptions,
  ): Promise<T> => {
    calls.push({
      url,
      method,
      ...(typeof options?.body === 'string'
        ? { body: JSON.parse(options.body) as unknown }
        : {}),
      ...(requestOptions ? { requestOptions } : {}),
    });
    if (url.endsWith('/messages/abort'))
      return new Response(
        JSON.stringify(await (o.abort?.() ?? { success: true })),
      ).json();
    const answer = answers[Math.min(next, answers.length - 1)]!;
    next += 1;
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ runs: answer })).json();
  };
  context = {
    wallet: o.wallet === undefined ? WALLET : o.wallet,
    transactSignX: vi.fn(),
    authedRequest,
    getDelegation: vi.fn(async () => 'delegation'),
    getInvocation: vi.fn(async () => null),
    renewOracleAuth: vi.fn(async () => true),
    agActions: [],
    registeredAgActions: [],
    registerAgAction: vi.fn(),
    unregisterAgAction: vi.fn(),
    executeAgAction: vi.fn(),
    getAgActionRender: vi.fn(),
  };
  const polls = () => calls.filter((c) => c.url.endsWith('/runs/active'));
  return { calls, polls };
}

function run(
  runId: string,
  sessionId: string,
  status: ChatRunSummary['status'] = 'running',
  startedAt = '2026-10-21T10:00:00.000Z',
): ChatRunSummary {
  return {
    runId,
    sessionId,
    requestId: `req-${runId}`,
    client: 'portal',
    status,
    startedAt,
    updatedAt: startedAt,
    lastSeq: 0,
  };
}

/** The provider's query defaults (60 s stale, no focus refetch): the hook overrides both. */
const providerLikeClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: false },
    },
  });

function wrapper(client = providerLikeClient()) {
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** A loaded `useOracleSessions` list in the cache, as its query keeps it. */
function seedSessionList(client: QueryClient, sessionIds: string[]) {
  const data: InfiniteData<{ sessions: IChatSession[]; total: number }> = {
    pages: [
      {
        sessions: sessionIds.map((sessionId) => ({
          sessionId,
          title: sessionId,
          createdAt: '2026-10-21T10:00:00.000Z',
          lastUpdatedAt: '2026-10-21T10:00:00.000Z',
          oracleName: 'Test',
        })),
        total: sessionIds.length,
      },
    ],
    pageParams: [0],
  };
  client.setQueryData(
    [...oracleSessionsQueryKey(ORACLE), 20, WALLET.did],
    data,
  );
}

/** Toggle the tab away and back: TanStack refetches on the regained focus. */
const refocus = () =>
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });

/** Let fake time pass (0 = settle the pending promises). */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

// Fake time drives the poll interval. TanStack delivers results to React
// through its notify scheduler (a zero timeout by default), which would
// land one advance late: results are delivered on a microtask instead.
// The tab starts visible and focused.
beforeEach(() => {
  vi.useFakeTimers();
  notifyManager.setScheduler((callback) => queueMicrotask(callback));
  focusManager.setFocused(true);
});
afterEach(() => {
  focusManager.setFocused(undefined);
  notifyManager.setScheduler(defaultScheduler);
  vi.useRealTimers();
});

describe('useActiveRuns', () => {
  it("passes a run's waitingFor through to runs and bySession", async () => {
    const waiting: ChatRunSummary = {
      ...run('r1', 's1'),
      waitingFor: {
        kind: 'browser',
        toolName: 'propose_topic',
        since: '2026-10-21T10:00:05.000Z',
      },
    };
    oracle([[waiting, run('r2', 's2')]]);
    const { result } = renderHook(
      () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
      { wrapper: wrapper() },
    );
    await advance(0);
    expect(result.current.runs[0]).toEqual(waiting);
    expect(isWaitingOnUser(result.current.bySession['s1'])).toBe(true);
    expect(isWaitingOnUser(result.current.bySession['s2'])).toBe(false);
  });

  it('polls every 4 s while a chat is running and every 30 s once none is', async () => {
    const { polls } = oracle([[run('r1', 's1')], []]);
    const { result } = renderHook(
      () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
      { wrapper: wrapper() },
    );
    await advance(0);
    expect(polls()).toHaveLength(1);
    expect(polls()[0]).toMatchObject({
      url: `${BASE_URL}/runs/active`,
      method: 'GET',
    });
    expect(result.current.count).toBe(1);

    await advance(ACTIVE_RUNS_BUSY_POLL_MS);
    expect(polls()).toHaveLength(2);
    expect(result.current.runs).toEqual([]);
    expect(result.current.count).toBe(0);

    // Nothing runs now: the next poll is 30 s after the last one.
    await advance(ACTIVE_RUNS_IDLE_POLL_MS - 1_000);
    expect(polls()).toHaveLength(2);
    await advance(1_000);
    expect(polls()).toHaveLength(3);
  });

  it('does not poll while the tab is hidden, and asks again when it is focused', async () => {
    const { polls } = oracle([[run('r1', 's1')]]);
    renderHook(() => useActiveRuns(ORACLE, { baseUrl: BASE_URL }), {
      wrapper: wrapper(),
    });
    await advance(0);
    expect(polls()).toHaveLength(1);
    act(() => focusManager.setFocused(false));
    await advance(ACTIVE_RUNS_IDLE_POLL_MS * 4);
    expect(polls()).toHaveLength(1);
    act(() => focusManager.setFocused(true));
    await advance(0);
    expect(polls()).toHaveLength(2);
  });

  it("on an older runtime's 404 (`Run active not found`) reports isSupported false and probes again only after 10 min", async () => {
    const { polls } = oracle([
      new RequestError('Run active not found', { status: 404 }),
      [run('r1', 's1')],
    ]);
    const { result } = renderHook(
      () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
      { wrapper: wrapper() },
    );
    await advance(0);
    expect(result.current.isSupported).toBe(false);
    expect(result.current.runs).toEqual([]);
    expect(result.current.error).toBeNull();
    // Not on focus either.
    await refocus();
    await advance(ACTIVE_RUNS_UNSUPPORTED_REPROBE_MS - 1_000);
    expect(polls()).toHaveLength(1);
    // The runtime was upgraded meanwhile.
    await advance(1_000);
    expect(polls()).toHaveLength(2);
    expect(result.current.isSupported).toBe(true);
    expect(result.current.count).toBe(1);
  });

  it('treats any other 404 (a wrong base URL, the generic not-found) as a failed poll, not as unsupported', async () => {
    const { polls } = oracle([
      new RequestError('Cannot GET /runs/active/', { status: 404 }),
    ]);
    const { result } = renderHook(
      () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
      { wrapper: wrapper() },
    );
    await advance(0);
    expect(result.current.isSupported).toBe(true);
    expect(result.current.error).toBeInstanceOf(RequestError);
    await advance(ACTIVE_RUNS_IDLE_POLL_MS);
    expect(polls()).toHaveLength(2);
  });

  it.each([401, 403])(
    'on a credential refusal (%i) pauses polling until the window is focused again, still supported',
    async (status) => {
      const { polls } = oracle([
        new RequestError('Invalid UCAN invocation', { status }),
        [run('r1', 's1')],
      ]);
      const { result } = renderHook(
        () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
        { wrapper: wrapper() },
      );
      await advance(0);
      expect(result.current.isSupported).toBe(true);
      expect(result.current.error).toBeInstanceOf(RequestError);
      await advance(ACTIVE_RUNS_IDLE_POLL_MS * 4);
      expect(polls()).toHaveLength(1);
      await refocus();
      await advance(0);
      expect(polls()).toHaveLength(2);
      expect(result.current.count).toBe(1);
      // Polling resumes after the refocus succeeded.
      await advance(ACTIVE_RUNS_BUSY_POLL_MS);
      expect(polls()).toHaveLength(3);
    },
  );

  it('pauses, without prompting, when the host cannot mint an invocation without the user, and resumes on focus', async () => {
    const { polls } = oracle([
      new RequestError('No invocation could be minted without the user', {
        status: 401,
        code: BACKGROUND_INVOCATION_UNAVAILABLE,
      }),
      [run('r1', 's1')],
    ]);
    const { result } = renderHook(
      () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
      { wrapper: wrapper() },
    );
    await advance(0);
    expect(result.current.isSupported).toBe(true);
    expect(result.current.error).toMatchObject({
      code: BACKGROUND_INVOCATION_UNAVAILABLE,
    });
    await advance(ACTIVE_RUNS_IDLE_POLL_MS * 4);
    expect(polls()).toHaveLength(1);
    await refocus();
    await advance(0);
    expect(polls()).toHaveLength(2);
    expect(result.current.count).toBe(1);
  });

  it('polls as a background request (no delegation mint, no wallet prompt)', async () => {
    const { polls } = oracle([[]]);
    renderHook(() => useActiveRuns(ORACLE, { baseUrl: BASE_URL }), {
      wrapper: wrapper(),
    });
    await advance(0);
    expect(polls()[0]?.requestOptions).toEqual({ background: true });
  });

  it('does not poll without a signed-in wallet', async () => {
    const { polls } = oracle([[]], { wallet: null });
    renderHook(() => useActiveRuns(ORACLE, { baseUrl: BASE_URL }), {
      wrapper: wrapper(),
    });
    await advance(ACTIVE_RUNS_IDLE_POLL_MS * 2);
    expect(polls()).toEqual([]);
  });

  it('refreshes a loaded session list once when a busy chat is missing from it', async () => {
    oracle([[run('r1', 'listed'), run('r2', 'started-elsewhere')]]);
    const client = providerLikeClient();
    seedSessionList(client, ['listed']);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderHook(() => useActiveRuns(ORACLE, { baseUrl: BASE_URL }), {
      wrapper: wrapper(client),
    });
    await advance(0);
    await advance(ACTIVE_RUNS_BUSY_POLL_MS * 3);
    const sessionRefreshes = invalidate.mock.calls.filter(
      ([filters]) => filters?.queryKey?.[0] === 'oracle-sessions',
    );
    expect(sessionRefreshes).toHaveLength(1);
  });

  it('keeps polling at the idle cadence after a failed poll', async () => {
    const { polls } = oracle([
      [run('r1', 's1')],
      new RequestError('Rate limit exceeded', { status: 429 }),
      [run('r1', 's1')],
    ]);
    const { result } = renderHook(
      () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
      { wrapper: wrapper() },
    );
    await advance(0);
    await advance(ACTIVE_RUNS_BUSY_POLL_MS);
    expect(polls()).toHaveLength(2);
    expect(result.current.error).toBeInstanceOf(RequestError);
    expect(result.current.isSupported).toBe(true);
    await advance(ACTIVE_RUNS_BUSY_POLL_MS);
    expect(polls()).toHaveLength(2);
    await advance(ACTIVE_RUNS_IDLE_POLL_MS - ACTIVE_RUNS_BUSY_POLL_MS);
    expect(polls()).toHaveLength(3);
  });

  it('keys bySession by session id, with the busy run of a session over its queued one', async () => {
    oracle([
      [
        run('q1', 's1', 'queued', '2026-10-21T10:00:00.000Z'),
        run('r1', 's1', 'running', '2026-10-21T10:00:01.000Z'),
        run('q2', 's2', 'queued', '2026-10-21T10:00:02.000Z'),
        run('q3', 's2', 'queued', '2026-10-21T10:00:03.000Z'),
        run('m1', '$thread', 'recovering', '2026-10-21T10:00:04.000Z'),
      ],
    ]);
    const { result } = renderHook(
      () => useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
      { wrapper: wrapper() },
    );
    await advance(0);
    expect(result.current.runs).toHaveLength(5);
    expect(
      Object.fromEntries(
        Object.entries(result.current.bySession).map(([id, r]) => [
          id,
          r.runId,
        ]),
      ),
    ).toEqual({ s1: 'r1', s2: 'q2', $thread: 'm1' });
    expect(result.current.count).toBe(3);
  });
});

describe('useAbortSession', () => {
  /** An abort answer the test settles. */
  function pendingAbort() {
    let settle!: (outcome: { success: boolean } | Error) => void;
    const answer = new Promise<{ success: boolean }>((resolve, reject) => {
      settle = (outcome) =>
        outcome instanceof Error ? reject(outcome) : resolve(outcome);
    });
    return { abort: () => answer, settle };
  }

  it('drops the session from the active runs at once, posts the abort, then refreshes the runs and the session lists', async () => {
    const pending = pendingAbort();
    const { calls, polls } = oracle(
      [[run('r1', 's-other'), run('r2', 's-mine')], [run('r2', 's-mine')]],
      { abort: pending.abort },
    );
    const client = providerLikeClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () => ({
        active: useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
        abort: useAbortSession(ORACLE, { baseUrl: BASE_URL }),
      }),
      { wrapper: wrapper(client) },
    );
    await advance(0);
    expect(result.current.active.count).toBe(2);
    let aborting!: Promise<{ success: boolean }>;
    act(() => {
      aborting = result.current.abort.abortSession('s-other');
    });
    await advance(0);
    // Gone from the list while the runtime is still stopping it.
    expect(Object.keys(result.current.active.bySession)).toEqual(['s-mine']);
    pending.settle({ success: true });
    await act(async () => {
      expect(await aborting).toEqual({ success: true });
    });
    expect(calls.find((c) => c.url.endsWith('/messages/abort'))).toEqual({
      url: `${BASE_URL}/messages/abort`,
      method: 'POST',
      body: { sessionId: 's-other' },
    });
    await advance(0);
    expect(polls()).toHaveLength(2);
    expect(result.current.active.count).toBe(1);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      expect.arrayContaining([
        activeRunsQueryKey(ORACLE),
        oracleSessionsQueryKey(ORACLE),
      ]),
    );
  });

  it('puts the session back when the abort request fails', async () => {
    const pending = pendingAbort();
    oracle([[run('r1', 's-other')]], { abort: pending.abort });
    const { result } = renderHook(
      () => ({
        active: useActiveRuns(ORACLE, { baseUrl: BASE_URL }),
        abort: useAbortSession(ORACLE, { baseUrl: BASE_URL }),
      }),
      { wrapper: wrapper() },
    );
    await advance(0);
    let aborting!: Promise<unknown>;
    act(() => {
      aborting = result.current.abort
        .abortSession('s-other')
        .catch((error: unknown) => error);
    });
    await advance(0);
    expect(result.current.active.count).toBe(0);
    pending.settle(new Error('network down'));
    await act(async () => {
      expect(await aborting).toBeInstanceOf(Error);
    });
    expect(Object.keys(result.current.active.bySession)).toEqual(['s-other']);
  });
});

describe('isActiveRunStatus', () => {
  it('is true for queued, running and recovering only', () => {
    for (const status of ['queued', 'running', 'recovering'])
      expect(isActiveRunStatus(status)).toBe(true);
    for (const status of [
      'finished',
      'aborted',
      'interrupted',
      'failed',
      'unknown',
      '',
      null,
      undefined,
    ])
      expect(isActiveRunStatus(status)).toBe(false);
  });
});

describe('isWaitingOnUser', () => {
  const waitingFor = {
    kind: 'browser',
    toolName: 'propose_topic',
    since: '2026-10-21T10:00:05.000Z',
  } as const;

  it('is true for an active run with a well-formed waitingFor, browser or agui', () => {
    for (const status of ['queued', 'running', 'recovering'] as const)
      expect(isWaitingOnUser({ status, waitingFor })).toBe(true);
    expect(
      isWaitingOnUser({
        status: 'running',
        waitingFor: { ...waitingFor, kind: 'agui' },
      }),
    ).toBe(true);
  });

  it('is false without waitingFor, for an ended run, and for no run', () => {
    expect(isWaitingOnUser(run('r1', 's1'))).toBe(false);
    for (const status of [
      'finished',
      'aborted',
      'interrupted',
      'failed',
    ] as const)
      expect(isWaitingOnUser({ status, waitingFor })).toBe(false);
    expect(isWaitingOnUser(null)).toBe(false);
    expect(isWaitingOnUser(undefined)).toBe(false);
  });

  it('treats a malformed waitingFor from the wire as not waiting', () => {
    // What a JSON body can hold where the type says `waitingFor`.
    const malformed: unknown[] = [
      null,
      'browser',
      {},
      { ...waitingFor, kind: 'wallet' },
      { ...waitingFor, toolName: '' },
      { ...waitingFor, toolName: 7 },
      { kind: 'browser', toolName: 'propose_topic' },
      { ...waitingFor, since: '' },
    ];
    for (const value of malformed) {
      const parsed: ChatRunSummary = JSON.parse(
        JSON.stringify({ ...run('r1', 's1'), waitingFor: value }),
      );
      expect(isWaitingOnUser(parsed)).toBe(false);
    }
  });

  it('narrows the run so waitingFor can be read without a check', () => {
    const summary: ChatRunSummary = { ...run('r1', 's1'), waitingFor };
    if (!isWaitingOnUser(summary)) throw new Error('expected a waiting run');
    const { toolName }: { toolName: string } = summary.waitingFor;
    expect(toolName).toBe('propose_topic');
    expect(summary.runId).toBe('r1');
  });
});
