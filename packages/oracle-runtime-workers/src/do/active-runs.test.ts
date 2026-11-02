import { describe, expect, it } from 'vitest';
import {
  activeChatRuns,
  activeRunBySession,
  activeRunSummaryOf,
  listedChatRuns,
  storedTurnRoomId,
  withActiveRuns,
  withWaitingFor,
  type ParkedCallLookup,
} from './active-runs';
import type { SessionSummary } from './contracts';
import { runSummaryOf } from './run-request';
import type { RunRecord } from './run-store';

const T0 = Date.parse('2026-10-21T10:00:00.000Z');

function run(
  runId: string,
  over: Partial<RunRecord> & { at?: number } = {},
): RunRecord {
  const { at = 0, ...rest } = over;
  const iso = new Date(T0 + at).toISOString();
  return {
    runId,
    sessionId: `s-${runId}`,
    requestId: `req-${runId}`,
    client: 'portal',
    status: 'running',
    startedAt: iso,
    updatedAt: iso,
    request: '{}',
    attempts: 0,
    generation: 0,
    nextAttemptAt: null,
    checkpointId: null,
    startCheckpointId: null,
    startRecorded: true,
    lastSeq: 0,
    partialText: null,
    messageId: null,
    error: null,
    taskRunId: null,
    instanceId: 'i1',
    usage: null,
    ...rest,
  };
}

const session = (sessionId: string): SessionSummary => ({
  sessionId,
  title: sessionId,
  createdAt: new Date(T0).toISOString(),
  lastUpdatedAt: new Date(T0).toISOString(),
});

describe('activeChatRuns', () => {
  it('lists a run held live and stored once, with the live record', () => {
    const stored = run('a', { status: 'queued', updatedAt: 'stored' });
    const live = run('a', { status: 'running', updatedAt: 'live' });
    const runs = activeChatRuns([live], [stored]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'running', updatedAt: 'live' });
  });

  it('breaks a tie on startedAt by run id', () => {
    const runs = activeChatRuns(
      [run('b'), run('c')],
      [run('a'), run('early', { at: -1 })],
    );
    expect(runs.map((r) => r.runId)).toEqual(['early', 'a', 'b', 'c']);
  });

  it('never lists finished, aborted, interrupted or failed runs', () => {
    const ended = (
      ['finished', 'aborted', 'interrupted', 'failed'] as const
    ).map((status) => run(status, { status }));
    expect(activeChatRuns(ended, ended)).toEqual([]);
  });

  it('leaves task runs out and keeps Matrix and channel runs in', () => {
    const runs = activeChatRuns(
      [run('task', { sessionId: 'task:t1' })],
      [
        run('matrix', { client: 'matrix', sessionId: '$root', at: 2 }),
        run('channel', { client: 'channel', at: 3 }),
        run('portal', { at: 1 }),
      ],
    );
    expect(runs.map((r) => r.runId)).toEqual(['portal', 'matrix', 'channel']);
  });

  it('lists live-only and stored-only runs together, oldest first', () => {
    const runs = activeChatRuns(
      [run('live-new', { at: 30 }), run('live-old', { at: 10 })],
      [run('stored', { status: 'recovering', at: 20 })],
    );
    expect(runs.map((r) => r.runId)).toEqual([
      'live-old',
      'stored',
      'live-new',
    ]);
  });
});

describe('activeRunBySession', () => {
  it('picks the running or recovering run of a session over a queued one, else the oldest queued', () => {
    const bySession = activeRunBySession(
      activeChatRuns(
        [],
        [
          run('q-old', { sessionId: 's1', status: 'queued', at: 1 }),
          run('busy', { sessionId: 's1', status: 'recovering', at: 2 }),
          run('q-new', { sessionId: 's1', status: 'queued', at: 3 }),
          run('q2-old', { sessionId: 's2', status: 'queued', at: 4 }),
          run('q2-new', { sessionId: 's2', status: 'queued', at: 5 }),
        ],
      ),
    );
    expect(bySession.get('s1')?.runId).toBe('busy');
    expect(bySession.get('s2')?.runId).toBe('q2-old');
    expect(bySession.size).toBe(2);
  });
});

describe('activeRunSummaryOf', () => {
  it('leaves the kept reply text out', () => {
    const summary = activeRunSummaryOf(
      run('a', { status: 'recovering', partialText: 'Half a reply' }),
    );
    expect(summary).not.toHaveProperty('partialText');
    expect(summary).toMatchObject({ runId: 'a', status: 'recovering' });
  });
});

