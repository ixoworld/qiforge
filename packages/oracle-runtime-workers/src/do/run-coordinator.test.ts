import { describe, expect, it } from 'vitest';
import { createSseSubscriberStream } from './sse-stream';
import type { Logger } from '../plugin-api/types';
import type { PackedSegment, RunFrame } from './run-buffer';
import {
  RunAttemptDeferred,
  RunCoordinator,
  type LiveRun,
  type RunCoordinatorHost,
  type RunCoordinatorStore,
  type RunOutcome,
} from './run-coordinator';
import {
  attemptSeqBase,
  type RunDurabilityConfig,
  type RunRecord,
  type RunStatus,
} from './run-store';

const T0 = Date.parse('2026-09-13T10:00:00.000Z');
const SESSION = 'sess-1';

const CONFIG: RunDurabilityConfig = {
  keepAliveMs: 20_000,
  segmentFlushMs: 20,
  segmentBytes: 16 * 1024,
  recoveryAttempts: 4,
  recoveryDelaysMs: [5_000, 15_000, 30_000, 60_000],
  multitaskDefault: 'interrupt',
};

const silent: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let the buffer's flush timer fire and the pack settle. */
const flushed = () => pause(CONFIG.segmentFlushMs * 3);
/** `done` resolves before the run's row is closed and the queue advanced: let that finish. */
const settled = () => pause(0);

/** The store the coordinator sees, in memory, with the SQL store's ordering rules. */
class MemoryRunStore implements RunCoordinatorStore {
  readonly rows = new Map<string, RunRecord>();

  readonly segments = new Map<string, Map<number, PackedSegment>>();

  /** Segment writes wait for this (a slow statement queue). */
  appendHold: Promise<void> | null = null;

  /** Segment reads wait for this. */
  readHold: Promise<void> | null = null;

  /** Runs before every row update lands (to interleave an abort). */
  onUpdate: ((runId: string) => void) | null = null;

  constructor(private readonly clock: () => number) {}

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }

  seed(record: Partial<RunRecord> & Pick<RunRecord, 'runId'>): RunRecord {
    const row: RunRecord = {
      sessionId: SESSION,
      requestId: `req-${record.runId}`,
      client: 'portal',
      status: 'running',
      startedAt: this.iso(),
      updatedAt: this.iso(),
      request: '{}',
      attempts: 0,
      generation: 0,
      nextAttemptAt: null,
      checkpointId: null,
      // A seeded row is a legacy one (no recorded start) unless the test
      // says otherwise; `create` records the start like the SQL store.
      startCheckpointId: null,
      startRecorded: false,
      lastSeq: 0,
      partialText: null,
      messageId: null,
      error: null,
      usage: null,
      taskRunId: null,
      instanceId: 'old-instance',
      ...record,
    };
    this.rows.set(row.runId, row);
    return row;
  }

  async create(
    input: Parameters<RunCoordinatorStore['create']>[0],
  ): Promise<RunRecord> {
    const row = this.seed({
      runId: input.runId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      client: input.client,
      status: input.status,
      request: input.request,
      checkpointId: input.checkpointId,
      startCheckpointId: input.checkpointId,
      startRecorded: true,
      taskRunId: input.taskRunId ?? null,
      instanceId: input.instanceId,
    });
    return { ...row };
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const row = this.rows.get(runId);
    return row ? { ...row } : undefined;
  }

  async update(
    runId: string,
    patch: Parameters<RunCoordinatorStore['update']>[1],
  ): Promise<string> {
    this.onUpdate?.(runId);
    const updatedAt = this.iso();
    const row = this.rows.get(runId);
    if (!row) return updatedAt;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    this.rows.set(runId, {
      ...row,
      ...defined,
      ...(patch.startCheckpointId !== undefined ? { startRecorded: true } : {}),
      updatedAt,
    });
    return updatedAt;
  }

  async close(
    runId: string,
    patch: Parameters<RunCoordinatorStore['close']>[1],
  ): Promise<string> {
    const updatedAt = await this.update(runId, patch);
    await this.deleteSegments(runId);
    return updatedAt;
  }

  async listActive(): Promise<RunRecord[]> {
    const active: RunStatus[] = ['queued', 'running', 'recovering'];
    return [...this.rows.values()]
      .filter((r) => active.includes(r.status))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((r) => ({ ...r }));
  }

  async appendSegment(runId: string, segment: PackedSegment): Promise<void> {
    if (this.appendHold) await this.appendHold;
    let per = this.segments.get(runId);
    if (!per) {
      per = new Map();
      this.segments.set(runId, per);
    }
    per.set(segment.seqFrom, segment);
  }

  async readSegments(runId: string, after = 0): Promise<PackedSegment[]> {
    if (this.readHold) await this.readHold;
    return [...(this.segments.get(runId)?.values() ?? [])]
      .filter((s) => s.seqTo > after)
      .sort((a, b) => a.seqFrom - b.seqFrom);
  }

  async deleteSegments(runId: string): Promise<void> {
    this.segments.delete(runId);
  }

  /** Pack frames as an earlier incarnation would have. */
  pack(runId: string, frames: RunFrame[]): void {
    void this.appendSegment(runId, {
      seqFrom: frames[0]!.seq,
      seqTo: frames[frames.length - 1]!.seq,
      payload: JSON.stringify(frames),
    });
  }
}

interface Attempt {
  live: LiveRun;
  resumed: boolean;
  finish: (outcome: RunOutcome) => void;
  /** The attempt throws (an internal fault, or a deferral). */
  fail: (error: unknown) => void;
}

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The frames an SSE body carried, decoded. */
async function sseFrames(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await new Response(stream).text();
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const lines = block.split('\n');
      const event = lines[0]!.slice('event: '.length);
      const data = lines.find((l) => l.startsWith('data: '))!;
      return {
        event,
        data: JSON.parse(data.slice('data: '.length)) as Record<
          string,
          unknown
        >,
      };
    });
}

