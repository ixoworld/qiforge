import { describe, expect, it } from 'vitest';
import type { Logger } from '../plugin-api/types';
import type { PackedSegment, RunFrame } from './run-buffer';
import {
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
  ): Promise<void> {
    this.seed({
      runId: input.runId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      client: input.client,
      status: input.status,
      request: input.request,
      checkpointId: input.checkpointId,
      taskRunId: input.taskRunId ?? null,
      instanceId: input.instanceId,
    });
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const row = this.rows.get(runId);
    return row ? { ...row } : undefined;
  }

  async update(
    runId: string,
    patch: Parameters<RunCoordinatorStore['update']>[1],
  ): Promise<void> {
    const row = this.rows.get(runId);
    if (!row) return;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    this.rows.set(runId, { ...row, ...defined, updatedAt: this.iso() });
  }

  async listActive(): Promise<RunRecord[]> {
    const active: RunStatus[] = ['queued', 'running', 'recovering'];
    return [...this.rows.values()]
      .filter((r) => active.includes(r.status))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((r) => ({ ...r }));
  }

  async appendSegment(runId: string, segment: PackedSegment): Promise<void> {
    let per = this.segments.get(runId);
    if (!per) {
      per = new Map();
      this.segments.set(runId, per);
    }
    per.set(segment.seqFrom, segment);
  }

  async readSegments(runId: string, after = 0): Promise<PackedSegment[]> {
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
}

function harness(overrides: Partial<RunDurabilityConfig> = {}) {
  let now = T0;
  const store = new MemoryRunStore(() => now);
  const alarms: number[] = [];
  const ended: Array<{ record: RunRecord; outcome: RunOutcome }> = [];
  const attempts: Attempt[] = [];
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
      new Promise<RunOutcome>((resolve) => {
        attempts.push({ live, resumed, finish: resolve });
        live.abort.signal.addEventListener('abort', () =>
          resolve({ status: 'aborted', text: live.continuation ?? '' }),
        );
      }),
    checkpointIdOf: async () => checkpoint,
    onRunEnded: async (record, outcome) => {
      ended.push({ record, outcome });
    },
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
      lastSeq: 3,
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
      lastSeq: attemptSeqBase(1) + 2,
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
