import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RunStoreTestDO } from './run-store-test-do';
import {
  decideRecovery,
  DEFAULT_RECOVERY_DELAYS_MS,
  RUN_RETENTION_MS,
  runDurabilityConfig,
} from './run-store';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      RUN_STORE_TEST: DurableObjectNamespace<RunStoreTestDO>;
    }
  }
}

function stub(name: string) {
  return env.RUN_STORE_TEST.get(env.RUN_STORE_TEST.idFromName(name));
}

const T0 = Date.parse('2026-09-13T10:00:00.000Z');

describe('decideRecovery', () => {
  const config = {
    recoveryAttempts: 4,
    recoveryDelaysMs: DEFAULT_RECOVERY_DELAYS_MS,
  };
  it('schedules attempts 5 s, 15 s, 30 s, 60 s apart and interrupts after the fourth', () => {
    const run = { attempts: 0, checkpointId: 'cp1' };
    expect(decideRecovery(run, 'cp1', 1000, config)).toEqual({
      action: 'schedule',
      at: 6000,
      attempts: 1,
    });
    expect(
      decideRecovery({ attempts: 1, checkpointId: 'cp1' }, 'cp1', 0, config),
    ).toMatchObject({ at: 15_000, attempts: 2 });
    expect(
      decideRecovery({ attempts: 2, checkpointId: 'cp1' }, 'cp1', 0, config),
    ).toMatchObject({ at: 30_000, attempts: 3 });
    expect(
      decideRecovery({ attempts: 3, checkpointId: 'cp1' }, 'cp1', 0, config),
    ).toMatchObject({ at: 60_000, attempts: 4 });
    expect(
      decideRecovery({ attempts: 4, checkpointId: 'cp1' }, 'cp1', 0, config),
    ).toEqual({ action: 'interrupt', attempts: 4 });
  });

  it('resets the counter when the checkpoint moved since the last attempt', () => {
    expect(
      decideRecovery({ attempts: 3, checkpointId: 'cp1' }, 'cp2', 0, config),
    ).toEqual({ action: 'schedule', at: 5000, attempts: 1 });
  });

  it('honours the env knobs and falls back on bad values', () => {
    const c = runDurabilityConfig({
      RUN_KEEPALIVE_MS: '20000',
      RUN_RECOVERY_ATTEMPTS: '2',
      RUN_RECOVERY_DELAYS_MS: '1,2,x',
      TURN_MULTITASK_DEFAULT: 'enqueue',
      RUN_SEGMENT_BYTES: 'nope',
    });
    expect(c.keepAliveMs).toBe(20_000);
    expect(c.recoveryAttempts).toBe(2);
    expect(c.recoveryDelaysMs).toEqual([1, 2]);
    expect(c.multitaskDefault).toBe('enqueue');
    expect(c.segmentBytes).toBe(16 * 1024);
    expect(runDurabilityConfig({}).multitaskDefault).toBe('interrupt');
  });
});