function harness(
  overrides: Partial<RunDurabilityConfig> = {},
  options: { graceMs?: number } = {},
) {
  let now = T0;
  const store = new MemoryRunStore(() => now);
  const alarms: number[] = [];
  const ended: Array<{ record: RunRecord; outcome: RunOutcome }> = [];
  const attempts: Attempt[] = [];
  /** Runs whose attempt ignores its abort signal (a slow wind-down). */
  const stubborn = new Set<string>();
  let checkpoint: string | null = 'cp1';
  const host: RunCoordinatorHost = {
    store,
    config: { ...CONFIG, ...overrides },
    instanceId: 'new-instance',
    log: silent,
    now: () => now,
    requestAlarm: (at) => alarms.push(at),
    // Each attempt is scripted by the test: it runs until `finish` is called
    // or the run's abort signal fires (then it reports `aborted`).
    runAttempt: (live, resumed) =>
      new Promise<RunOutcome>((resolve, reject) => {
        attempts.push({ live, resumed, finish: resolve, fail: reject });
        if (!stubborn.has(live.runId))
          live.abort.signal.addEventListener('abort', () =>
            resolve({ status: 'aborted', text: live.continuation ?? '' }),
          );
      }),
    checkpointIdOf: async () => checkpoint,
    onRunEnded: async (record, outcome) => {
      ended.push({ record, outcome });
    },
    ...(options.graceMs !== undefined
      ? { supersedeGraceMs: options.graceMs }
      : {}),
  };
  const runs = new RunCoordinator(host);
  let seq = 0;
  const begin = (
    runId: string,
    multitask: 'interrupt' | 'enqueue' = 'interrupt',
    sessionId = SESSION,
  ) =>
    runs.begin({
      runId,
      sessionId,
      requestId: `req-${runId}-${++seq}`,
      client: 'portal',
      request: '{}',
      multitask,
    });
  return {
    runs,
    host,
    store,
    alarms,
    ended,
    attempts,
    stubborn,
    begin,
    tick: (ms: number) => {
      now += ms;
      return now;
    },
    get now() {
      return now;
    },
    setCheckpoint: (id: string | null) => {
      checkpoint = id;
    },
  };
}

