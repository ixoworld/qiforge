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
    expect(await s.list()).toHaveLength(1);
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
    expect(await s.list()).toHaveLength(2);
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
      roomId: '!tasks-test-room:example.org',
    });
    await s.simulateReset();
    await s.setSendBehavior('ok');
    await s.tick(Date.now() + 10_000);
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'ready',
      delivery: 'delivered',
      output: ready.output,
    });
    expect(await s.turnRequests()).toHaveLength(1);
  });

  it('persists cancellation before aborting and drops late output', async () => {
    const s = stub('cancel');
    await s.init();
    await s.setTurnBehavior('hang');
    const queued = snapshot(await s.startTopic('operation', request));
    const tick = s.tick(Date.now() + 1000);
    await expect.poll(async () => (await s.turnRequests()).length).toBe(1);
    expect(snapshot(await s.cancelTopic('operation')).status).toBe('stopping');
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

  it('keeps historical stored output when cancelled during delivery without calling it ready', async () => {
    const s = stub('cancel-delivery');
    await s.init();
    await s.setSendBehavior('fail');
    await s.startTopic('operation', request);
    await s.tick(Date.now() + 1000);
    const prior = snapshot(await s.readTopic('operation'));
    const cancelled = snapshot(await s.cancelTopic('operation'));
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      output: prior.output,
      delivery: 'pending',
    });
    await s.simulateReset();
    await s.tick(Date.now() + 10_000);
    expect(snapshot(await s.readTopic('operation')).status).toBe('cancelled');
    expect(await s.turnRequests()).toHaveLength(1);
  });

  it('does not resurrect cancellation when an in-flight delivery is acknowledged', async () => {
    const s = stub('cancel-send');
    await s.init();
    await s.setSendBehavior('hang');
    await s.startTopic('operation', request);
    const tick = s.tick(Date.now() + 1000);
    await expect.poll(async () => (await s.sentMessages()).length).toBe(1);
    expect(snapshot(await s.cancelTopic('operation')).status).toBe('cancelled');
    await s.releaseSends();
    await tick;
    expect(snapshot(await s.readTopic('operation'))).toMatchObject({
      status: 'cancelled',
      delivery: 'delivered',
      output: { markdown: 'task run output' },
    });
  });

  it('reports a completed execution cannot be cancelled and keeps its receipt readable', async () => {
    const s = stub('too-late');
    await s.init();
    await s.startTopic('operation', request);
    await s.tick(Date.now() + 1000);
    expect(await s.cancelTopic('operation')).toMatchObject({
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
});