describe('RunStore', () => {
  it('records a run, finds the active one per session, and closes it', async () => {
    const s = stub('runs-basic');
    await s.setNow(T0);
    await s.create({
      runId: 'r1',
      sessionId: 'sess',
      requestId: 'req1',
      client: 'portal',
      status: 'running',
      request: '{"message":"hi"}',
      checkpointId: null,
      instanceId: 'i1',
    });
    const run = await s.get('r1');
    expect(run).toMatchObject({
      runId: 'r1',
      status: 'running',
      attempts: 0,
      generation: 0,
      lastSeq: 0,
      instanceId: 'i1',
    });
    expect((await s.activeForSession('sess'))?.runId).toBe('r1');
    expect((await s.listActive()).map((r) => r.runId)).toEqual(['r1']);
    await s.update('r1', { status: 'recovering', attempts: 1, generation: 1 });
    expect(await s.get('r1')).toMatchObject({ attempts: 1, generation: 1 });
    await s.update('r1', { status: 'finished', messageId: 'm1', lastSeq: 7 });
    expect(await s.activeForSession('sess')).toBeUndefined();
    expect((await s.get('r1'))?.messageId).toBe('m1');
  });

  it('adds the generation column to a turn_runs table created before it existed', async () => {
    const s = stub('runs-migrate');
    await s.rawRun(`
      CREATE TABLE IF NOT EXISTS turn_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        client TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        checkpoint_id TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        partial_text TEXT,
        message_id TEXT,
        error TEXT,
        task_run_id TEXT,
        instance_id TEXT NOT NULL
      )`);
    await s.rawRun(
      `INSERT INTO turn_runs (run_id, session_id, request_id, client, status, started_at, updated_at, request, instance_id)
       VALUES ('old', 'sess', 'req', 'portal', 'running', '2026-09-13T09:00:00.000Z', '2026-09-13T09:00:00.000Z', '{}', 'i0')`,
    );
    expect(await s.columnsOf('turn_runs')).not.toContain('generation');
    // The store's setup runs the migration; the old row reads back whole.
    expect(await s.get('old')).toMatchObject({
      runId: 'old',
      status: 'running',
      attempts: 0,
      generation: 0,
    });
    expect(await s.columnsOf('turn_runs')).toContain('generation');
    await s.update('old', { generation: 2 });
    expect((await s.get('old'))?.generation).toBe(2);
    // A legacy row has no recorded start (its recoveries resume, as before);
    // writing the start (a dequeue) records it.
    expect(await s.get('old')).toMatchObject({
      startCheckpointId: null,
      startRecorded: false,
    });
    await s.update('old', { startCheckpointId: 'cp-dequeue' });
    expect(await s.get('old')).toMatchObject({
      startCheckpointId: 'cp-dequeue',
      startRecorded: true,
    });
  });

  it('records the checkpoint a run starts from and keeps it across recovery rebases', async () => {
    const s = stub('runs-start-checkpoint');
    await s.create({
      runId: 'r-start',
      sessionId: 'sess',
      requestId: 'req',
      client: 'channel',
      status: 'running',
      request: '{}',
      checkpointId: 'cp-begin',
      instanceId: 'i1',
    });
    await s.update('r-start', {
      status: 'recovering',
      checkpointId: 'cp-later',
    });
    expect(await s.get('r-start')).toMatchObject({
      checkpointId: 'cp-later',
      startCheckpointId: 'cp-begin',
      startRecorded: true,
    });
  });

  it('orders a session’s work: running before recovering before queued, queued oldest first', async () => {
    const s = stub('runs-order');
    await s.setNow(T0);
    const mk = async (id: string, status: 'queued' | 'running', at: number) => {
      await s.setNow(at);
      await s.create({
        runId: id,
        sessionId: 'sess',
        requestId: id,
        client: 'portal',
        status,
        request: '{}',
        checkpointId: null,
        instanceId: 'i1',
      });
    };
    await mk('q1', 'queued', T0 + 1);
    await mk('q2', 'queued', T0 + 2);
    await mk('run', 'running', T0 + 3);
    expect((await s.activeForSession('sess'))?.runId).toBe('run');
    expect((await s.queuedForSession('sess')).map((r) => r.runId)).toEqual([
      'q1',
      'q2',
    ]);
    await s.update('run', { status: 'recovering' });
    expect((await s.activeForSession('sess'))?.runId).toBe('run');
    await s.update('run', { status: 'aborted' });
    expect((await s.activeForSession('sess'))?.runId).toBe('q1');
  });

  it('stores segments in order, serves them after a cursor, and deletes them at cutover', async () => {
    const s = stub('runs-segments');
    await s.setNow(T0);
    await s.create({
      runId: 'r1',
      sessionId: 'sess',
      requestId: 'req',
      client: 'portal',
      status: 'running',
      request: '{}',
      checkpointId: null,
      instanceId: 'i1',
    });
    await s.appendSegment('r1', { seqFrom: 1, seqTo: 3, payload: '[1,2,3]' });
    await s.appendSegment('r1', { seqFrom: 4, seqTo: 4, payload: '[4]' });
    await s.appendSegment('r1', { seqFrom: 5, seqTo: 9, payload: '[5..9]' });
    expect((await s.readSegments('r1')).map((x) => x.seqFrom)).toEqual([
      1, 4, 5,
    ]);
    expect((await s.readSegments('r1', 3)).map((x) => x.seqFrom)).toEqual([
      4, 5,
    ]);
    expect((await s.readSegments('r1', 4)).map((x) => x.seqFrom)).toEqual([5]);
    expect(await s.countSegments('r1')).toBe(3);
    await s.deleteSegments('r1');
    expect(await s.countSegments('r1')).toBe(0);
  });

  it('marks tool calls: first start is fresh, a repeat returns the mark, done and bump update it', async () => {
    const s = stub('runs-marks');
    await s.setNow(T0);
    expect(
      await s.startMark({
        runId: 'r1',
        toolCallId: 'c1',
        toolName: 'create_task',
        effect: 'write',
      }),
    ).toBeUndefined();
    const again = await s.startMark({
      runId: 'r1',
      toolCallId: 'c1',
      toolName: 'create_task',
      effect: 'write',
    });
    expect(again).toMatchObject({
      toolCallId: 'c1',
      doneAt: null,
      attempts: 1,
    });
    await s.finishMark('r1', 'c1', 'ok');
    expect((await s.listMarks('r1'))[0]).toMatchObject({
      outcome: 'ok',
      attempts: 1,
    });
    await s.startMark({
      runId: 'r1',
      toolCallId: 'c2',
      toolName: 'list_my_tasks',
      effect: 'read',
    });
    await s.bumpMark('r1', 'c2');
    const marks = await s.listMarks('r1');
    expect(marks.find((m) => m.toolCallId === 'c2')).toMatchObject({
      attempts: 2,
      doneAt: null,
    });
  });

  it('keeps unknown writes blocked across turns and retention until authenticated reconciliation', async () => {
    const s = stub('runs-claims');
    await s.setNow(T0);
    const fp = 'a'.repeat(64);
    expect(
      await s.claimWrite({
        fingerprint: fp,
        toolName: 'send_message',
        runId: 'r1',
        sessionId: 's1',
      }),
    ).toEqual({ status: 'claimed' });
    // A returned outcome releases it; the same write can then be claimed again.
    await s.releaseWrite(fp, 'r1');
    expect(await s.listClaims()).toEqual([]);
    expect(
      await s.claimWrite({
        fingerprint: fp,
        toolName: 'send_message',
        runId: 'r1',
        sessionId: 's1',
      }),
    ).toEqual({ status: 'claimed' });
    // Outcome unknown (no release): another session of the user is blocked
    // and the claim retains the originating run as its owner.
    const blocked = await s.claimWrite({
      fingerprint: fp,
      toolName: 'send_message',
      runId: 'r2',
      sessionId: 's2',
    });
    expect(blocked).toMatchObject({
      status: 'blocked',
      toolName: 'send_message',
    });
    expect((await s.listClaims())[0]).toMatchObject({
      state: 'warned',
      runId: 'r1',
    });
    // The warned run stays blocked; only its owner could release it.
    expect(
      (
        await s.claimWrite({
          fingerprint: fp,
          toolName: 'send_message',
          runId: 'r2',
          sessionId: 's2',
        })
      ).status,
    ).toBe('blocked');
    await s.releaseWrite(fp, 'r2');
    expect(await s.listClaims()).toHaveLength(1);
    // Neither a different run nor elapsed retention proves absence of an effect.
    expect(
      (
        await s.claimWrite({
          fingerprint: fp,
          toolName: 'send_message',
          runId: 'r3',
          sessionId: 's1',
        })
      ).status,
    ).toBe('blocked');
    expect((await s.listClaims())[0]).toMatchObject({
      state: 'warned',
      runId: 'r1',
    });
    // The claim survives a reopen and run retention.
    await s.reopen();
    expect(await s.listClaims()).toHaveLength(1);
    await s.setNow(T0 + RUN_RETENTION_MS + 1);
    await s.reopen();
    expect(await s.listClaims()).toHaveLength(1);
    expect(
      await s.reconcileWrite(fp, {
        expectedRunId: 'wrong',
        evidenceRef: 'provider:lookup:1',
        outcome: 'not-applied',
        authorizeRetry: true,
      }),
    ).toBe(false);
    expect(
      await s.reconcileWrite(fp, {
        expectedRunId: 'r1',
        evidenceRef: 'provider:lookup:1',
        outcome: 'unknown',
        authorizeRetry: false,
      }),
    ).toBe(true);
    expect(
      await s.reconcileWrite(fp, {
        expectedRunId: 'r1',
        evidenceRef: 'provider:lookup:1',
        outcome: 'not-applied',
        authorizeRetry: true,
      }),
    ).toBe(false);
    expect(await s.listClaims()).toHaveLength(1);
    expect(
      await s.reconcileWrite(fp, {
        expectedRunId: 'r1',
        evidenceRef: 'provider:lookup:2',
        outcome: 'not-applied',
        authorizeRetry: true,
      }),
    ).toBe(true);
    expect(await s.listClaims()).toEqual([]);
    expect(
      await s.claimWrite({
        fingerprint: fp,
        toolName: 'send_message',
        runId: 'r4',
        sessionId: 's1',
      }),
    ).toEqual({ status: 'claimed' });
  });

  it('survives a reopen (state is in SQLite, not memory) and prunes ended runs past retention', async () => {
    const s = stub('runs-reopen');
    await s.setNow(T0);
    await s.create({
      runId: 'old',
      sessionId: 'sess',
      requestId: 'req',
      client: 'matrix',
      status: 'running',
      request: '{}',
      checkpointId: 'cp',
      instanceId: 'i1',
    });
    await s.appendSegment('old', { seqFrom: 1, seqTo: 1, payload: '[1]' });
    await s.startMark({
      runId: 'old',
      toolCallId: 'c',
      toolName: 'x',
      effect: 'write',
    });
    await s.reopen();
    expect((await s.get('old'))?.status).toBe('running');
    await s.update('old', { status: 'finished' });
    // A week later the row, its marks and segments are gone at setup.
    await s.setNow(T0 + RUN_RETENTION_MS + 60_000);
    await s.reopen();
    expect(await s.get('old')).toBeUndefined();
    expect(await s.rowCount('turn_tool_marks')).toBe(0);
    expect(await s.rowCount('turn_run_segments')).toBe(0);
  });
});