describe('RunCoordinator', () => {
  it('streams a run into its buffer, packs segments, and closes it finished with the segments dropped', async () => {
    const h = harness();
    const { live, queued } = await h.begin('r1');
    expect(queued).toBe(false);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]!.resumed).toBe(false);
    live.buffer.push('run', { runId: 'r1' });
    live.buffer.push('message', { content: 'Hello ' });
    live.buffer.push('message', { content: 'world' });
    await flushed();
    expect(await h.store.readSegments('r1')).not.toHaveLength(0);
    h.attempts[0]!.finish({
      status: 'finished',
      text: 'Hello world',
      messageId: 'm1',
    });
    const outcome = await live.done;
    await settled();
    expect(outcome.status).toBe('finished');
    expect(await h.store.get('r1')).toMatchObject({
      status: 'finished',
      // The three frames, then the `done` the coordinator closes with (the
      // scripted attempt did not push one).
      lastSeq: 4,
      partialText: null,
      messageId: 'm1',
    });
    expect(await h.store.readSegments('r1')).toHaveLength(0);
    expect(h.ended.map((e) => e.outcome.status)).toEqual(['finished']);
    expect(h.runs.size).toBe(0);
  });

  it('re-joins after a cursor with exactly the later frames — packed segments, then the unpacked tail, then live', async () => {
    const h = harness();
    const { live } = await h.begin('r1');
    for (let i = 1; i <= 5; i += 1)
      live.buffer.push('message', { content: String(i) });
    await flushed();
    live.buffer.push('message', { content: '6' });
    live.buffer.push('message', { content: '7' });
    const joined = await h.runs.join('r1', 3);
    expect(joined?.replay.map((f) => f.seq)).toEqual([4, 5, 6, 7]);
    const seen: number[] = [];
    joined!.buffer!.subscribe((f) => seen.push(f.seq));
    live.buffer.push('message', { content: '8' });
    expect(seen).toEqual([8]);
    expect(await h.runs.join('nope', 0)).toBeUndefined();
    h.attempts[0]!.finish({ status: 'finished', text: '12345678' });
    await live.done;
    await settled();
    // An ended run replays nothing (cutover) and has no buffer.
    const after = await h.runs.join('r1', 0);
    expect(after?.replay).toEqual([]);
    expect(after?.buffer).toBeUndefined();
  });

  it('interrupt rule: a new message aborts the running turn (and drops the queue behind it) before it starts', async () => {
    const h = harness();
    const a = await h.begin('a');
    const b = await h.begin('b', 'enqueue');
    expect(b.queued).toBe(true);
    const c = await h.begin('c');
    expect(c.queued).toBe(false);
    expect(a.live.abort.signal.aborted).toBe(true);
    expect((a.live.abort.signal.reason as Error).message).toBe(
      'run aborted (superseded)',
    );
    expect((await a.live.done).status).toBe('aborted');
    expect((await b.live.done).status).toBe('aborted');
    expect((await h.store.get('b'))?.status).toBe('aborted');
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'c']);
    expect(h.runs.activeForSession(SESSION)?.runId).toBe('c');
  });

  it('enqueue rule: the new message waits and starts when the running turn ends', async () => {
    const h = harness();
    const a = await h.begin('a');
    const b = await h.begin('b', 'enqueue');
    expect(b.queued).toBe(true);
    expect((await h.store.get('b'))?.status).toBe('queued');
    expect(h.attempts).toHaveLength(1);
    h.attempts[0]!.finish({ status: 'finished', text: 'A' });
    await a.live.done;
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'b']);
    expect(await h.store.get('b')).toMatchObject({
      status: 'running',
      instanceId: 'new-instance',
    });
    // Sessions are independent: another session's turn does not queue.
    const other = await h.begin('o', 'enqueue', 'sess-2');
    expect(other.queued).toBe(false);
  });

  it('abortSession stops the running turn; a turn queued behind it then starts', async () => {
    const h = harness();
    expect(h.runs.abortSession(SESSION)).toBe(false);
    const a = await h.begin('a');
    expect(h.runs.abortSession(SESSION)).toBe(true);
    expect((await a.live.done).status).toBe('aborted');
    await settled();
    expect((await h.store.get('a'))?.status).toBe('aborted');
    const b = await h.begin('b');
    const c = await h.begin('c', 'enqueue');
    expect(h.runs.abortSession(SESSION)).toBe(true);
    expect((await b.live.done).status).toBe('aborted');
    await settled();
    expect(h.attempts.at(-1)?.live.runId).toBe('c');
    expect((await h.store.get('c'))?.status).toBe('running');
    h.runs.abortSession(SESSION);
    expect((await c.live.done).status).toBe('aborted');
    await settled();
    expect(h.runs.size).toBe(0);
  });

  it('recovery: an orphaned run is re-scheduled with the backoff, numbered above any cursor, and resumes with its partial text', async () => {
    const h = harness();
    h.store.seed({ runId: 'r1', checkpointId: 'cp1' });
    h.store.pack('r1', [
      { seq: 1, event: 'run', data: { runId: 'r1' } },
      { seq: 2, event: 'message', data: { content: 'Hello ' } },
      { seq: 3, event: 'message', data: { content: 'world' } },
    ]);
    // Frames 4..8 were streamed to the client but never packed.
    await h.runs.recoverOrphans();
    expect(await h.store.get('r1')).toMatchObject({
      status: 'recovering',
      attempts: 1,
      generation: 1,
      nextAttemptAt: T0 + 5_000,
      instanceId: 'new-instance',
    });
    expect(h.alarms).toEqual([T0 + 5_000]);
    expect(h.runs.nextRecoveryAt()).toBe(T0 + 5_000);
    expect(h.runs.snapshot()[0]).toMatchObject({
      runId: 'r1',
      status: 'recovering',
      lastSeq: attemptSeqBase(1),
      packedSeq: attemptSeqBase(1),
    });
    const joined = await h.runs.join('r1', 8);
    expect(joined?.replay).toEqual([]);
    const seen: RunFrame[] = [];
    joined!.buffer!.subscribe((f) => seen.push(f));
    await h.runs.resumeDue(T0 + 4_999);
    expect(h.attempts).toHaveLength(0);
    await h.runs.resumeDue(T0 + 5_000);
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0]!.resumed).toBe(true);
    expect(h.attempts[0]!.live.continuation).toBe('Hello world');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      seq: attemptSeqBase(1) + 1,
      event: 'run',
      data: { runId: 'r1', resumed: true, attempt: 1, partialLength: 11 },
    });
    expect((await h.store.get('r1'))?.status).toBe('running');
    const live = h.attempts[0]!.live;
    live.buffer.push('message', { content: ' again' });
    expect(seen.at(-1)?.seq).toBe(attemptSeqBase(1) + 2);
    h.attempts[0]!.finish({ status: 'finished', text: 'Hello world again' });
    await live.done;
    await settled();
    expect(await h.store.get('r1')).toMatchObject({
      status: 'finished',
      // run, message, then the closing `done`.
      lastSeq: attemptSeqBase(1) + 3,
    });
  });

  it('recovery: progress since the previous attempt resets the counter and the backoff', async () => {
    const h = harness();
    h.store.seed({
      runId: 'r1',
      attempts: 3,
      generation: 3,
      checkpointId: 'cp1',
    });
    h.setCheckpoint('cp2');
    await h.runs.recoverOrphans();
    expect(await h.store.get('r1')).toMatchObject({
      attempts: 1,
      generation: 4,
      checkpointId: 'cp2',
      nextAttemptAt: T0 + 5_000,
    });
  });

  it('recovery: the delays follow the schedule and the run is closed as interrupted after the cap, keeping its partial text', async () => {
    const h = harness();
    h.store.seed({
      runId: 'r1',
      attempts: 2,
      generation: 2,
      checkpointId: 'cp1',
    });
    h.store.pack('r1', [
      { seq: 5, event: 'message', data: { content: 'partial' } },
    ]);
    await h.runs.recoverOrphans();
    expect(await h.store.get('r1')).toMatchObject({
      attempts: 3,
      nextAttemptAt: T0 + 30_000,
    });

    const capped = harness();
    capped.store.seed({
      runId: 'r2',
      attempts: 4,
      generation: 4,
      checkpointId: 'cp1',
    });
    capped.store.pack('r2', [
      { seq: 2, event: 'message', data: { content: 'the reply ' } },
      { seq: 3, event: 'message', data: { content: 'so far' } },
    ]);
    await capped.runs.recoverOrphans();
    expect(await capped.store.get('r2')).toMatchObject({
      status: 'interrupted',
      partialText: 'the reply so far',
      generation: 5,
      // error + done frames, numbered above every earlier attempt
      lastSeq: attemptSeqBase(5) + 2,
      nextAttemptAt: null,
    });
    expect(capped.ended.map((e) => e.outcome.status)).toEqual(['interrupted']);
    expect(capped.attempts).toHaveLength(0);
    expect(capped.alarms).toEqual([]);
    expect(capped.runs.size).toBe(0);
  });

  it('recovery: queued orphans of an idle session are started; a queued one behind an orphaned run waits', async () => {
    const h = harness();
    h.store.seed({ runId: 'q1', status: 'queued', sessionId: 'idle' });
    h.store.seed({
      runId: 'r1',
      status: 'running',
      sessionId: 'busy',
      checkpointId: 'cp1',
    });
    h.store.seed({ runId: 'q2', status: 'queued', sessionId: 'busy' });
    await h.runs.recoverOrphans();
    expect(h.attempts.map((a) => a.live.runId)).toEqual(['q1']);
    expect((await h.store.get('q1'))?.status).toBe('running');
    expect((await h.store.get('q2'))?.status).toBe('queued');
    expect((await h.store.get('r1'))?.status).toBe('recovering');
  });

  it('abortSession on a recovering run (nothing executing) closes it as aborted with the text so far', async () => {
    const h = harness();
    h.store.seed({ runId: 'r1', checkpointId: 'cp1' });
    h.store.pack('r1', [{ seq: 2, event: 'message', data: { content: 'Hi' } }]);
    await h.runs.recoverOrphans();
    expect(h.runs.abortSession(SESSION)).toBe(true);
    await pause(0);
    expect(await h.store.get('r1')).toMatchObject({
      status: 'aborted',
      partialText: 'Hi',
    });
    expect(h.runs.nextRecoveryAt()).toBeNull();
  });

  it('keep-alive: one alarm per horizon while an attempt executes, re-armed only near expiry, none when idle', async () => {
    const h = harness();
    expect(h.runs.keepAliveDeadline(h.now)).toBeNull();
    const a = await h.begin('a');
    expect(h.alarms).toEqual([T0 + 20_000]);
    h.runs.touchKeepAlive();
    h.tick(10_000);
    h.runs.touchKeepAlive();
    expect(h.alarms).toHaveLength(1);
    h.tick(6_000); // 4 s left: within a quarter of the horizon
    h.runs.touchKeepAlive();
    expect(h.alarms).toEqual([T0 + 20_000, T0 + 36_000]);
    expect(h.runs.keepAliveDeadline(h.now)).toBe(T0 + 36_000);
    h.attempts[0]!.finish({ status: 'finished', text: '' });
    await a.live.done;
    h.tick(30_000);
    h.runs.touchKeepAlive();
    expect(h.alarms).toHaveLength(2);
    expect(h.runs.keepAliveDeadline(h.now)).toBeNull();
  });

  it('a crashing attempt closes the run as failed with the error, never leaving it active', async () => {
    const h = harness();
    const failing = new RunCoordinator({
      ...h.host,
      runAttempt: async () => {
        throw new Error('isolate out of memory');
      },
    });
    const { live } = await failing.begin({
      runId: 'x',
      sessionId: SESSION,
      requestId: 'req-x',
      client: 'portal',
      request: '{}',
      multitask: 'interrupt',
    });
    const outcome = await live.done;
    await settled();
    expect(outcome.status).toBe('failed');
    expect(await h.store.get('x')).toMatchObject({
      status: 'failed',
      error: 'isolate out of memory',
    });
    expect(failing.size).toBe(0);
  });
});

