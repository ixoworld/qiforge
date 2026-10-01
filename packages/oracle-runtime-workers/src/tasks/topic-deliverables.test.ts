import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TasksTestDO } from './test-do';
import {
  markdownDigest,
  type TopicDeliverableRequest,
  type TopicDeliverableResult,
} from './topic-deliverables';

const request: TopicDeliverableRequest = {
  topic: {
    id: 'topic-one',
    roomId: '!untrusted-target:elsewhere',
    threadId: '$root',
    attemptId: 'attempt-one',
  },
  title: 'Solar brief',
  goal: 'Plan a local solar initiative',
  instructions: 'Draft a practical brief.',
  sources: [{ label: 'Survey', text: 'Ten neighbours expressed interest.' }],
};
function snapshot(result: TopicDeliverableResult) {
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}
function stub(name: string): DurableObjectStub<TasksTestDO> {
  return env.TASKS_TEST.get(env.TASKS_TEST.idFromName(`topic-api-${name}`));
}

describe('Topic deliverables on the existing scheduler', () => {
  it('concurrent retries and a restarted scheduler bind one operation before checking capacity', async () => {
    const s = stub('retry');
    await s.init({ maxTasksPerUser: 1 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => s.startTopic('operation', request)),
    );
    expect(new Set(results.map((result) => snapshot(result).taskId)).size).toBe(
      1,
    );
    expect(await s.storedTasks()).toHaveLength(1);
    expect(await s.turnRequests()).toHaveLength(0);
    await s.simulateReset();
    expect(snapshot(await s.startTopic('operation', request)).taskId).toBe(
      snapshot(results[0]!).taskId,
    );
    expect(
      await s.startTopic('operation', { ...request, goal: 'Changed' }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await s.startTopic('another', request)).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(await s.createdRooms()).toHaveLength(0);
  });

  it('persists cancellation before a delayed Start, without consuming capacity or arming an alarm', async () => {
    const s = stub('cancel-before-start');
    await s.init({ maxTasksPerUser: 1 });
    await s.startTopic('capacity', request);
    const alarms = await s.requestedAlarms();
    const cancelled = snapshot(await s.cancelTopic('operation', request));
    expect(cancelled.status).toBe('cancelled');
    expect(await s.requestedAlarms()).toEqual(alarms);
    await s.simulateReset();
    expect(snapshot(await s.startTopic('operation', request))).toEqual(
      cancelled,
    );
    expect(snapshot(await s.cancelTopic('operation', request))).toEqual(
      cancelled,
    );
    expect(await s.requestedAlarms()).toEqual(alarms);
    expect(
      await s.startTopic('operation', { ...request, goal: 'Changed' }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(
      await s.cancelTopic('operation', { ...request, goal: 'Changed' }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await s.turnRequests()).toHaveLength(0);
    const task = (await s.storedTasks()).find(
      (task) => task.id === cancelled.taskId,
    );
    expect(task?.status).toBe('cancelled');
    expect(task).not.toHaveProperty('nextRunAt');
  });

  it('does not charge active capacity for a cancellation recorded before Start', async () => {
    const s = stub('cancel-capacity');
    await s.init({ maxTasksPerUser: 1 });
    expect(snapshot(await s.cancelTopic('cancelled', request)).status).toBe(
      'cancelled',
    );
    expect(snapshot(await s.startTopic('active', request)).status).toBe(
      'queued',
    );
  });

  it.each(['cancel-first', 'start-first'])(
    'never restarts confirmed cancellation with concurrent arrivals: %s',
    async (order) => {
      const s = stub(order);
      await s.init();
      const results = await Promise.all(
        order === 'cancel-first'
          ? [
              s.cancelTopic('operation', request),
              s.startTopic('operation', request),
            ]
          : [
              s.startTopic('operation', request),
              s.cancelTopic('operation', request),
            ],
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect(snapshot(await s.readTopic('operation')).status).toBe('cancelled');
      await s.simulateReset();
      await s.tick(Date.now() + 1000);
      expect(snapshot(await s.startTopic('operation', request)).status).toBe(
        'cancelled',
      );
      expect(await s.turnRequests()).toHaveLength(0);
    },
  );

  it('does not acknowledge Start before its alarm is armed and repairs an arm failure on retry', async () => {
    const s = stub('alarm');
    await s.init();
    await s.setAlarmMode('hang');
    let acknowledged = false;
    const starting = s.startTopic('operation', request).then((result) => {
      acknowledged = true;
      return result;
    });
    await expect.poll(async () => (await s.requestedAlarms()).length).toBe(1);
    expect(acknowledged).toBe(false);
    await s.releaseAlarms();
    const original = snapshot(await starting);
    await s.setAlarmMode('fail');
    expect(await s.startTopicError('another-operation', request)).toBe(
      'Alarm storage unavailable',
    );
    const persisted = snapshot(await s.readTopic('another-operation'));
    await s.simulateReset();
    await s.setAlarmMode('ok');
    expect(
      snapshot(await s.startTopic('another-operation', request)).taskId,
    ).toBe(persisted.taskId);
    expect(snapshot(await s.startTopic('operation', request)).taskId).toBe(
      original.taskId,
    );
    expect(await s.storedTasks()).toHaveLength(2);
    expect(await s.turnRequests()).toHaveLength(0);
  });

  it('reads exact persisted output and completion time independently of delivery and never executes on GET', async () => {
    const s = stub('result');
    await s.init();
    const markdown =
      '# Solar brief\n\n' + 'Source-backed observation. '.repeat(100);
    await s.setTurnBehavior('ok', markdown);
    await s.setSendBehavior('fail');
    const queued = snapshot(await s.startTopic('operation', request));
    expect(snapshot(await s.readTopic('operation')).status).toBe('queued');
    expect(await s.turnRequests()).toHaveLength(0);
    await s.tick(Date.now() + 1000);
    const ready = snapshot(await s.readTopic('operation'));
    expect(ready.status).toBe('ready');
    expect(ready.delivery).toBe('pending');
    expect(ready.output?.markdown).toBe(markdown.trim());
    expect(ready.output?.sha256).toBe(await markdownDigest(markdown.trim()));
    expect(ready.output?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ready.output?.completedAt).toMatch(/^\d{4}-/);
    const turns = await s.turnRequests();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      executionProfile: 'supplied-context-markdown',
      sessionId: `task:${queued.taskId}`,
    });
    // The restricted turn runs without a room; only delivery resolves one.
    expect(turns[0]).not.toHaveProperty('roomId');
    await s.simulateReset();
    await s.setSendBehavior('ok');
    await s.tick(Date.now() + 10_000);
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'ready',
      delivery: 'delivered',
      output: ready.output,
    });
    expect(await s.turnRequests()).toHaveLength(1);
    expect((await s.sentMessages()).map((m) => m.roomId)).toEqual([
      '!tasks-test-room:example.org',
    ]);
  });

  it('persists cancellation before aborting and drops late output', async () => {
    const s = stub('cancel');
    await s.init();
    await s.setTurnBehavior('hang');
    const queued = snapshot(await s.startTopic('operation', request));
    const tick = s.tick(Date.now() + 1000);
    await expect.poll(async () => (await s.turnRequests()).length).toBe(1);
    expect(snapshot(await s.cancelTopic('operation', request)).status).toBe(
      'stopping',
    );
    expect(await s.abortedTurns()).toEqual([
      { sessionId: `task:${queued.taskId}`, status: 'cancelled' },
    ]);
    await s.releaseTurns();
    await tick;
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'cancelled',
    });
    expect(snapshot(await s.readTopic('operation')).output).toBeUndefined();
    expect(await s.sentMessages()).toHaveLength(0);
    await s.simulateReset();
    await s.tick(Date.now() + 10_000);
    expect(snapshot(await s.startTopic('operation', request)).status).toBe(
      'cancelled',
    );
    expect(await s.turnRequests()).toHaveLength(1);
  });

  it('refuses cancellation once execution finished while delivery is still retrying', async () => {
    const s = stub('cancel-delivery');
    await s.init();
    await s.setSendBehavior('fail');
    await s.startTopic('operation', request);
    await s.tick(Date.now() + 1000);
    const prior = snapshot(await s.readTopic('operation'));
    expect(prior).toMatchObject({ status: 'ready', delivery: 'pending' });
    expect(await s.cancelTopic('operation', request)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(snapshot(await s.readTopic('operation'))).toEqual(prior);
    // Delivery continues after the refused cancel.
    await s.simulateReset();
    await s.setSendBehavior('ok');
    await s.tick(Date.now() + 10_000);
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'ready',
      delivery: 'delivered',
      output: prior.output,
    });
    expect(await s.turnRequests()).toHaveLength(1);
  });

  it('refuses cancellation while the finished result is being sent and completes the delivery', async () => {
    const s = stub('cancel-send');
    await s.init();
    await s.setSendBehavior('hang');
    await s.startTopic('operation', request);
    const tick = s.tick(Date.now() + 1000);
    await expect.poll(async () => (await s.sentMessages()).length).toBe(1);
    expect(await s.cancelTopic('operation', request)).toMatchObject({
      ok: false,
      status: 409,
    });
    await s.releaseSends();
    await tick;
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'ready',
      delivery: 'delivered',
      output: { markdown: 'task run output' },
    });
  });

  it('reports a completed execution cannot be cancelled and keeps its receipt readable', async () => {
    const s = stub('too-late');
    await s.init();
    await s.startTopic('operation', request);
    await s.tick(Date.now() + 1000);
    expect(await s.cancelTopic('operation', request)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(snapshot(await s.readTopic('operation')).status).toBe('ready');
  });

  it('has no result for another owner and preserves the recovered-turn completion timestamp', async () => {
    const s = stub('recover');
    const other = stub('other-owner');
    await s.init();
    await other.init();
    const task = snapshot(await s.startTopic('operation', request));
    await s.injectOpenRun({
      taskId: task.taskId,
      state: 'running',
      startedAt: new Date().toISOString(),
    });
    const run = (await s.openRuns())[0]!;
    await s.simulateReset();
    await s.completeRecoveredRun(run.runId, '# Recovered exact Markdown');
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'ready',
      output: {
        markdown: '# Recovered exact Markdown',
        completedAt: expect.any(String),
      },
    });
    expect(await other.readTopic('operation')).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('keeps Topic deliverables out of the generic task surface: hidden, and never paused, edited or cancelled through it', async () => {
    const s = stub('generic-surface');
    await s.init();
    const ordinary = await s.create({
      title: 'Ordinary',
      intent: 'Do it once.',
      schedule: {
        kind: 'once',
        at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const queued = snapshot(await s.startTopic('operation', request));
    expect((await s.list()).map((task) => task.id)).toEqual([ordinary.id]);
    expect(await s.get(queued.taskId)).toBeNull();
    expect(await s.get(ordinary.id)).toMatchObject({ id: ordinary.id });
    expect(await s.errorOf({ kind: 'pause', id: queued.taskId })).toMatch(
      /cannot be paused or resumed/,
    );
    expect(await s.errorOf({ kind: 'resume', id: queued.taskId })).toMatch(
      /cannot be paused or resumed/,
    );
    expect(
      await s.errorOf({
        kind: 'update',
        id: queued.taskId,
        patch: { title: 'Edited' },
      }),
    ).toMatch(/immutable/);
    expect(await s.errorOf({ kind: 'cancel', id: queued.taskId })).toMatch(
      /Topic deliverable cancel route/,
    );
    expect(snapshot(await s.readTopic('operation')).status).toBe('queued');
    await s.tick(Date.now() + 1000);
    expect(snapshot(await s.readTopic('operation')).status).toBe('ready');
    expect(await s.abortedTurns()).toEqual([]);
  });

  it('reports a paused or failed Topic row as it is, not as a run failure', async () => {
    const s = stub('read-mapping');
    await s.init();
    const paused = snapshot(await s.startTopic('paused', request));
    const failed = snapshot(await s.startTopic('failed', request));
    // Neither state is reachable through the API: a row written elsewhere.
    await s.runSql(
      `UPDATE tasks SET status = 'paused', next_run_at = NULL WHERE id = ?`,
      [paused.taskId],
    );
    await s.runSql(
      `UPDATE tasks SET status = 'failed', next_run_at = NULL WHERE id = ?`,
      [failed.taskId],
    );
    expect(snapshot(await s.readTopic('paused')).status).toBe('paused');
    expect(snapshot(await s.readTopic('failed')).status).toBe('failed');
  });

  it('completes the deliverable when the gateway is unavailable at the alarm and delivers it later', async () => {
    const s = stub('gateway-down');
    await s.init();
    await s.setRoomAvailable(false);
    await s.startTopic('operation', request);
    await s.tick(Date.now() + 1000);
    const ready = snapshot(await s.readTopic('operation'));
    expect(ready).toMatchObject({
      status: 'ready',
      delivery: 'pending',
      output: { markdown: 'task run output' },
    });
    expect(await s.turnRequests()).toHaveLength(1);
    expect(await s.sentMessages()).toHaveLength(0);
    await s.setRoomAvailable(true);
    await s.tick(Date.now() + 10_000);
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'ready',
      delivery: 'delivered',
      output: ready.output,
    });
    expect((await s.sentMessages()).map((m) => m.roomId)).toEqual([
      '!tasks-test-room:example.org',
    ]);
    expect(await s.turnRequests()).toHaveLength(1);
  });

  it('refuses the turn of a deliverable cancelled before the turn reached its profile check', async () => {
    const s = stub('cancel-before-turn');
    await s.init();
    await s.setTurnBehavior('hang');
    await s.startTopic('operation', request);
    const tick = s.tick(Date.now() + 1000);
    await expect.poll(async () => (await s.turnRequests()).length).toBe(1);
    const [turn] = await s.turnRequests();
    if (!turn) throw new Error('no turn request');
    // The object runs this check first when the turn starts (`prepareTurn`),
    // after the durable run is registered for abort: a cancel before it is
    // refused here, one after it aborts the registered run.
    expect(await s.profileError(turn)).toBe('');
    expect(snapshot(await s.cancelTopic('operation', request)).status).toBe(
      'stopping',
    );
    expect(await s.profileError(turn)).toBe('Task is no longer active');
    await s.releaseTurns();
    await tick;
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'cancelled',
    });
    expect(snapshot(await s.readTopic('operation')).output).toBeUndefined();
  });
});