it('prunes channel payloads and retains only a terminal tombstone', async () => {
  const s = stub('channel-retention');
  await s.setNow(T0);
  await s.create({
    runId: 'channel-original',
    sessionId: '$session',
    requestId: 'wa:one',
    client: 'channel',
    status: 'running',
    request: '{"message":"Private channel prompt"}',
    checkpointId: null,
    instanceId: 'first',
  });
  await s.appendSegment('channel-original', {
    seqFrom: 1,
    seqTo: 1,
    payload: '["Private response fragment"]',
  });
  await s.startMark({
    runId: 'channel-original',
    toolCallId: 'channel-tool',
    toolName: 'lookup',
    effect: 'read',
  });
  await s.update('channel-original', {
    status: 'finished',
    partialText: 'Stored answer',
  });
  await s.setNow(T0 + RUN_RETENTION_MS + 1000);
  await s.reopen();
  expect(await s.get('channel-original')).toBeUndefined();
  expect(await s.wasChannelRunPruned('channel-original')).toBe(true);
  expect(await s.columnsOf('channel_run_tombstones')).toEqual([
    'run_id',
    'status',
  ]);
  expect(await s.rowCount('turn_tool_marks')).toBe(0);
  expect(await s.rowCount('turn_run_segments')).toBe(0);
});