it('persists the final channel reply for cross-service receipt polling', async () => {
  const h = harness();
  const { live } = await h.runs.begin({
    runId: 'channel-once',
    sessionId: SESSION,
    requestId: 'wa:one',
    client: 'channel',
    request: '{}',
    multitask: 'enqueue',
  });
  h.attempts[0]!.finish({
    status: 'finished',
    text: 'The complete answer',
    messageId: 'message-1',
  });
  await live.done;
  expect(await h.store.get('channel-once')).toMatchObject({
    status: 'finished',
    partialText: 'The complete answer',
    messageId: 'message-1',
  });
});

describe('deferred attempts', () => {
  it('reschedules a deferred fresh attempt with the backoff, keeps the session queue waiting, and retries it fresh', async () => {
    const h = harness();
    const a = await h.begin('a', 'enqueue');
    h.attempts[0]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    expect(await h.store.get('a')).toMatchObject({
      status: 'recovering',
      attempts: 1,
      nextAttemptAt: T0 + 5_000,
      error: null,
    });
    expect(h.alarms).toContain(T0 + 5_000);
    expect(h.ended).toEqual([]);
    const b = await h.begin('b', 'enqueue');
    expect(b.queued).toBe(true);
    await h.runs.resumeDue(T0 + 4_999);
    expect(h.attempts).toHaveLength(1);
    const seen: RunFrame[] = [];
    a.live.buffer.subscribe((f) => seen.push(f));
    await h.runs.resumeDue(T0 + 5_000);
    expect(h.attempts).toHaveLength(2);
    expect(h.attempts[1]!.live.runId).toBe('a');
    expect(h.attempts[1]!.resumed).toBe(false);
    expect(seen).toEqual([]);
    h.attempts[1]!.finish({ status: 'finished', text: 'Answer' });
    expect((await a.live.done).status).toBe('finished');
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'a', 'b']);
  });

  it('keeps a deferred recovery attempt a resume', async () => {
    const h = harness();
    // Started from cp0; the graph has checkpointed (cp1) since.
    h.store.seed({
      runId: 'r1',
      checkpointId: 'cp1',
      startCheckpointId: 'cp0',
      startRecorded: true,
    });
    await h.runs.recoverOrphans();
    await h.runs.resumeDue(T0 + 5_000);
    expect(h.attempts[0]!.resumed).toBe(true);
    h.attempts[0]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    expect(await h.store.get('r1')).toMatchObject({
      status: 'recovering',
      attempts: 2,
      nextAttemptAt: T0 + 15_000,
    });
    await h.runs.resumeDue(T0 + 15_000);
    expect(h.attempts[1]!.resumed).toBe(true);
  });

  it('fails the run once deferrals exhaust the recovery cap', async () => {
    const h = harness({ recoveryAttempts: 1 });
    const { live } = await h.begin('a');
    h.attempts[0]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    expect((await h.store.get('a'))?.status).toBe('recovering');
    await h.runs.resumeDue(T0 + 5_000);
    h.attempts[1]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    const outcome = await live.done;
    await settled();
    expect(outcome.status).toBe('failed');
    expect(await h.store.get('a')).toMatchObject({
      status: 'failed',
      error: 'Auth Hub unavailable',
    });
    expect(h.ended.map((e) => e.outcome.status)).toEqual(['failed']);
  });

  it('fails the run at once for any other attempt error', async () => {
    const h = harness();
    const { live } = await h.begin('a');
    h.attempts[0]!.fail(new Error('Channel binding is inactive'));
    expect((await live.done).status).toBe('failed');
    await settled();
    expect(await h.store.get('a')).toMatchObject({
      status: 'failed',
      error: 'Channel binding is inactive',
    });
    expect(h.attempts).toHaveLength(1);
  });
});