describe('withActiveRuns', () => {
  it('sets activeRun only on rows with an active run, and no field at all on the others', () => {
    const rows = withActiveRuns(
      [session('busy'), session('idle')],
      [run('r1', { sessionId: 'busy', partialText: 'so far' })],
    );
    expect(rows[0]?.activeRun).toMatchObject({
      runId: 'r1',
      sessionId: 'busy',
      status: 'running',
    });
    expect(rows[0]?.activeRun).not.toHaveProperty('partialText');
    expect(rows[1]).not.toHaveProperty('activeRun');
    expect(rows[1]).toEqual(session('idle'));
    // The JSON a client receives carries no `activeRun` key either.
    expect(JSON.parse(JSON.stringify(rows[1]))).not.toHaveProperty('activeRun');
  });
});

describe('waitingFor', () => {
  const since = new Date(T0 + 5_000).toISOString();
  const parked: ParkedCallLookup = (sessionId) =>
    sessionId === 'busy'
      ? { kind: 'browser', toolName: 'mutate_topic', since }
      : null;

  it('marks the executing run of a session with a parked call, on summaries and session rows', () => {
    expect(
      activeRunSummaryOf(run('r1', { sessionId: 'busy' }), parked),
    ).toMatchObject({
      runId: 'r1',
      waitingFor: { kind: 'browser', toolName: 'mutate_topic', since },
    });
    expect(
      activeRunSummaryOf(
        run('r2', { sessionId: 'busy', status: 'recovering' }),
        parked,
      ).waitingFor,
    ).toMatchObject({ toolName: 'mutate_topic' });
    const rows = withActiveRuns(
      [session('busy'), session('idle')],
      [
        run('r1', { sessionId: 'busy' }),
        run('r3', { sessionId: 'idle', at: 1 }),
      ],
      parked,
    );
    expect(rows[0]?.activeRun?.waitingFor).toEqual({
      kind: 'browser',
      toolName: 'mutate_topic',
      since,
    });
    expect(rows[1]?.activeRun).not.toHaveProperty('waitingFor');
    // The session's own run route (`runSummaryOf` keeps its reply text).
    expect(
      withWaitingFor(
        runSummaryOf(run('r1', { sessionId: 'busy', partialText: 'so far' })),
        parked,
      ),
    ).toMatchObject({ partialText: 'so far', waitingFor: { since } });
  });

  it('never marks a queued run or one that is over (only the executing one can have made the call), nor without a lookup', () => {
    for (const status of [
      'queued',
      'finished',
      'aborted',
      'interrupted',
      'failed',
    ] as const)
      expect(
        activeRunSummaryOf(run('q', { sessionId: 'busy', status }), parked),
      ).not.toHaveProperty('waitingFor');
    expect(
      activeRunSummaryOf(run('r1', { sessionId: 'busy' })),
    ).not.toHaveProperty('waitingFor');
    expect(
      JSON.parse(
        JSON.stringify(
          activeRunSummaryOf(run('r4', { sessionId: 'x' }), parked),
        ),
      ),
    ).not.toHaveProperty('waitingFor');
  });
});

describe('listedChatRuns', () => {
  const request = (roomId?: string) =>
    JSON.stringify({ turn: { sessionId: 's', ...(roomId ? { roomId } : {}) } });

  it('keeps only the runs of sessions in the main room, placing a session without a row by its request', () => {
    const runs = [
      run('main-row', { sessionId: 'main' }),
      run('other-row', { sessionId: 'other' }),
      run('null-room-row', { sessionId: 'roomless' }),
      run('thread-main', {
        sessionId: '$t1',
        client: 'matrix',
        request: request('!main'),
      }),
      run('thread-other', {
        sessionId: '$t2',
        client: 'matrix',
        request: request('!other'),
      }),
      run('portal-no-row', { sessionId: 's-new' }),
      run('channel-no-row', { sessionId: 'c-new', client: 'channel' }),
    ];
    const listed = listedChatRuns(runs, {
      mainRoomId: '!main',
      sessionRooms: new Map<string, string | null>([
        ['main', '!main'],
        ['other', '!other'],
        ['roomless', null],
      ]),
    });
    expect(listed.map((r) => r.runId)).toEqual([
      'main-row',
      'thread-main',
      'portal-no-row',
    ]);
  });

  it('lists every chat when the user has no main room', () => {
    const runs = [run('a', { client: 'matrix', request: request('!any') })];
    expect(
      listedChatRuns(runs, { mainRoomId: null, sessionRooms: new Map() }),
    ).toEqual(runs);
  });
});

describe('storedTurnRoomId', () => {
  it("reads the stored turn's room and tolerates anything else", () => {
    expect(storedTurnRoomId('{"turn":{"roomId":"!r"}}')).toBe('!r');
    expect(storedTurnRoomId('{"turn":{}}')).toBeUndefined();
    expect(storedTurnRoomId('{"turn":{"roomId":7}}')).toBeUndefined();
    expect(storedTurnRoomId('{}')).toBeUndefined();
    expect(storedTurnRoomId('not json')).toBeUndefined();
  });
});