describe('channel runs over the SQLite store', () => {
  it('reads a channel row back as a channel run in every lookup', async () => {
    const s = stub('channel-client-reads');
    await s.setNow(T0);
    await s.create({
      runId: 'channel-read',
      sessionId: '$session',
      requestId: 'wa:read',
      client: 'channel',
      status: 'queued',
      request: '{}',
      checkpointId: null,
      instanceId: 'i1',
    });
    expect((await s.get('channel-read'))?.client).toBe('channel');
    expect((await s.activeForSession('$session'))?.client).toBe('channel');
    expect((await s.listActive()).map((r) => r.client)).toEqual(['channel']);
    expect((await s.queuedForSession('$session'))[0]?.client).toBe('channel');
    expect((await s.listRecent())[0]?.client).toBe('channel');
  });

  it('keeps the finished reply and hands onRunEnded a channel record when the coordinator drives the run', async () => {
    const s = stub('channel-coordinated');
    await s.setNow(T0);
    const result = await s.coordinateRun({
      runId: 'channel-run',
      client: 'channel',
      reply: 'Here is your plan',
    });
    expect(result.endedClient).toBe('channel');
    expect(result.stored).toMatchObject({
      client: 'channel',
      status: 'finished',
      partialText: 'Here is your plan',
      messageId: 'msg-channel-run',
    });
    expect(result.summary).toMatchObject({
      runId: 'channel-run',
      client: 'channel',
      status: 'finished',
    });
  });

  it('still drops the reply text of a finished portal run', async () => {
    const s = stub('portal-coordinated');
    await s.setNow(T0);
    const result = await s.coordinateRun({
      runId: 'portal-run',
      client: 'portal',
      reply: 'Portal reply',
    });
    expect(result.endedClient).toBe('portal');
    expect(result.stored).toMatchObject({
      client: 'portal',
      status: 'finished',
      partialText: null,
    });
    expect(result.summary?.client).toBe('portal');
  });
});