describe('fresh or resumed recovery attempts', () => {
  it('recovers a deferred run FRESH after its object restarts before the retry', async () => {
    const before = harness();
    await before.begin('a', 'enqueue');
    before.attempts[0]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    const row = await before.store.get('a');
    expect(row).toMatchObject({
      status: 'recovering',
      startCheckpointId: 'cp1',
      startRecorded: true,
    });
    // The restart: a new instance over the same rows; the graph never
    // checkpointed the run (the session is still at cp1).
    const after = harness();
    after.store.seed({ ...row!, runId: 'a' });
    await after.runs.recoverOrphans();
    expect(await after.store.get('a')).toMatchObject({
      status: 'recovering',
      attempts: 2,
      nextAttemptAt: T0 + 15_000,
    });
    const live = after.runs.get('a')!;
    const seen: RunFrame[] = [];
    live.buffer.subscribe((f) => seen.push(f));
    await after.runs.resumeDue(T0 + 15_000);
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]!.resumed).toBe(false);
    expect(after.attempts[0]!.live.continuation).toBeNull();
    expect(seen).toEqual([]);
    after.attempts[0]!.finish({ status: 'finished', text: 'Answer' });
    expect((await live.done).status).toBe('finished');
  });

  it('resumes a run reset after its first checkpoint, with its continuation', async () => {
    const h = harness();
    h.store.seed({
      runId: 'r1',
      checkpointId: 'cp0',
      startCheckpointId: 'cp0',
      startRecorded: true,
    });
    h.store.pack('r1', [
      { seq: 1, event: 'run', data: { runId: 'r1' } },
      { seq: 2, event: 'message', data: { content: 'Hello' } },
    ]);
    h.setCheckpoint('cp1');
    await h.runs.recoverOrphans();
    const seen: RunFrame[] = [];
    h.runs.get('r1')!.buffer.subscribe((f) => seen.push(f));
    await h.runs.resumeDue(T0 + 5_000);
    expect(h.attempts[0]!.resumed).toBe(true);
    expect(h.attempts[0]!.live.continuation).toBe('Hello');
    expect(seen[0]).toMatchObject({
      event: 'run',
      data: { runId: 'r1', resumed: true, partialLength: 5 },
    });
  });

  it('still closes a run that never progresses once the cap is spent', async () => {
    const h = harness({ recoveryAttempts: 2 });
    const { live } = await h.begin('a');
    h.attempts[0]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    await h.runs.resumeDue(T0 + 5_000);
    expect(h.attempts[1]!.resumed).toBe(false);
    h.attempts[1]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    expect((await h.store.get('a'))?.attempts).toBe(2);
    await h.runs.resumeDue(T0 + 20_000);
    expect(h.attempts[2]!.resumed).toBe(false);
    h.attempts[2]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    expect((await live.done).status).toBe('failed');
    // After a restart the spent cap closes the run without another attempt.
    const restarted = harness({ recoveryAttempts: 2 });
    restarted.store.seed({
      runId: 'b',
      attempts: 2,
      checkpointId: 'cp1',
      startCheckpointId: 'cp1',
      startRecorded: true,
    });
    await restarted.runs.recoverOrphans();
    await settled();
    expect((await restarted.store.get('b'))?.status).toBe('interrupted');
    expect(restarted.attempts).toHaveLength(0);
  });
});

/** Events a buffer delivers to a subscriber from now on. */
function watch(live: LiveRun): Array<{ event: string; data: unknown }> {
  const seen: Array<{ event: string; data: unknown }> = [];
  live.buffer.subscribe((f) => seen.push({ event: f.event, data: f.data }));
  return seen;
}

describe('abortAllForSession', () => {
  it('ends the running, queued and recovering runs of the session as aborted, leaves other sessions alone, and starts nothing afterwards', async () => {
    const h = harness();
    // A run of the session left recovering by a previous incarnation, and
    // one of another session.
    h.store.seed({ runId: 'r', checkpointId: 'cp1' });
    h.store.seed({
      runId: 'r-other',
      sessionId: 'sess-2',
      checkpointId: 'cp1',
    });
    await h.runs.recoverOrphans();
    const q1 = await h.begin('q1', 'enqueue');
    expect(q1.queued).toBe(true);
    const recovering = h.runs.get('r')!;
    const seenRecovering = watch(recovering);
    const seenQueued = watch(q1.live);

    await h.runs.abortAllForSession(SESSION);
    expect(await h.store.get('r')).toMatchObject({ status: 'aborted' });
    expect(await h.store.get('q1')).toMatchObject({ status: 'aborted' });
    expect(seenRecovering.at(-1)).toEqual({
      event: 'done',
      data: { runId: 'r', aborted: true },
    });
    expect(seenQueued.at(-1)).toEqual({
      event: 'done',
      data: { runId: 'q1', aborted: true },
    });
    expect(recovering.buffer.isClosed).toBe(true);
    // The other session's recovery still happens; this session's never.
    await h.runs.resumeDue(T0 + 60_000);
    expect(h.attempts.map((a) => a.live.runId)).toEqual(['r-other']);
    expect((await h.store.get('r-other'))?.status).toBe('running');
  });

  it('aborts the executing attempt and cancels the queue behind it, resolving when the attempt ended', async () => {
    const h = harness();
    h.stubborn.add('a');
    const a = await h.begin('a');
    const q = await h.begin('q', 'enqueue');
    const other = await h.begin('o', 'interrupt', 'sess-2');
    const seenA = watch(a.live);
    let resolved = false;
    const aborting = h.runs
      .abortAllForSession(SESSION)
      .then(() => (resolved = true));
    await settled();
    expect(a.live.abort.signal.aborted).toBe(true);
    expect((await q.live.done).status).toBe('aborted');
    expect(resolved).toBe(false);
    // The attempt winds down on its own time.
    h.attempts[0]!.finish({ status: 'aborted', text: '' });
    await aborting;
    await settled();
    expect(resolved).toBe(true);
    expect((await h.store.get('a'))?.status).toBe('aborted');
    expect(seenA.at(-1)).toEqual({
      event: 'done',
      data: { runId: 'a', aborted: true },
    });
    // The queued run was never dequeued; the other session runs on.
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'o']);
    expect(other.live.abort.signal.aborted).toBe(false);
    expect(h.runs.activeForSession('sess-2')?.runId).toBe('o');
    expect(h.runs.activeForSession(SESSION)).toBeUndefined();
  });

  it('resolves after the grace when the attempt does not wind down', async () => {
    const h = harness({}, { graceMs: 30 });
    h.stubborn.add('a');
    await h.begin('a');
    const started = Date.now();
    await h.runs.abortAllForSession(SESSION);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(h.runs.get('a')?.abort.signal.aborted).toBe(true);
  });

  it('closes a message still waiting in begin without an attempt', async () => {
    const h = harness();
    h.stubborn.add('a');
    await h.begin('a');
    // b waits for a to wind down after superseding it.
    const b = h.begin('b');
    await settled();
    const aborting = h.runs.abortAllForSession(SESSION);
    const { live, queued } = await b;
    expect(queued).toBe(false);
    expect((await live.done).status).toBe('aborted');
    expect(live.buffer.tailAfter(0).map((f) => f.event)).toEqual(['done']);
    expect((await h.store.get('b'))?.status).toBe('aborted');
    h.attempts[0]!.finish({ status: 'aborted', text: '' });
    await aborting;
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a']);
  });

  it('is a no-op when nothing runs', async () => {
    const h = harness();
    await h.runs.abortAllForSession(SESSION);
    expect(h.runs.size).toBe(0);
    expect(h.ended).toEqual([]);
  });
});

describe('begin: one session, one attempt at a time', () => {
  it('two interrupting messages racing on a running turn: only the last one runs, the first ends aborted without an attempt', async () => {
    const h = harness();
    await h.begin('a');
    const b = h.begin('b');
    const c = h.begin('c');
    const [rb, rc] = await Promise.all([b, c]);
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'c']);
    expect((await rb.live.done).status).toBe('aborted');
    expect(rb.live.buffer.tailAfter(0)).toEqual([
      expect.objectContaining({
        event: 'done',
        data: { runId: 'b', aborted: true },
      }),
    ]);
    expect((await h.store.get('b'))?.status).toBe('aborted');
    expect(rc.queued).toBe(false);
    expect((await h.store.get('c'))?.status).toBe('running');
    expect(h.runs.activeForSession(SESSION)?.runId).toBe('c');
  });

  it('a waiting message is superseded even when the run it waits on fails', async () => {
    const h = harness();
    h.stubborn.add('a');
    await h.begin('a');
    const b = h.begin('b');
    await settled();
    const c = h.begin('c');
    await settled();
    h.attempts[0]!.fail(new Error('provider exploded'));
    const [rb, rc] = await Promise.all([b, c]);
    await settled();
    expect((await rb.live.done).status).toBe('aborted');
    expect(rc.queued).toBe(false);
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'c']);
    expect((await h.store.get('a'))?.status).toBe('aborted');
  });

  it('queues the new message behind a run that outlives the grace instead of running beside it', async () => {
    const h = harness({}, { graceMs: 20 });
    h.stubborn.add('a');
    await h.begin('a');
    const b = await h.begin('b');
    expect(b.queued).toBe(true);
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a']);
    expect((await h.store.get('b'))?.status).toBe('queued');
    h.attempts[0]!.finish({ status: 'aborted', text: '' });
    await settled();
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'b']);
  });

  it('two enqueued messages on an idle session: the first runs, the second queues', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.begin('a', 'enqueue'),
      h.begin('b', 'enqueue'),
    ]);
    expect(a.queued).toBe(false);
    expect(b.queued).toBe(true);
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a']);
    h.attempts[0]!.finish({ status: 'finished', text: 'A' });
    await a.live.done;
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'b']);
  });

  it('a queued message whose run ahead ended while it was being recorded starts at once', async () => {
    const h = harness();
    const a = await h.begin('a');
    const hold = gate();
    const checkpointIdOf = h.host.checkpointIdOf;
    h.host.checkpointIdOf = async (sessionId) => {
      await hold.promise;
      return checkpointIdOf(sessionId);
    };
    const b = h.begin('b', 'enqueue');
    await settled();
    h.attempts[0]!.finish({ status: 'finished', text: 'A' });
    await a.live.done;
    await settled();
    hold.open();
    const rb = await b;
    expect(rb.queued).toBe(false);
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'b']);
  });
});