it('prunes ended runs set-based while retaining every unknown external-write claim', async () => {
  const s = stub('prune-equivalence');
  const { legacy, current, transactions, receiptPlan } =
    await s.pruneEquivalence();
  expect(current).toEqual({
    ...legacy,
    turn_write_claims: [
      ...legacy.turn_write_claims,
      {
        fingerprint: 'old',
        run_id: 'x',
        session_id: 's',
        started_at: '2026-09-13T10:00:00.000Z',
        state: 'pending',
        tool_name: 't',
      },
    ],
  });
  expect(transactions).toBe(1);
  // What survives: fresh and active runs, every tombstone, and the
  // receipts of runs that are not tombstoned.
  expect(current.turn_runs).toHaveLength(8);
  expect(current.turn_tool_marks).toHaveLength(8);
  expect(current.channel_run_tombstones).toHaveLength(32);
  expect(current.channel_requests.map((r) => r.run_id)).toEqual(
    [
      'ch-active-queued',
      'ch-active-recovering',
      'ch-active-running',
      'ch-fresh-0',
      'ch-fresh-1',
      'ch-fresh-2',
      'ch-fresh-3',
      'ch-fresh-4',
      'ch-never-begun',
    ].sort(),
  );
  expect(current.turn_write_claims.map((claim) => claim.fingerprint)).toEqual([
    'new',
    'old',
  ]);
  // The receipt sweep walks the receipts and looks tombstones up by key.
  expect(receiptPlan.join('\n')).toMatch(/SCAN channel_requests/);
  expect(receiptPlan.join('\n')).toMatch(/SEARCH t USING PRIMARY KEY/);
});

it('finds stale runs and old write claims through an index, not a table scan', async () => {
  const { staleRuns, oldClaims } = await stub('prune-plans').prunePlans();
  expect(staleRuns.join('\n')).toMatch(/USING (COVERING )?INDEX/);
  expect(staleRuns.join('\n')).not.toMatch(/SCAN turn_runs/);
  expect(oldClaims.join('\n')).toMatch(/USING (COVERING )?INDEX/);
  expect(oldClaims.join('\n')).not.toMatch(/SCAN turn_write_claims/);
});

it('closes a finished run in one transaction, without reading back what it wrote', async () => {
  const s = stub('run-close-work');
  await s.setNow(T0);
  const result = await s.coordinateRun({
    runId: 'closed-once',
    client: 'portal',
    reply: 'Done',
  });
  expect(result.work).toEqual({ transactions: 1, reads: 0 });
  // What onRunEnded is handed matches the row as stored.
  expect(result.ended).toEqual(result.stored);
  expect(result.stored).toMatchObject({ status: 'finished', lastSeq: 1 });
  expect(await s.countSegments('closed-once')).toBe(0);
});