describe('every run ends with frames its subscribers can finish on', () => {
  it('an attempt that crashes: error, then done failed, and the response stream closes', async () => {
    const h = harness();
    const { live } = await h.begin('a');
    const stream = createSseSubscriberStream({
      replay: live.buffer.tailAfter(0),
      buffer: live.buffer,
    });
    h.attempts[0]!.fail(new Error('createMainAgent threw'));
    const frames = await sseFrames(stream);
    expect(frames.map((f) => f.event)).toEqual(['error', 'done']);
    expect(frames[0]!.data).toMatchObject({
      kind: 'unknown',
      retryable: true,
      runId: 'a',
    });
    expect(JSON.stringify(frames[0]!.data)).not.toContain('createMainAgent');
    expect(frames[1]!.data).toEqual({ runId: 'a', failed: true });
  });

  it('a re-joined recovering run that is then aborted: done aborted, and the stream closes', async () => {
    const h = harness();
    h.store.seed({ runId: 'r1', checkpointId: 'cp1' });
    await h.runs.recoverOrphans();
    const joined = await h.runs.join('r1', 0);
    const stream = createSseSubscriberStream({
      replay: joined!.replay,
      buffer: joined!.buffer!,
    });
    expect(h.runs.abortSession(SESSION)).toBe(true);
    const frames = await sseFrames(stream);
    expect(frames).toEqual([
      { event: 'done', data: { runId: 'r1', aborted: true } },
    ]);
  });

  it('deferrals that exhaust the cap: error, then done failed', async () => {
    const h = harness({ recoveryAttempts: 1 });
    const { live } = await h.begin('a');
    const seen = watch(live);
    h.attempts[0]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    await h.runs.resumeDue(T0 + 5_000);
    h.attempts[1]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await live.done;
    expect(seen.map((f) => f.event)).toEqual(['error', 'done']);
    expect(seen[1]!.data).toEqual({ runId: 'a', failed: true });
  });

  it('never emits a second done when the attempt already sent one', async () => {
    const h = harness();
    const { live } = await h.begin('a');
    const seen = watch(live);
    live.buffer.push('done', { runId: 'a', messageId: 'm1' });
    h.attempts[0]!.finish({ status: 'finished', text: 'x', messageId: 'm1' });
    await live.done;
    expect(seen.filter((f) => f.event === 'done')).toHaveLength(1);
    // A finished run without its own done frame still gets one.
    const second = await h.begin('b');
    const seenB = watch(second.live);
    h.attempts[1]!.finish({ status: 'finished', text: 'y', messageId: 'm2' });
    await second.live.done;
    expect(seenB).toEqual([
      { event: 'done', data: { runId: 'b', messageId: 'm2' } },
    ]);
  });

  it('a recovering run aborted while resumeDue is starting it is never attempted, and resumeDue resolves', async () => {
    const h = harness();
    h.store.seed({ runId: 'r1', checkpointId: 'cp1' });
    h.store.pack('r1', [{ seq: 1, event: 'message', data: { content: 'Hi' } }]);
    h.setCheckpoint('cp2');
    await h.runs.recoverOrphans();
    const live = h.runs.get('r1')!;
    const seen = watch(live);
    let abortedMidStart = false;
    h.store.onUpdate = (runId) => {
      if (runId !== 'r1') return;
      h.store.onUpdate = null;
      abortedMidStart = h.runs.abortSession(SESSION);
    };
    await h.runs.resumeDue(T0 + 5_000);
    expect(abortedMidStart).toBe(true);
    expect((await live.done).status).toBe('aborted');
    expect(h.attempts).toHaveLength(0);
    expect(seen.map((f) => f.event)).toEqual(['done']);
    expect(await h.store.get('r1')).toMatchObject({
      status: 'aborted',
      partialText: 'Hi',
    });
  });

  it('a queued run aborted while it is being dequeued is never attempted', async () => {
    const h = harness();
    const a = await h.begin('a');
    const b = await h.begin('b', 'enqueue');
    h.store.onUpdate = (runId) => {
      if (runId === 'b') {
        h.store.onUpdate = null;
        h.runs.abortSession(SESSION);
      }
    };
    h.attempts[0]!.finish({ status: 'finished', text: 'A' });
    await a.live.done;
    expect((await b.live.done).status).toBe('aborted');
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a']);
    expect((await h.store.get('b'))?.status).toBe('aborted');
  });
});

describe('re-join while a segment is being written', () => {
  it('replays contiguous frames when the pack is still pending', async () => {
    const h = harness();
    const { live } = await h.begin('a');
    const write = gate();
    h.store.appendHold = write.promise;
    for (let i = 1; i <= 5; i += 1)
      live.buffer.push('message', { content: String(i) });
    void live.buffer.flush();
    const joined = await h.runs.join('a', 0);
    expect(joined!.replay.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    write.open();
    await live.buffer.flush();
    const later = await h.runs.join('a', 2);
    expect(later!.replay.map((f) => f.seq)).toEqual([3, 4, 5]);
  });

  it('replays contiguous frames when the flush lands during the store read', async () => {
    const h = harness();
    const { live } = await h.begin('a');
    live.buffer.push('message', { content: '1' });
    live.buffer.push('message', { content: '2' });
    await live.buffer.flush();
    live.buffer.push('message', { content: '3' });
    live.buffer.push('message', { content: '4' });
    const read = gate();
    const write = gate();
    h.store.readHold = read.promise;
    h.store.appendHold = write.promise;
    const joining = h.runs.join('a', 1);
    await settled();
    // The tail is taken for packing while the read is in progress.
    void live.buffer.flush();
    h.store.readHold = null;
    read.open();
    const joined = await joining;
    expect(joined!.replay.map((f) => f.seq)).toEqual([2, 3, 4]);
    write.open();
  });

  it('cursor edge cases: at 0, at the last frame, beyond the end, and across attempt generations', async () => {
    const h = harness();
    h.store.seed({ runId: 'r1', checkpointId: 'cp1' });
    h.store.pack('r1', [
      { seq: 1, event: 'message', data: { content: 'a' } },
      { seq: 2, event: 'message', data: { content: 'b' } },
    ]);
    await h.runs.recoverOrphans();
    const base = attemptSeqBase(1);
    expect((await h.runs.join('r1', 0))!.replay.map((f) => f.seq)).toEqual([
      1, 2,
    ]);
    expect((await h.runs.join('r1', 2))!.replay).toEqual([]);
    expect((await h.runs.join('r1', 999_999_999))!.replay).toEqual([]);
    h.setCheckpoint('cp2');
    await h.runs.resumeDue(T0 + 5_000);
    const live = h.attempts[0]!.live;
    live.buffer.push('message', { content: 'c' });
    // A client whose cursor points into the lost tail of the old attempt
    // (between the packed frames and the new base) gets the new attempt.
    expect((await h.runs.join('r1', 7))!.replay.map((f) => f.seq)).toEqual([
      base + 1,
      base + 2,
    ]);
    expect((await h.runs.join('r1', base + 2))!.replay).toEqual([]);
  });
});

describe('finalize', () => {
  it('closes a run once, whatever ends it first', async () => {
    const h = harness();
    h.store.seed({ runId: 'r1', checkpointId: 'cp1' });
    await h.runs.recoverOrphans();
    const live = h.runs.get('r1')!;
    h.runs.abortSession(SESSION);
    h.runs.abortSession(SESSION);
    await h.runs.abortAllForSession(SESSION);
    await live.done;
    await settled();
    expect(h.ended).toHaveLength(1);
    expect(live.buffer.lastSeq - attemptSeqBase(1)).toBe(1);
  });
});

describe('recovery accounting at the cap', () => {
  it('the last allowed attempt is still scheduled; the next restart closes the run', async () => {
    const h = harness({ recoveryAttempts: 2 });
    h.store.seed({
      runId: 'r1',
      attempts: 1,
      generation: 1,
      checkpointId: 'cp1',
    });
    await h.runs.recoverOrphans();
    expect(await h.store.get('r1')).toMatchObject({
      status: 'recovering',
      attempts: 2,
      nextAttemptAt: T0 + 15_000,
    });
    const restarted = harness({ recoveryAttempts: 2 });
    restarted.store.seed({
      ...(await h.store.get('r1'))!,
      status: 'running',
    });
    await restarted.runs.recoverOrphans();
    expect((await restarted.store.get('r1'))?.status).toBe('interrupted');
  });
});

describe('attempt source', () => {
  it('tells the attempt whether it was admitted just now, dequeued, or a recovery', async () => {
    const h = harness();
    await h.begin('a');
    await h.begin('b', 'enqueue');
    expect(h.attempts[0]!.live.attemptSource).toBe('begin');
    h.attempts[0]!.fail(new RunAttemptDeferred('Auth Hub unavailable'));
    await settled();
    await h.runs.resumeDue(T0 + 5_000);
    expect(h.attempts[1]!.live.attemptSource).toBe('recovery');
    h.attempts[1]!.finish({ status: 'finished', text: 'A' });
    await h.attempts[1]!.live.done;
    await settled();
    expect(h.attempts[2]!.live.runId).toBe('b');
    expect(h.attempts[2]!.live.attemptSource).toBe('dequeue');
  });
});

describe('usage on the outcome', () => {
  it('is stored in the same update as the terminal status, and absent usage leaves the row as it was', async () => {
    const h = harness();
    const patches: Array<Record<string, unknown>> = [];
    const update = h.store.update.bind(h.store);
    h.store.update = async (runId, patch) => {
      patches.push({ runId, ...patch });
      return update(runId, patch);
    };
    const a = await h.begin('a');
    h.attempts[0]!.finish({
      status: 'finished',
      text: 'A',
      usage: '{"inputTokens":12,"outputTokens":3}',
    });
    await a.live.done;
    expect(patches.filter((p) => p.runId === 'a')).toEqual([
      expect.objectContaining({
        status: 'finished',
        usage: '{"inputTokens":12,"outputTokens":3}',
      }),
    ]);
    expect((await h.store.get('a'))?.usage).toBe(
      '{"inputTokens":12,"outputTokens":3}',
    );

    const b = await h.begin('b');
    await h.store.update('b', { usage: '{"earlier":true}' });
    h.attempts[1]!.finish({ status: 'finished', text: 'B' });
    await b.live.done;
    const closing = patches.find(
      (p) => p.runId === 'b' && p.status === 'finished',
    );
    expect(closing).not.toHaveProperty('usage');
    expect((await h.store.get('b'))?.usage).toBe('{"earlier":true}');
  });
});

describe('Stop while a message waits', () => {
  it('stops a message still waiting in begin for the run it supersedes', async () => {
    const h = harness();
    h.stubborn.add('a');
    await h.begin('a');
    const b = h.begin('b');
    await settled();
    expect(h.runs.abortSession(SESSION)).toBe(true);
    h.attempts[0]!.finish({ status: 'aborted', text: '' });
    const { live } = await b;
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a']);
    expect((await live.done).status).toBe('aborted');
    expect((await h.store.get('b'))?.status).toBe('aborted');
  });

  it('stops a message queued behind a run that outlived the grace', async () => {
    const h = harness({}, { graceMs: 20 });
    h.stubborn.add('a');
    await h.begin('a');
    const b = await h.begin('b');
    expect(b.queued).toBe(true);
    expect(h.runs.abortSession(SESSION)).toBe(true);
    h.attempts[0]!.finish({ status: 'aborted', text: '' });
    await settled();
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a']);
    expect((await b.live.done).status).toBe('aborted');
  });

  it('still lets an enqueued message start after Stop ends the run ahead of it', async () => {
    const h = harness();
    await h.begin('a');
    await h.begin('q', 'enqueue');
    expect(h.runs.abortSession(SESSION)).toBe(true);
    await h.attempts[0]!.live.done;
    await settled();
    expect(h.attempts.map((x) => x.live.runId)).toEqual(['a', 'q']);
  });
});

describe('re-join racing the end of a run', () => {
  it('answers with the stored row and no buffer when the run ended during the read', async () => {
    const h = harness();
    const { live } = await h.begin('a');
    live.buffer.push('message', { content: 'Hello' });
    const read = gate();
    h.store.readHold = read.promise;
    const joining = h.runs.join('a', 0);
    await settled();
    // The run closes while the read is queued (its own read of the
    // segments queues behind it).
    h.attempts[0]!.fail(new Error('provider exploded'));
    await settled();
    expect(h.runs.get('a')).toBeUndefined();
    h.store.readHold = null;
    read.open();
    const joined = await joining;
    expect(joined?.buffer).toBeUndefined();
    expect(joined?.record).toMatchObject({
      status: 'failed',
      partialText: 'Hello',
    });
    expect(joined?.replay.map((f) => f.event)).not.toContain('done');
  });
});
