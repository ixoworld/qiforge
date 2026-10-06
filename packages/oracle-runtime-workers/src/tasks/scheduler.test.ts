/**
 * Task scheduler over a REAL `DoSqliteDatabase` inside workerd, driven
 * through `TasksTestDO` (see `test-do.ts` / `test/wrangler.test.jsonc`). The
 * gateway and agent turn are recording fakes; storage, scheduling and the
 * approval flow are the production path.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseTaskSpec, TASK_ID_PATTERN } from './spec';
import { MAX_RUNS_KEPT_PER_TASK, pendingApprovalOf } from './store';
import {
  MAX_CONCURRENT_TASK_RUNS,
  shouldCreateDedicatedRoom,
  TASK_SESSION_PREFIX,
} from './scheduler';
import type { TasksTestDO } from './test-do';
import { TEST_ROOM_ID, TEST_USER_MATRIX_ID } from './test-do';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting the ambient `Cloudflare.Env` needs namespace syntax
  namespace Cloudflare {
    interface Env {
      TASKS_TEST: DurableObjectNamespace<TasksTestDO>;
    }
  }
}

function stub(name: string): DurableObjectStub<TasksTestDO> {
  return env.TASKS_TEST.get(env.TASKS_TEST.idFromName(name));
}

function inOneMinute(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

describe('task surface CRUD in the user database', () => {
  it('create → list → get → update → pause → resume → cancel', async () => {
    const s = stub('crud');
    await s.init(); // default floor: 300s between recurring runs

    // Preview flags problems without creating anything.
    const tooFrequent = await s.preview({
      title: 'Too frequent',
      intent: 'x',
      schedule: { kind: 'cron', cron: '* * * * *' },
    });
    expect(tooFrequent.ok).toBe(false);
    expect(tooFrequent.problems.join(' ')).toMatch(/minimum interval/);

    const past = await s.preview({
      title: 'Past',
      intent: 'x',
      schedule: { kind: 'once', at: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.ok).toBe(false);
    expect(past.problems.join(' ')).toMatch(/in the past/);

    const good = await s.preview({
      title: 'Morning Brief',
      intent: 'Summarize the news.',
      schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
    });
    expect(good.ok).toBe(true);
    expect(good.problems).toEqual([]);
    expect(good.nextRuns).toHaveLength(3);

    // Create.
    const created = await s.create({
      title: 'Morning Brief',
      intent: 'Summarize the news.',
      schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
    });
    expect(created.id).toMatch(TASK_ID_PATTERN);
    expect(created.status).toBe('active');
    expect(created.approval).toBe('never');
    expect(created.consecutiveFailures).toBe(0);
    expect(created.nextRunAt).toBeDefined();
    expect((await s.requestedAlarms()).length).toBeGreaterThan(0);

    // List + get.
    const listed = await s.list();
    expect(listed.map((t) => t.id)).toContain(created.id);
    const got = await s.get(created.id);
    expect(got?.intent).toBe('Summarize the news.');

    // The stored artifact is spec markdown that round-trips.
    const spec = await s.specOf(created.id);
    expect(spec).not.toBeNull();
    const parsed = parseTaskSpec(spec!);
    expect(parsed.frontmatter.id).toBe(created.id);
    expect(parsed.frontmatter.schedule).toEqual({
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
    });
    expect(parsed.intent).toBe('Summarize the news.');

    // Update: title + schedule reschedules.
    const updated = await s.update(created.id, {
      title: 'Evening Brief',
      schedule: { kind: 'cron', cron: '0 19 * * *', timezone: 'UTC' },
    });
    expect(updated.title).toBe('Evening Brief');
    expect(new Date(updated.nextRunAt!).getUTCHours()).toBe(19);

    // Pause clears the deadline.
    const paused = await s.pause(created.id);
    expect(paused.status).toBe('paused');
    expect(paused.nextRunAt).toBeUndefined();
    expect(await s.nextWakeAt()).toBeNull();

    // Resume recomputes it.
    const resumed = await s.resume(created.id);
    expect(resumed.status).toBe('active');
    expect(resumed.nextRunAt).toBeDefined();
    expect(await s.nextWakeAt()).toBe(Date.parse(resumed.nextRunAt!));

    // Cancel is terminal.
    const cancelled = await s.cancel(created.id);
    expect(cancelled.status).toBe('cancelled');
    expect(await s.nextWakeAt()).toBeNull();
    expect(await s.errorOf({ kind: 'resume', id: created.id })).toMatch(
      /cannot be resumed/,
    );
    expect(
      await s.errorOf({
        kind: 'update',
        id: created.id,
        patch: { title: 'Nope' },
      }),
    ).toMatch(/cannot be updated/);
  });

  it('enforces the live-task cap', async () => {
    const s = stub('limit');
    await s.init({ maxTasksPerUser: 2, minCronIntervalSec: 1 });
    await s.create({
      title: 'One',
      intent: 'x',
      schedule: { kind: 'interval', everySeconds: 600 },
    });
    await s.create({
      title: 'Two',
      intent: 'x',
      schedule: { kind: 'interval', everySeconds: 600 },
    });
    const preview = await s.preview({
      title: 'Three',
      intent: 'x',
      schedule: { kind: 'interval', everySeconds: 600 },
    });
    expect(preview.ok).toBe(false);
    expect(preview.problems.join(' ')).toMatch(/Task limit reached \(2\)/);
    expect(
      await s.errorOf({
        kind: 'create',
        input: {
          title: 'Three',
          intent: 'x',
          schedule: { kind: 'interval', everySeconds: 600 },
        },
      }),
    ).toMatch(/Task limit reached/);
  });
});

describe('scheduled runs on the alarm', () => {
  it('a cron task runs the agent, delivers to the room and advances next_run_at', async () => {
    const s = stub('cron-advance');
    await s.init();
    await s.setTurnBehavior('ok', 'Here is your brief.');
    const created = await s.create({
      title: 'Hourly Brief',
      intent: 'Say something useful.',
      schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
      // An hourly task would get its own room by default; this test is
      // about main-room delivery (see "dedicated task rooms" for the other).
      dedicatedRoom: 'no',
    });
    const firstDue = Date.parse(created.nextRunAt!);
    expect(await s.nextWakeAt()).toBe(firstDue);

    await s.tick(firstDue + 1000);

    const after = await s.get(created.id);
    expect(after?.status).toBe('active');
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.lastRunAt).toBeDefined();
    expect(after?.lastResult?.ok).toBe(true);
    expect(after?.lastResult?.summary).toBe('Here is your brief.');
    // Advanced exactly one hour boundary forward.
    expect(Date.parse(after!.nextRunAt!)).toBe(firstDue + 3_600_000);

    // Delivered to the user's room with the task header.
    const sent = await s.sentMessages();
    const delivery = sent.find((m) => m.body.includes('Here is your brief.'));
    expect(delivery?.roomId).toBe(TEST_ROOM_ID);
    expect(delivery?.body).toContain('Hourly Brief');

    // The run re-entered the SAME agent on the task's synthetic session.
    const turns = await s.turnRequests();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sessionId).toBe(`${TASK_SESSION_PREFIX}${created.id}`);
    expect(turns[0]?.client).toBe('matrix');
    expect(turns[0]?.roomId).toBe(TEST_ROOM_ID);
    expect(turns[0]?.message).toContain('Say something useful.');

    // Audit row written.
    const runs = await s.runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.ok).toBe(true);
  });

  it('a once task completes after firing', async () => {
    const s = stub('once-completes');
    await s.init();
    const at = inOneMinute();
    const created = await s.create({
      title: 'One Shot',
      intent: 'Do it once.',
      schedule: { kind: 'once', at },
    });
    expect(await s.nextWakeAt()).toBe(Date.parse(at));

    await s.tick(Date.parse(at) + 1);

    const after = await s.get(created.id);
    expect(after?.status).toBe('completed');
    expect(after?.nextRunAt).toBeUndefined();
    expect(after?.lastResult?.ok).toBe(true);
    expect(await s.nextWakeAt()).toBeNull();

    // A spurious later tick does nothing.
    await s.tick(Date.parse(at) + 120_000);
    expect(await s.turnRequests()).toHaveLength(1);
  });

  it('failures back off exponentially and stop the task at the threshold', async () => {
    const s = stub('backoff');
    await s.init({ minCronIntervalSec: 1 });
    await s.setTurnBehavior('fail');
    const created = await s.create({
      title: 'Flaky',
      intent: 'Might fail.',
      schedule: { kind: 'interval', everySeconds: 30 },
    });
    const firstDue = Date.parse(created.nextRunAt!);

    // Failure 1: backoff (60s) dominates the 30s cadence.
    await s.tick(firstDue + 1);
    let t = await s.get(created.id);
    expect(t?.status).toBe('active');
    expect(t?.consecutiveFailures).toBe(1);
    expect(t?.lastResult?.ok).toBe(false);
    // What the tools relay is plain language; the reason is in the ledger.
    expect(t?.lastResult?.summary).toBe('The run could not be completed.');
    expect((await s.runsFor(created.id))[0]?.detail).toContain('boom');
    const retry1 = Date.parse(t!.nextRunAt!);
    expect(retry1 - (firstDue + 1)).toBeGreaterThanOrEqual(60_000);

    // Failure 2: backoff doubles.
    await s.tick(retry1 + 1);
    t = await s.get(created.id);
    expect(t?.consecutiveFailures).toBe(2);
    const retry2 = Date.parse(t!.nextRunAt!);
    expect(retry2 - (retry1 + 1)).toBeGreaterThanOrEqual(120_000);

    // Failure 3: threshold reached — stopped as failed, loudly.
    await s.tick(retry2 + 1);
    t = await s.get(created.id);
    expect(t?.status).toBe('failed');
    expect(t?.consecutiveFailures).toBe(3);
    expect(t?.nextRunAt).toBeUndefined();
    expect(await s.nextWakeAt()).toBeNull();
    const sent = await s.sentMessages();
    expect(
      sent.some((m) =>
        m.body.includes('stopped after 3 unsuccessful runs in a row'),
      ),
    ).toBe(true);
    expect(sent.some((m) => /boom/.test(m.body))).toBe(false);

    // Resume resets the counter and reschedules.
    const resumed = await s.resume(created.id);
    expect(resumed.status).toBe('active');
    expect(resumed.consecutiveFailures).toBe(0);
    expect(resumed.nextRunAt).toBeDefined();
  });

  it('a failing once task stops immediately with a notice', async () => {
    const s = stub('once-fails');
    await s.init();
    await s.setTurnBehavior('fail');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Doomed',
      intent: 'x',
      schedule: { kind: 'once', at },
    });
    await s.tick(Date.parse(at) + 1);
    const after = await s.get(created.id);
    expect(after?.status).toBe('failed');
    expect(after?.consecutiveFailures).toBe(1);
    const sent = await s.sentMessages();
    expect(sent.some((m) => m.body.includes('could not be completed'))).toBe(
      true,
    );
    expect(sent.some((m) => /boom|simulated/.test(m.body))).toBe(false);
  });

  it('an unresolvable delivery room fails the run', async () => {
    const s = stub('no-room');
    await s.init();
    await s.setRoomAvailable(false);
    const at = inOneMinute();
    const created = await s.create({
      title: 'Homeless',
      intent: 'x',
      schedule: { kind: 'once', at },
    });
    await s.tick(Date.parse(at) + 1);
    const after = await s.get(created.id);
    expect(after?.status).toBe('failed');
    expect(after?.lastResult?.summary).toBe('The run could not be completed.');
    const runs = await s.runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('failed');
    expect(runs[0]?.detail).toMatch(/delivery room/);
    // The agent never ran — delivery is part of the run contract.
    expect(await s.turnRequests()).toHaveLength(0);
  });
});

describe('before-action approval flow', () => {
  it('a fire posts an approval request and waits; approve executes the run', async () => {
    const s = stub('approval-once');
    await s.init();
    await s.setTurnBehavior('ok', 'Draft published.');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Guarded Publish',
      intent: 'Publish the post.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });

    await s.tick(Date.parse(at) + 1);

    // No run happened — a request was posted and the task waits.
    expect(await s.turnRequests()).toHaveLength(0);
    const sent = await s.sentMessages();
    expect(sent.some((m) => m.body.includes('needs your approval'))).toBe(true);
    let t = await s.get(created.id);
    expect(t?.status).toBe('active');
    expect(pendingApprovalOf(t!)).toBeDefined();
    expect(t?.nextRunAt).toBeUndefined();
    expect(await s.nextWakeAt()).toBeNull();

    // Approving records the decision and arms the alarm; the alarm runs it
    // (with the user's note) and completes it.
    const resolved = await s.resolveApproval(
      created.id,
      'approve',
      'fix the title first',
    );
    expect(resolved.resolved).toBe(true);
    expect(await s.turnRequests()).toHaveLength(0);
    expect(await s.nextWakeAt()).toBeLessThanOrEqual(Date.now());
    await s.tick(Date.now());
    const turns = await s.turnRequests();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).not.toContain('fix the title first');
    expect(await s.approvalReceipts(created.id)).toEqual([
      expect.objectContaining({
        taskId: created.id,
        actorDid: 'did:ixo:taskstestuser',
        decision: 'approve',
        note: 'fix the title first',
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(turns[0]?.message).toContain('Publish the post.');
    t = await s.get(created.id);
    expect(t?.status).toBe('completed');
    expect(pendingApprovalOf(t!)).toBeUndefined();
    expect(t?.lastResult?.ok).toBe(true);
    expect(
      (await s.sentMessages()).some((m) => m.body.includes('Draft published.')),
    ).toBe(true);

    // Resolving again is a no-op.
    expect((await s.resolveApproval(created.id, 'approve')).resolved).toBe(
      false,
    );
  });

  it('reject drops the pending run without executing; a one-shot is cancelled', async () => {
    const s = stub('approval-reject');
    await s.init();
    const at = inOneMinute();
    const created = await s.create({
      title: 'Guarded Send',
      intent: 'Send the mail.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.tick(Date.parse(at) + 1);
    expect(pendingApprovalOf((await s.get(created.id))!)).toBeDefined();

    const resolved = await s.resolveApproval(created.id, 'reject');
    expect(resolved.resolved).toBe(true);
    const after = await s.get(created.id);
    expect(after?.status).toBe('cancelled');
    expect(pendingApprovalOf(after!)).toBeUndefined();
    expect(await s.turnRequests()).toHaveLength(0);
  });

  it('a recurring approval task keeps its cadence while a request is pending', async () => {
    const s = stub('approval-cron');
    await s.init();
    const created = await s.create({
      title: 'Guarded Daily',
      intent: 'Post the update.',
      schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
      approval: 'before-action',
    });
    const firstDue = Date.parse(created.nextRunAt!);
    await s.tick(firstDue + 1);
    const t = await s.get(created.id);
    expect(pendingApprovalOf(t!)).toBeDefined();
    // The next occurrence is already scheduled — an unanswered request is
    // superseded by the next fire.
    expect(Date.parse(t!.nextRunAt!)).toBe(firstDue + 24 * 3_600_000);
    expect(await s.turnRequests()).toHaveLength(0);
  });
});

describe('dedicated task rooms', () => {
  it('a before-action task always gets a "[Task] <title>" room and delivers there', async () => {
    const s = stub('rooms-approval');
    await s.init();
    const created = await s.create({
      title: 'Tweet the update',
      intent: 'Post the release note.',
      schedule: { kind: 'once', at: inOneMinute() },
      approval: 'before-action',
    });
    const rooms = await s.createdRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.name).toBe('[Task] Tweet the update');
    expect(rooms[0]!.invite).toEqual([TEST_USER_MATRIX_ID]);
    expect(created.deliveryRoomId).toBe(rooms[0]!.roomId);
    // The summary went into the new room, not the main one.
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.roomId).toBe(rooms[0]!.roomId);
    expect(sent[0]!.body).toMatch(/Tweet the update/);
    expect(sent[0]!.body).toMatch(/asks for your approval here/);
    // The record round-trips through the store with the room attached.
    const got = await s.get(created.id);
    expect(got?.deliveryRoomId).toBe(rooms[0]!.roomId);

    // The approval request lands in the dedicated room, not the main room.
    await s.tick(Date.parse(created.nextRunAt!) + 1);
    const afterFire = await s.sentMessages();
    expect(afterFire.at(-1)!.roomId).toBe(rooms[0]!.roomId);
    expect(afterFire.at(-1)!.body).toMatch(/needs your approval/);
    expect(afterFire.every((m) => m.roomId !== TEST_ROOM_ID)).toBe(true);
  });

  it('before-action creation fails loudly when the room cannot be created', async () => {
    const s = stub('rooms-approval-fail');
    await s.init();
    await s.setRoomCreation('fail');
    expect(
      await s.errorOf({
        kind: 'create',
        input: {
          title: 'Needs a room',
          intent: 'x',
          schedule: { kind: 'once', at: inOneMinute() },
          approval: 'before-action',
        },
      }),
    ).toMatch(/Could not create the task room/);
    expect(await s.list()).toEqual([]);
  });

  it('auto: frequent, long or monitoring tasks get a room; a daily brief does not', async () => {
    const s = stub('rooms-auto');
    await s.init();
    const daily = await s.create({
      title: 'Morning Brief',
      intent: 'Summarize the news.',
      schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
    });
    expect(daily.deliveryRoomId).toBeUndefined();

    const hourly = await s.create({
      title: 'Hourly check',
      intent: 'Check the queue depth.',
      schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
    });
    expect(hourly.deliveryRoomId).toMatch(/^!task-room-/);

    const watcher = await s.create({
      title: 'Price watcher',
      intent: 'Monitor the IXO price and tell me about big moves.',
      schedule: { kind: 'once', at: inOneMinute() },
    });
    expect(watcher.deliveryRoomId).toMatch(/^!task-room-/);

    const explicitNo = await s.create({
      title: 'Quiet hourly',
      intent: 'Check the queue depth.',
      schedule: { kind: 'interval', everySeconds: 3600 },
      dedicatedRoom: 'no',
    });
    expect(explicitNo.deliveryRoomId).toBeUndefined();

    const explicitYes = await s.create({
      title: 'Loud daily',
      intent: 'Summarize the news.',
      schedule: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      dedicatedRoom: 'yes',
    });
    expect(explicitYes.deliveryRoomId).toMatch(/^!task-room-/);
    expect(await s.createdRooms()).toHaveLength(3);
  });

  it('a run of a room-backed task delivers into its room; a failed room creation falls back to the main room', async () => {
    const s = stub('rooms-run');
    await s.init();
    const task = await s.create({
      title: 'Room run',
      intent: 'Say hi.',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'yes',
    });
    await s.tick(Date.parse(task.nextRunAt!) + 1);
    const sent = await s.sentMessages();
    const delivery = sent.at(-1)!;
    expect(delivery.roomId).toBe(task.deliveryRoomId);
    expect(delivery.body).toMatch(/Room run/);

    await s.setRoomCreation('fail');
    const fallback = await s.create({
      title: 'Fallback',
      intent: 'Say hi.',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'yes',
    });
    expect(fallback.deliveryRoomId).toBeUndefined();
    await s.tick(Date.parse(fallback.nextRunAt!) + 1);
    expect((await s.sentMessages()).at(-1)!.roomId).toBe(TEST_ROOM_ID);
  });
});

describe('run ledger: resets and lost delivery responses', () => {
  const NOTICE = /could not be completed|has been stopped/;

  it('a normal run moves running → delivering → delivered, one send with a fixed txn id', async () => {
    const s = stub('ledger-normal');
    await s.init();
    await s.setTurnBehavior('ok', 'brief text');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Ledger Normal',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    await s.tick(Date.parse(at) + 1);
    const runs = await s.runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('delivered');
    expect(runs[0]?.ok).toBe(true);
    expect(runs[0]?.attempts).toBe(0);
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.txnId).toBe(`task-${runs[0]?.runId}`);
    expect((await s.get(created.id))?.status).toBe('completed');
    expect(await s.openRuns()).toEqual([]);
  });

  it('a run the object lost mid-turn is closed as interrupted, never re-run; a one-shot fails with a friendly notice', async () => {
    const s = stub('ledger-interrupted-once');
    await s.init();
    const at = inOneMinute();
    const created = await s.create({
      title: 'Lost Mid Turn',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    // The previous incarnation owned the turn (row written) and died; the
    // task is still due because the schedule advances only after the turn.
    const runId = await s.injectOpenRun({
      taskId: created.id,
      state: 'running',
    });
    await s.simulateReset();
    await s.tick(Date.parse(at) + 1);

    expect(await s.turnRequests()).toHaveLength(0); // never re-run
    const runs = await s.runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(runId);
    expect(runs[0]?.state).toBe('interrupted');
    expect(runs[0]?.ok).toBe(false);
    expect(runs[0]?.detail).toMatch(/interrupted/); // technical reason stays in the ledger
    const task = await s.get(created.id);
    expect(task?.status).toBe('failed');
    expect(task?.lastResult?.ok).toBe(false);
    expect(task?.lastResult?.summary).not.toMatch(/interrupt|reset|runtime/i);
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatch(NOTICE);
    expect(sent[0]?.body).not.toMatch(/interrupt|reset|runtime|error/i);
    expect(sent[0]?.txnId).toBe(`task-${runId}-notice`);
    expect(await s.openRuns()).toEqual([]);
  });

  it('a recurring task whose run was interrupted skips the occurrence, counts one failure and keeps its cadence', async () => {
    const s = stub('ledger-interrupted-cron');
    await s.init();
    const created = await s.create({
      title: 'Lost Mid Turn Cron',
      intent: 'Do it.',
      schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
      dedicatedRoom: 'no',
    });
    const due = Date.parse(created.nextRunAt!);
    await s.injectOpenRun({ taskId: created.id, state: 'running' });
    await s.simulateReset();
    await s.tick(due + 1000);

    expect(await s.turnRequests()).toHaveLength(0);
    const task = await s.get(created.id);
    expect(task?.status).toBe('active');
    expect(task?.consecutiveFailures).toBe(1);
    expect(Date.parse(task!.nextRunAt!)).toBeGreaterThan(due);
    expect(await s.sentMessages()).toHaveLength(0); // not stopped: no notice
    expect((await s.runsFor(created.id))[0]?.state).toBe('interrupted');
  });

  it('a run lost during delivery is re-sent from the stored result under the same txn id, without a second turn', async () => {
    const s = stub('ledger-redeliver');
    await s.init();
    const at = inOneMinute();
    const created = await s.create({
      title: 'Redeliver',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    // Schedule already advanced by the dead incarnation (a one-shot loses
    // its next run), result stored, send never acknowledged.
    await s.update(created.id, {}); // no-op keeps the record valid
    const runId = await s.injectOpenRun({
      taskId: created.id,
      state: 'delivering',
      resultText: 'the stored answer',
    });
    await s.simulateReset();
    await s.tick(Date.now());

    expect(await s.turnRequests()).toHaveLength(0);
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('the stored answer');
    expect(sent[0]?.body).toContain('Redeliver');
    expect(sent[0]?.txnId).toBe(`task-${runId}`);
    const runs = await s.runsFor(created.id);
    expect(runs[0]?.state).toBe('delivered');
    expect(runs[0]?.ok).toBe(true);
    const task = await s.get(created.id);
    expect(task?.status).toBe('completed');
    expect(task?.lastResult?.summary).toBe('the stored answer');
  });

  it('a delivery whose response is lost once is retried under the same txn id: one message, one clean run', async () => {
    const s = stub('ledger-retry-once');
    await s.init();
    await s.setSendBehavior('fail-transient-once');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Retry Once',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    await s.tick(Date.parse(at) + 1);
    expect(await s.sendFailureCount()).toBe(1);
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    const runs = await s.runsFor(created.id);
    expect(runs[0]?.state).toBe('delivered');
    expect(sent[0]?.txnId).toBe(`task-${runs[0]?.runId}`);
    expect((await s.get(created.id))?.status).toBe('completed');
    expect((await s.get(created.id))?.consecutiveFailures).toBe(0);
  });

  it('a delivery round that keeps failing parks the run for a later round instead of failing the task', async () => {
    const s = stub('ledger-defer');
    await s.init({ deliveryRoundBackoffMs: [1_000, 2_000] });
    await s.setSendBehavior('fail-transient');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Deferred',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    const now = Date.parse(at) + 1;
    await s.tick(now);

    // Turn ran once; the task is not failed, the run waits for round 2.
    expect(await s.turnRequests()).toHaveLength(1);
    const task = await s.get(created.id);
    expect(task?.status).toBe('active');
    expect(task?.nextRunAt).toBeUndefined();
    expect(task?.consecutiveFailures).toBe(0);
    const open = await s.openRuns();
    expect(open).toHaveLength(1);
    expect(open[0]?.state).toBe('delivering');
    expect(open[0]?.attempts).toBe(1);
    expect(open[0]?.retryAt).toBeGreaterThanOrEqual(now + 1_000);
    expect(await s.nextWakeAt()).toBe(open[0]?.retryAt);
    expect((await s.requestedAlarms()).at(-1)).toBe(open[0]?.retryAt);
    expect(await s.sentMessages()).toHaveLength(0); // no notice: not failed

    // Too early for round 2: nothing happens.
    await s.tick(now + 500);
    expect((await s.openRuns())[0]?.attempts).toBe(1);

    // Gateway back: round 2 delivers the stored result, no second turn.
    await s.setSendBehavior('ok');
    await s.tick(open[0]!.retryAt! + 1);
    expect(await s.turnRequests()).toHaveLength(1);
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.txnId).toBe(`task-${open[0]?.runId}`);
    expect((await s.get(created.id))?.status).toBe('completed');
    expect(await s.openRuns()).toEqual([]);
  });

  it('after the last delivery round the task fails once, with one friendly notice', async () => {
    const s = stub('ledger-exhausted');
    await s.init({ deliveryRoundBackoffMs: [1, 1] });
    await s.setSendBehavior('fail-transient');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Exhausted',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    let now = Date.parse(at) + 1;
    for (let round = 0; round < 5; round += 1) {
      await s.tick(now);
      now += 10;
    }
    expect(await s.turnRequests()).toHaveLength(1);
    const task = await s.get(created.id);
    expect(task?.status).toBe('failed');
    expect(task?.lastResult?.summary).toBe(
      'The result could not be delivered.',
    );
    const runs = await s.runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('failed');
    expect(runs[0]?.attempts).toBe(4);
    expect(runs[0]?.detail).toMatch(/undeliverable after 5 rounds/);
    expect(await s.openRuns()).toEqual([]);
    // The notice itself could not be sent either (gateway still failing).
    await s.setSendBehavior('ok');
    await s.tick(now);
    expect(await s.sentMessages()).toHaveLength(0);
  });

  it('a long run alive in this instance is left alone by a concurrent alarm; a reset run is not', async () => {
    const s = stub('ledger-live');
    await s.init();
    await s.setTurnBehavior('hang', 'slow answer');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Live Long Run',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    const first = s.tick(Date.parse(at) + 1); // owns the turn, hangs
    await new Promise((r) => setTimeout(r, 50));
    expect((await s.openRuns())[0]?.state).toBe('running');
    await s.tick(Date.parse(at) + 2); // concurrent alarm: sees a live run
    expect(await s.turnRequests()).toHaveLength(1);
    expect((await s.openRuns())[0]?.state).toBe('running');
    expect(await s.releaseTurns()).toBe(1);
    await first;
    expect((await s.runsFor(created.id))[0]?.state).toBe('delivered');
    expect(await s.sentMessages()).toHaveLength(1);
  });

  it('a hard turn failure and a failing approval request still write one failed ledger row each', async () => {
    const s = stub('ledger-hard-fail');
    await s.init();
    await s.setTurnBehavior('fail');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Hard Fail',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    await s.tick(Date.parse(at) + 1);
    const runs = await s.runsFor(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('failed');
    expect(runs[0]?.detail).toMatch(/simulated turn failure/);
    const task = await s.get(created.id);
    expect(task?.status).toBe('failed');
    expect(task?.lastResult?.summary).toBe('The run could not be completed.');
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toMatch(/simulated|boom/);
    expect(await s.openRuns()).toEqual([]);
  });
});

describe('run ledger: the task changes while a run is in flight', () => {
  it('a cancel during a long run wins: no delivery, the run is closed, the task stays cancelled', async () => {
    const s = stub('ledger-cancel-mid-run');
    await s.init();
    await s.setTurnBehavior('hang', 'late answer');
    const at = inOneMinute();
    const created = await s.create({
      title: 'Cancel Mid Run',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
    });
    const running = s.tick(Date.parse(at) + 1);
    await new Promise((r) => setTimeout(r, 50));
    expect((await s.openRuns())[0]?.state).toBe('running');
    await s.cancel(created.id);
    expect(await s.releaseTurns()).toBe(1);
    await running;
    expect((await s.get(created.id))?.status).toBe('cancelled');
    expect(await s.sentMessages()).toHaveLength(0);
    const runs = await s.runsFor(created.id);
    expect(runs[0]?.state).toBe('failed');
    expect(runs[0]?.detail).toMatch(/cancelled during the run/);
    expect(await s.openRuns()).toEqual([]);
  });

  it('a pause during a long run wins the same way, and resume reschedules cleanly', async () => {
    const s = stub('ledger-pause-mid-run');
    await s.init({ minCronIntervalSec: 1 });
    await s.setTurnBehavior('hang', 'late answer');
    const created = await s.create({
      title: 'Pause Mid Run',
      intent: 'Do it.',
      schedule: { kind: 'interval', everySeconds: 60 },
      dedicatedRoom: 'no',
    });
    const due = Date.parse(created.nextRunAt!);
    const running = s.tick(due + 1);
    await new Promise((r) => setTimeout(r, 50));
    await s.pause(created.id);
    await s.releaseTurns();
    await running;
    const paused = await s.get(created.id);
    expect(paused?.status).toBe('paused');
    expect(await s.sentMessages()).toHaveLength(0);
    expect((await s.runsFor(created.id))[0]?.state).toBe('failed');
    const resumed = await s.resume(created.id);
    expect(resumed.status).toBe('active');
    expect(resumed.nextRunAt).toBeDefined();
    expect(await s.openRuns()).toEqual([]);
  });
});

describe('durable runs: a task run recovered by the object', () => {
  it('a running row whose turn run is live is left alone at reconciliation, then delivered once by completeRecoveredRun', async () => {
    const s = stub('recovered-run-delivered');
    await s.init();
    const at = inOneMinute();
    const created = await s.create({
      title: 'Recovered Run',
      intent: 'Do it.',
      schedule: { kind: 'once', at },
      dedicatedRoom: 'no',
    });
    const runId = await s.injectOpenRun({
      taskId: created.id,
      state: 'running',
    });
    await s.setTurnRunLive(runId, true);
    await s.simulateReset();
    // The due scan would fire the task again if the row were closed as
    // interrupted; with the turn run live, the row stays and nothing runs.
    await s.tick(Date.parse(at) + 1);
    expect(await s.turnRequests()).toHaveLength(0);
    expect((await s.openRuns()).map((r) => r.runId)).toEqual([runId]);
    expect((await s.get(created.id))?.status).toBe('active');

    // The object's recovery finished the turn: the result is delivered
    // under the run's fixed txn id and the one-shot completes.
    await s.setTurnRunLive(runId, false);
    await s.completeRecoveredRun(runId, 'the recovered answer');
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatch(/the recovered answer/);
    expect(sent[0]?.txnId).toBe(`task-${runId}`);
    expect(await s.openRuns()).toEqual([]);
    const task = await s.get(created.id);
    expect(task?.lastResult?.ok).toBe(true);
    expect(task?.nextRunAt).toBeUndefined();
    const runs = await s.runsFor(created.id);
    expect(runs[0]?.state).toBe('delivered');
    // A second completion for the same run is a no-op (the row is closed).
    await s.completeRecoveredRun(runId, 'again');
    expect(await s.sentMessages()).toHaveLength(1);
  });

  it('a recovered run that ended without a result is recorded as interrupted with the friendly notice', async () => {
    const s = stub('recovered-run-failed');
    await s.init();
    const created = await s.create({
      title: 'Recovered Run Failed',
      intent: 'Do it.',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    const runId = await s.injectOpenRun({
      taskId: created.id,
      state: 'running',
    });
    await s.failRecoveredRun(runId, 'interrupted: recovery did not complete');
    expect(await s.openRuns()).toEqual([]);
    const runs = await s.runsFor(created.id);
    expect(runs[0]?.state).toBe('interrupted');
    expect(runs[0]?.ok).toBe(false);
    const task = await s.get(created.id);
    expect(task?.status).toBe('failed');
    expect(task?.lastResult?.summary).not.toMatch(/interrupt|reset|runtime/i);
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.txnId).toBe(`task-${runId}-notice`);
  });

  it('a recovered recurring run advances the schedule from now and keeps the task active', async () => {
    const s = stub('recovered-run-cron');
    await s.init();
    const created = await s.create({
      title: 'Recovered Cron',
      intent: 'Do it.',
      schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
      dedicatedRoom: 'no',
    });
    const before = Date.parse(created.nextRunAt!);
    const runId = await s.injectOpenRun({
      taskId: created.id,
      state: 'running',
    });
    await s.completeRecoveredRun(runId, 'hourly result');
    const task = await s.get(created.id);
    expect(task?.status).toBe('active');
    expect(task?.consecutiveFailures).toBe(0);
    expect(Date.parse(task!.nextRunAt!)).toBeGreaterThanOrEqual(before);
    expect((await s.sentMessages())[0]?.body).toMatch(/hourly result/);
  });
});

describe('closed supplied-context task policy', () => {
  it('persists across reset, rejects mutation and forwards the profile to its isolated turn', async () => {
    const s = stub('closed-profile');
    await s.init();
    const task = await s.create({
      title: 'Brief',
      intent: 'Authorized source text',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
      executionProfile: 'supplied-context-markdown',
    });
    expect(
      parseTaskSpec((await s.specOf(task.id))!).frontmatter.executionProfile,
    ).toBe('supplied-context-markdown');
    await s.simulateReset();
    expect((await s.get(task.id))?.executionProfile).toBe(
      'supplied-context-markdown',
    );
    expect(
      await s.errorOf({
        kind: 'update',
        id: task.id,
        patch: { executionProfile: undefined },
      }),
    ).toMatch(/immutable/);
    expect(
      await s.errorOf({
        kind: 'update',
        id: task.id,
        patch: { intent: 'Use unrelated context' },
      }),
    ).toMatch(/immutable/);
    await s.tick(Date.parse(task.nextRunAt!));
    expect(await s.turnRequests()).toMatchObject([
      {
        sessionId: `task:${task.id}`,
        executionProfile: 'supplied-context-markdown',
      },
    ]);
  });

  it('checks the persisted profile and run on original and recovered requests', async () => {
    const s = stub('closed-profile-authority');
    await s.init();
    const task = await s.create({
      title: 'Brief',
      intent: 'Authorized source text',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
      executionProfile: 'supplied-context-markdown',
    });
    const taskRunId = await s.injectOpenRun({
      taskId: task.id,
      state: 'running',
    });
    const request = {
      identity: { userDid: 'did:ixo:taskstestuser' },
      sessionId: `task:${task.id}`,
      message: `[Scheduled task run — "${task.title}" (${task.id})]\nYou are executing a scheduled background task for the user. No user is present in this turn: do the work now and reply with the final result only — your reply is delivered to their chat room as the task result.\n\nTask instructions:\n${task.intent}`,
      client: 'matrix' as const,
      requestId: 'request',
      taskRunId,
      executionProfile: 'supplied-context-markdown' as const,
    };
    expect(await s.profileError(request)).toBe('');
    await s.simulateReset();
    expect(await s.profileError(JSON.parse(JSON.stringify(request)))).toBe('');
    expect(
      await s.profileError({ ...request, executionProfile: undefined }),
    ).toMatch(/persisted run/);
    expect(
      await s.profileError({ ...request, sessionId: 'ordinary-session' }),
    ).toMatch(/persisted run/);
    expect(
      await s.profileError({ ...request, taskRunId: 'another-run' }),
    ).toMatch(/persisted run/);
    expect(
      await s.profileError({
        ...request,
        sessionId: 'ordinary-session',
        executionProfile: undefined,
      }),
    ).toMatch(/persisted run/);
    await s.cancel(task.id);
    expect(await s.profileError(request)).toMatch(/no longer active/);
  });
});

describe('restricted task policy around the turn', () => {
  async function restrictedTask(
    s: DurableObjectStub<TasksTestDO>,
    title = 'Brief',
  ) {
    return s.create({
      title,
      intent: 'Authorized source text',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
      executionProfile: 'supplied-context-markdown',
    });
  }

  function runMessage(task: { id: string; title: string; intent: string }) {
    return `[Scheduled task run — "${task.title}" (${task.id})]\nYou are executing a scheduled background task for the user. No user is present in this turn: do the work now and reply with the final result only — your reply is delivered to their chat room as the task result.\n\nTask instructions:\n${task.intent}`;
  }

  async function restrictedRequest(s: DurableObjectStub<TasksTestDO>) {
    const task = await restrictedTask(s);
    const taskRunId = await s.injectOpenRun({
      taskId: task.id,
      state: 'running',
    });
    return {
      task,
      request: {
        identity: { userDid: 'did:ixo:taskstestuser' },
        sessionId: `${TASK_SESSION_PREFIX}${task.id}`,
        message: runMessage(task),
        client: 'matrix' as const,
        requestId: 'request',
        taskRunId,
        executionProfile: 'supplied-context-markdown' as const,
      },
    };
  }

  it('refuses a request that differs from the persisted task in any input', async () => {
    const s = stub('restricted-inputs');
    await s.init();
    const { request } = await restrictedRequest(s);
    expect(await s.profileError(request)).toBe('');
    expect(
      await s.profileError({ ...request, message: `${request.message}!` }),
    ).toMatch(/authorized input/);
    expect(
      await s.profileError({
        ...request,
        identity: { userDid: 'did:ixo:someoneelse' },
      }),
    ).toMatch(/authorized input/);
    expect(
      await s.profileError({
        ...request,
        attachments: [
          {
            mxcUri: 'mxc://example.org/a',
            filename: 'a.png',
            mimetype: 'image/png',
          },
        ],
      }),
    ).toMatch(/plain text only/);
    expect(
      await s.profileError({
        ...request,
        metadata: JSON.stringify({ editorRoomId: '!r' }),
      }),
    ).toMatch(/plain text only/);
  });

  it("refuses an ordinary turn on a restricted task's session", async () => {
    const s = stub('restricted-session-ordinary-turn');
    await s.init();
    const { request } = await restrictedRequest(s);
    const ordinary = {
      identity: request.identity,
      sessionId: request.sessionId,
      message: 'What did the source say?',
      client: 'portal' as const,
      requestId: 'ordinary',
    };
    expect(await s.profileError(ordinary)).toMatch(/persisted run/);
    expect(await s.isRestrictedSession(request.sessionId)).toBe(true);
  });

  it('re-checks the one-shot, no-approval policy on rows written without create()', async () => {
    const s = stub('restricted-policy-recheck');
    await s.init();
    const { task, request } = await restrictedRequest(s);
    await s.runSql('UPDATE tasks SET schedule_json = ? WHERE id = ?', [
      JSON.stringify({ kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' }),
      task.id,
    ]);
    expect(await s.profileError(request)).toMatch(/one-shot/);
    await s.runSql(
      "UPDATE tasks SET schedule_json = ?, approval = 'before-action' WHERE id = ?",
      [JSON.stringify(task.schedule), task.id],
    );
    expect(await s.profileError(request)).toMatch(/one-shot/);
  });

  it('cannot be paused or resumed, but can be cancelled', async () => {
    const s = stub('restricted-lifecycle');
    await s.init();
    const task = await restrictedTask(s);
    expect(await s.errorOf({ kind: 'pause', id: task.id })).toMatch(
      /cannot be paused or resumed/,
    );
    expect(await s.errorOf({ kind: 'resume', id: task.id })).toMatch(
      /cannot be paused or resumed/,
    );
    expect((await s.get(task.id))?.status).toBe('active');
    expect((await s.cancel(task.id)).status).toBe('cancelled');
  });

  it('delivers the result once to the main oracle room', async () => {
    const s = stub('restricted-delivery');
    await s.init();
    await s.setTurnBehavior('ok', '# Brief');
    const task = await restrictedTask(s);
    await s.tick(Date.parse(task.nextRunAt!));
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ roomId: TEST_ROOM_ID });
    expect(sent[0]?.body).toContain('# Brief');
    expect((await s.get(task.id))?.status).toBe('completed');
  });
});

describe('ordinary task runs and the run ledger', () => {
  it('refuses a recovered ordinary turn whose task run is already closed', async () => {
    const s = stub('ordinary-closed-run');
    await s.init();
    const task = await s.create({
      title: 'Hourly',
      intent: 'Check the feed',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    const taskRunId = await s.injectOpenRun({
      taskId: task.id,
      state: 'running',
    });
    const request = {
      identity: { userDid: 'did:ixo:taskstestuser' },
      sessionId: `${TASK_SESSION_PREFIX}${task.id}`,
      message: 'anything',
      client: 'matrix' as const,
      requestId: 'request',
      taskRunId,
    };
    // An open row: the original or recovered turn runs.
    expect(await s.profileError(request)).toBe('');
    // The row is closed (reported to the user as interrupted): the result
    // could no longer be delivered, so the turn is not run again.
    await s.failRecoveredRun(taskRunId, 'interrupted');
    expect(await s.profileError(request)).toMatch(/persisted run/);
    // Without a task run an ordinary task session stays usable.
    expect(await s.profileError({ ...request, taskRunId: undefined })).toBe('');
    expect(await s.isRestrictedSession(request.sessionId)).toBe(false);
  });
});

describe('task rows from other runtimes', () => {
  it('migrates a pre-profile tasks table: existing rows load as ordinary tasks', async () => {
    const s = stub('legacy-tasks-table');
    const now = new Date().toISOString();
    const at = inOneMinute();
    await s.initWith([
      {
        sql: `CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, spec TEXT NOT NULL,
          schedule_json TEXT NOT NULL, status TEXT NOT NULL, approval TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_run_at INTEGER,
          last_run_at TEXT, last_result_json TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0, pending_approval_at TEXT
        )`,
      },
      {
        sql: `INSERT INTO tasks (id, title, spec, schedule_json, status, approval,
          created_at, updated_at, next_run_at, consecutive_failures)
          VALUES (?, ?, ?, ?, 'active', 'never', ?, ?, ?, 0)`,
        params: [
          'task_legacy_0000001a',
          'Legacy',
          '---\nid: task_legacy_0000001a\n---\nLegacy intent\n',
          JSON.stringify({ kind: 'once', at }),
          now,
          now,
          Date.parse(at),
        ],
      },
    ]);
    const [legacy] = await s.list();
    expect(legacy).toMatchObject({ id: 'task_legacy_0000001a' });
    expect(legacy?.executionProfile).toBeUndefined();
    await s.tick(Date.parse(at));
    expect(await s.turnRequests()).toMatchObject([
      { sessionId: 'task:task_legacy_0000001a' },
    ]);
    expect((await s.turnRequests())[0]?.executionProfile).toBeUndefined();
  });

  it('skips a row with an unknown execution profile and keeps every other task working', async () => {
    const s = stub('unknown-profile');
    await s.init();
    const future = await s.create({
      title: 'Future',
      intent: 'Written by a newer runtime',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    const ordinary = await s.create({
      title: 'Ordinary',
      intent: 'Check the feed',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    await s.runSql(
      "UPDATE tasks SET execution_profile = 'future-profile' WHERE id = ?",
      [future.id],
    );
    expect((await s.list()).map((t) => t.id)).toEqual([ordinary.id]);
    expect(await s.get(future.id)).toBeNull();
    expect(await s.get(ordinary.id)).not.toBeNull();
    expect(await s.nextWakeAt()).toBe(Date.parse(ordinary.nextRunAt!));
    await s.tick(Date.parse(future.nextRunAt!) + 1_000);
    expect((await s.turnRequests()).map((r) => r.sessionId)).toEqual([
      `${TASK_SESSION_PREFIX}${ordinary.id}`,
    ]);
    const futureSession = `${TASK_SESSION_PREFIX}${future.id}`;
    expect(await s.isRestrictedSession(futureSession)).toBe(true);
    expect(
      await s.profileError({
        identity: { userDid: 'did:ixo:taskstestuser' },
        sessionId: futureSession,
        message: 'anything',
        client: 'portal',
        requestId: 'request',
      }),
    ).toMatch(/does not support/);
  });
});

/** Poll `check` until it holds (a few seconds at most). */
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('approval: the approved run executes on the alarm', () => {
  async function pendingApproval(
    s: DurableObjectStub<TasksTestDO>,
    title: string,
  ) {
    const at = inOneMinute();
    const created = await s.create({
      title,
      intent: 'Publish the post.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.tick(Date.parse(at) + 1);
    expect(pendingApprovalOf((await s.get(created.id))!)).toBeDefined();
    return created;
  }

  it('an approval given from a tool call (holding the write slot) runs on the alarm, and its write tool gets the slot', async () => {
    const s = stub('approval-write-lane');
    await s.init();
    const created = await pendingApproval(s, 'Lane Publish');
    await s.setTurnBehavior('write-tool', 'Published with the fixed title.');

    const resolved = await s.resolveApprovalAsTool(
      created.id,
      'approve',
      'fix the title first',
    );
    expect(resolved.resolved).toBe(true);
    // Nothing ran inside the tool call; the alarm is armed for now.
    expect(await s.turnRequests()).toHaveLength(0);
    expect((await s.requestedAlarms()).at(-1)).toBeLessThanOrEqual(Date.now());

    await s.tick(Date.now());
    const turns = await s.turnRequests();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).not.toContain('fix the title first');
    const task = await s.get(created.id);
    expect(task?.status).toBe('completed');
    expect(task?.lastResult?.ok).toBe(true);
    // One executed run besides the bookkeeping row of the request.
    const executed = (await s.runsFor(created.id)).filter(
      (r) => r.state !== undefined,
    );
    expect(executed.map((r) => r.state)).toEqual(['delivered']);
    expect(
      (await s.sentMessages()).some((m) =>
        m.body.includes('Published with the fixed title.'),
      ),
    ).toBe(true);
  });

  it('an approval survives a reset before the alarm and runs exactly once', async () => {
    const s = stub('approval-reset');
    await s.init();
    const created = await pendingApproval(s, 'Reset Publish');
    await s.resolveApproval(created.id, 'approve', 'go');
    await s.simulateReset();
    expect(await s.nextWakeAt()).toBeLessThanOrEqual(Date.now());

    await s.tick(Date.now());
    expect(await s.turnRequests()).toHaveLength(1);
    expect((await s.turnRequests())[0]?.message).not.toContain(
      'approved this run with a note',
    );
    expect((await s.approvalReceipts(created.id))[0]?.note).toBe('go');
    expect((await s.get(created.id))?.status).toBe('completed');

    // Neither another tick nor another reset runs it again.
    await s.tick(Date.now());
    await s.simulateReset();
    await s.tick(Date.now());
    expect(await s.turnRequests()).toHaveLength(1);
    expect(await s.nextWakeAt()).toBeNull();
  });

  it('a declined request runs nothing, from a tool call too', async () => {
    const s = stub('approval-reject-tool');
    await s.init();
    const created = await pendingApproval(s, 'Declined Publish');
    expect(
      (await s.resolveApprovalAsTool(created.id, 'reject', 'not now')).resolved,
    ).toBe(true);
    await s.tick(Date.now());
    expect(await s.turnRequests()).toHaveLength(0);
    expect((await s.get(created.id))?.status).toBe('cancelled');
    expect((await s.runsFor(created.id)).map((r) => r.detail)).toContain(
      'declined: not now',
    );
  });

  it('pausing after the approval drops the approved run', async () => {
    const s = stub('approval-then-pause');
    await s.init();
    const created = await s.create({
      title: 'Guarded Weekly',
      intent: 'Post the update.',
      schedule: { kind: 'cron', cron: '0 9 * * 1', timezone: 'UTC' },
      approval: 'before-action',
    });
    await s.tick(Date.parse(created.nextRunAt!) + 1);
    await s.resolveApproval(created.id, 'approve');
    await s.pause(created.id);
    await s.tick(Date.now());
    expect(await s.turnRequests()).toHaveLength(0);
    await s.resume(created.id);
    await s.tick(Date.now());
    expect(await s.turnRequests()).toHaveLength(0);
  });

  it('an approval request whose send response is lost is not a failure: one message, the task waits', async () => {
    const s = stub('approval-lost-response');
    await s.init();
    const at = inOneMinute();
    const created = await s.create({
      title: 'Lost Ack',
      intent: 'Publish the post.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.setSendBehavior('lost-response-once');
    await s.tick(Date.parse(at) + 1);
    expect(await s.sendFailureCount()).toBe(1);
    const requests = (await s.sentMessages()).filter((m) =>
      m.body.includes('needs your approval'),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.txnId).toBeDefined();
    const task = await s.get(created.id);
    expect(task?.status).toBe('active');
    expect(pendingApprovalOf(task!)).toBeDefined();
    expect((await s.resolveApproval(created.id, 'approve')).resolved).toBe(
      true,
    );
  });
});

describe('run ledger: what each row records', () => {
  it('a delivered row records THIS run’s output, not the previous one', async () => {
    const s = stub('ledger-detail');
    await s.init({ minCronIntervalSec: 1 });
    const created = await s.create({
      title: 'Two Outputs',
      intent: 'Say something.',
      schedule: { kind: 'interval', everySeconds: 60 },
      dedicatedRoom: 'no',
    });
    await s.setTurnBehavior('ok', 'first output');
    await s.tick(Date.parse(created.nextRunAt!) + 1);
    await s.setTurnBehavior('ok', 'second output');
    await s.tick(Date.parse((await s.get(created.id))!.nextRunAt!) + 1);
    const runs = await s.runsFor(created.id);
    expect(runs.map((r) => r.detail)).toEqual([
      'second output',
      'first output',
    ]);
  });

  it('keeps at most MAX_RUNS_KEPT_PER_TASK rows per task and no result text once an ordinary run is closed', async () => {
    const s = stub('ledger-prune');
    await s.init({ minCronIntervalSec: 1 });
    const created = await s.create({
      title: 'Chatty',
      intent: 'Say something.',
      schedule: { kind: 'interval', everySeconds: 60 },
      dedicatedRoom: 'no',
    });
    let due = Date.parse(created.nextRunAt!);
    for (let i = 0; i < MAX_RUNS_KEPT_PER_TASK + 5; i += 1) {
      await s.tick(due + 1);
      due = Date.parse((await s.get(created.id))!.nextRunAt!);
    }
    expect(await s.turnRequests()).toHaveLength(MAX_RUNS_KEPT_PER_TASK + 5);
    const rows = await s.rawRuns(created.id);
    expect(rows).toHaveLength(MAX_RUNS_KEPT_PER_TASK);
    expect(rows.every((r) => r.state === 'delivered')).toBe(true);
    expect(rows.every((r) => r.result_text === null)).toBe(true);
    expect(rows.every((r) => r.retry_at === null)).toBe(true);
  });

  it('keeps the result text of a run that is still being delivered', async () => {
    const s = stub('ledger-keep-text');
    await s.init({ deliveryRoundBackoffMs: [60_000] });
    const created = await s.create({
      title: 'Parked',
      intent: 'Do it.',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    await s.setTurnBehavior('ok', 'kept until delivered');
    await s.setSendBehavior('fail-transient');
    await s.tick(Date.parse(created.nextRunAt!) + 1);
    expect((await s.rawRuns(created.id))[0]).toMatchObject({
      state: 'delivering',
      result_text: 'kept until delivered',
    });
  });

  it('the wake query uses an index instead of scanning the run history', async () => {
    const s = stub('ledger-retry-index');
    await s.init();
    await s.startStatementLog();
    await s.nextWakeAt();
    const statements = await s.stopStatementLog();
    const retry = statements.find((st) => /MIN\(retry_at\)/.test(st.sql));
    expect(retry).toBeDefined();
    const plan = await s.queryPlan(retry!.sql, retry!.params ?? []);
    expect(plan.join('\n')).toMatch(
      /USING (COVERING )?INDEX idx_task_runs_retry/,
    );
    expect(plan.some((detail) => /^SCAN task_runs\b/.test(detail))).toBe(false);
  });
});

describe('alarm ticks', () => {
  it('an idle tick costs four statements and returns the wake it computed', async () => {
    const s = stub('tick-statements');
    await s.init();
    const created = await s.create({
      title: 'Later',
      intent: 'x',
      schedule: {
        kind: 'once',
        at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      dedicatedRoom: 'no',
    });
    await s.startStatementLog();
    const next = await s.tick(Date.now());
    const statements = await s.stopStatementLog();
    expect(next).toBe(Date.parse(created.nextRunAt!));
    expect(statements).toHaveLength(4);
  });

  it('a tick leaves arming the alarm to its caller, which arms the wake it returns', async () => {
    const s = stub('tick-no-own-arm');
    await s.init();
    const created = await s.create({
      title: 'Later',
      intent: 'x',
      schedule: {
        kind: 'once',
        at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      dedicatedRoom: 'no',
    });
    const before = (await s.requestedAlarms()).length;
    expect(await s.tick(Date.now())).toBe(Date.parse(created.nextRunAt!));
    expect(await s.requestedAlarms()).toHaveLength(before);
  });

  it('an open run waiting for its next delivery round or for its recovery reads no task row', async () => {
    const s = stub('tick-open-runs');
    await s.init();
    const parked = await s.create({
      title: 'Parked',
      intent: 'x',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    const recovering = await s.create({
      title: 'Recovering',
      intent: 'x',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    await s.injectOpenRun({
      taskId: parked.id,
      state: 'delivering',
      retryAt: Date.now() + 600_000,
    });
    const live = await s.injectOpenRun({
      taskId: recovering.id,
      state: 'running',
    });
    await s.setTurnRunLive(live, true);
    await s.startStatementLog();
    await s.tick(Date.now());
    const statements = await s.stopStatementLog();
    await s.setTurnRunLive(live, false);
    expect(
      statements.filter((st) => /FROM tasks WHERE id = \?/.test(st.sql)),
    ).toEqual([]);
    expect(statements).toHaveLength(4);
  });

  it('a task whose turn is being recovered does not make the alarm spin; its end re-arms the alarm', async () => {
    const s = stub('tick-recovery-no-spin');
    await s.init();
    const created = await s.create({
      title: 'Recovering Cron',
      intent: 'x',
      schedule: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
      dedicatedRoom: 'no',
    });
    const due = Date.parse(created.nextRunAt!);
    const runId = await s.injectOpenRun({
      taskId: created.id,
      state: 'running',
    });
    await s.setTurnRunLive(runId, true);
    await s.simulateReset();
    const alarmsBefore = (await s.requestedAlarms()).length;
    const now = due + 5_000;
    const next = await s.tick(now);
    // The overdue occurrence belongs to the recovering turn: no 1 s re-arm.
    expect(next).toBeNull();
    expect((await s.requestedAlarms()).slice(alarmsBefore)).toEqual([]);
    expect(await s.turnRequests()).toHaveLength(0);

    await s.setTurnRunLive(runId, false);
    await s.completeRecoveredRun(runId, 'recovered hourly result');
    const advanced = Date.parse((await s.get(created.id))!.nextRunAt!);
    expect(advanced).toBeGreaterThan(Date.now());
    expect((await s.requestedAlarms()).at(-1)).toBe(advanced);
    expect(await s.nextWakeAt()).toBe(advanced);
  });

  it('after long downtime a recurring task runs once and resumes its cadence, not once per missed slot', async () => {
    const s = stub('tick-catch-up');
    await s.init();
    const created = await s.create({
      title: 'Every Five',
      intent: 'x',
      schedule: { kind: 'cron', cron: '*/5 * * * *', timezone: 'UTC' },
      dedicatedRoom: 'no',
    });
    // Due a week ago: 2016 slots were missed.
    await s.runSql('UPDATE tasks SET next_run_at = ? WHERE id = ?', [
      Date.now() - 7 * 86_400_000,
      created.id,
    ]);
    const now = Date.now();
    await s.tick(now);
    await s.tick(now + 1);
    expect(await s.turnRequests()).toHaveLength(1);
    const next = Date.parse((await s.get(created.id))!.nextRunAt!);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe('alarm ticks: several due tasks', () => {
  async function dueTasks(
    s: DurableObjectStub<TasksTestDO>,
    count: number,
  ): Promise<string[]> {
    const at = inOneMinute();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const task = await s.create({
        title: `Due ${i}`,
        intent: `Task number ${i}.`,
        schedule: { kind: 'once', at },
        dedicatedRoom: 'no',
      });
      await s.setTurnTextFor(task.id, `result of task ${i}`);
      ids.push(task.id);
    }
    return ids;
  }

  it('a slow task no longer holds back the others, and none runs twice', async () => {
    const s = stub('tick-concurrent');
    await s.init();
    const [slow, ...fast] = await dueTasks(s, 3);
    await s.hangTask(slow!);
    const now = Date.now() + 120_000;
    const ticking = s.tick(now);
    await waitFor(async () => (await s.sentMessages()).length === fast.length);
    for (const id of fast) expect((await s.get(id))?.status).toBe('completed');
    expect((await s.get(slow!))?.status).toBe('active');
    expect(await s.hangingTurnCount()).toBe(1);

    // A second alarm while the slow run is live starts nothing.
    await s.tick(now + 1);
    expect(await s.turnRequests()).toHaveLength(3);

    await s.releaseTurns();
    await ticking;
    expect((await s.get(slow!))?.status).toBe('completed');
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((m) => m.txnId)).size).toBe(3);
    expect((await s.turnRequests()).map((r) => r.sessionId).sort()).toEqual(
      [slow!, ...fast].map((id) => `${TASK_SESSION_PREFIX}${id}`).sort(),
    );
  });

  it(`runs at most MAX_CONCURRENT_TASK_RUNS at once; the rest start as slots free up`, async () => {
    const s = stub('tick-concurrency-cap');
    await s.init();
    const ids = await dueTasks(s, MAX_CONCURRENT_TASK_RUNS + 1);
    for (const id of ids) await s.hangTask(id);
    const ticking = s.tick(Date.now() + 120_000);
    await waitFor(
      async () => (await s.hangingTurnCount()) === MAX_CONCURRENT_TASK_RUNS,
    );
    await s.releaseTurns();
    await ticking;
    expect(await s.turnRequests()).toHaveLength(MAX_CONCURRENT_TASK_RUNS + 1);
    // Every turn hung until released, so all four overlapped unless the cap
    // held the fourth back.
    expect(await s.peakConcurrentTurns()).toBe(MAX_CONCURRENT_TASK_RUNS);
    for (const id of ids) expect((await s.get(id))?.status).toBe('completed');
  });

  it('a task paused while it waits for a slot does not run', async () => {
    const s = stub('tick-paused-while-queued');
    await s.init({ minCronIntervalSec: 1 });
    const ids = await dueTasks(s, MAX_CONCURRENT_TASK_RUNS);
    for (const id of ids) await s.hangTask(id);
    const queued = await s.create({
      title: 'Queued',
      intent: 'x',
      schedule: { kind: 'interval', everySeconds: 600 },
      dedicatedRoom: 'no',
    });
    const now = Date.parse(queued.nextRunAt!) + 1;
    const ticking = s.tick(Math.max(now, Date.now() + 120_000));
    await waitFor(
      async () => (await s.hangingTurnCount()) === MAX_CONCURRENT_TASK_RUNS,
    );
    await s.pause(queued.id);
    await s.releaseTurns();
    await ticking;
    expect(
      (await s.turnRequests()).some((r) => r.sessionId.endsWith(queued.id)),
    ).toBe(false);
    expect((await s.get(queued.id))?.status).toBe('paused');
  });
});

describe('giving up on a delivery', () => {
  it('a one-shot whose result could not be delivered says so, without asking for a re-run', async () => {
    const s = stub('undelivered-once');
    await s.init({ deliveryRoundBackoffMs: [1] });
    await s.setTurnBehavior('ok', 'UNDELIVERABLE-RESULT');
    await s.failSendsContaining('UNDELIVERABLE-RESULT');
    const created = await s.create({
      title: 'Undeliverable',
      intent: 'Do it.',
      schedule: { kind: 'once', at: inOneMinute() },
      dedicatedRoom: 'no',
    });
    let now = Date.parse(created.nextRunAt!) + 1;
    for (let round = 0; round < 5; round += 1) {
      await s.tick(now);
      now += 10;
    }
    expect((await s.get(created.id))?.status).toBe('failed');
    const sent = await s.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatch(/could not be delivered/);
    expect(sent[0]?.body).not.toMatch(/could not be completed|run it again/);
  });

  it('a Topic deliverable that could not be delivered posts no notice and stays readable', async () => {
    const s = stub('undelivered-topic');
    await s.init({ deliveryRoundBackoffMs: [1] });
    await s.setTurnBehavior('ok', '# Brief');
    await s.failSendsContaining('# Brief');
    const request = {
      topic: {
        id: 'topic-undelivered',
        roomId: '!r:example.org',
        threadId: '$root',
        attemptId: 'a1',
      },
      title: 'Brief',
      goal: 'g',
      instructions: 'i',
      sources: [{ label: 's', text: 't' }],
    };
    await s.startTopic('op-undelivered', request);
    let now = Date.now() + 1_000;
    for (let round = 0; round < 5; round += 1) {
      await s.tick(now);
      now += 10;
    }
    expect(await s.sentMessages()).toHaveLength(0);
    const read = await s.readTopic('op-undelivered');
    expect(read).toMatchObject({
      ok: true,
      snapshot: {
        status: 'ready',
        delivery: 'failed',
        output: { markdown: '# Brief' },
      },
    });
  });
});

describe('task limits', () => {
  it('a cancelled task frees its slot; a paused one still counts', async () => {
    const s = stub('limit-slots');
    await s.init({ maxTasksPerUser: 2, minCronIntervalSec: 1 });
    const input = (title: string) => ({
      title,
      intent: 'x',
      schedule: { kind: 'interval' as const, everySeconds: 600 },
      dedicatedRoom: 'no' as const,
    });
    const one = await s.create(input('One'));
    const two = await s.create(input('Two'));
    await s.pause(two.id);
    expect(await s.errorOf({ kind: 'create', input: input('Three') })).toMatch(
      /Task limit reached \(2\)/,
    );
    await s.cancel(one.id);
    const three = await s.create(input('Three'));
    expect(three.status).toBe('active');
    const once = await s.errorOf({
      kind: 'create',
      input: {
        title: 'Four',
        intent: 'x',
        schedule: { kind: 'once', at: inOneMinute() },
      },
    });
    expect(once).toMatch(/Task limit reached/);
  });
});

describe('task rows from older runtimes: the run ledger', () => {
  it('migrates a pre-ledger task_runs table: rows survive, the wake index exists and approvals work', async () => {
    const s = stub('legacy-task-runs');
    const now = new Date().toISOString();
    await s.initWith([
      {
        sql: `CREATE TABLE task_runs (
          run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at TEXT NOT NULL,
          finished_at TEXT, ok INTEGER, detail TEXT
        )`,
      },
      {
        sql: `INSERT INTO task_runs (run_id, task_id, started_at, finished_at, ok, detail)
          VALUES ('old-run', 'task_old_0000000a', ?, ?, 1, 'old result')`,
        params: [now, now],
      },
    ]);
    expect(await s.runsFor('task_old_0000000a')).toMatchObject([
      { runId: 'old-run', ok: true, detail: 'old result' },
    ]);
    await s.startStatementLog();
    await s.nextWakeAt();
    const retry = (await s.stopStatementLog()).find((st) =>
      /MIN\(retry_at\)/.test(st.sql),
    );
    expect(
      (await s.queryPlan(retry!.sql, retry!.params ?? [])).join('\n'),
    ).toMatch(/INDEX idx_task_runs_retry/);

    const at = inOneMinute();
    const created = await s.create({
      title: 'After Migration',
      intent: 'x',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.tick(Date.parse(at) + 1);
    await s.resolveApproval(created.id, 'approve');
    await s.tick(Date.now());
    expect((await s.get(created.id))?.status).toBe('completed');
  });
});

describe('dedicated rooms by cadence', () => {
  const auto = (cron: string, timezone?: string) =>
    shouldCreateDedicatedRoom({
      schedule: { kind: 'cron', cron, ...(timezone ? { timezone } : {}) },
      intent: 'Summarize the news.',
      explicit: 'auto',
    });

  it('judges the clock cadence: a daily task in a DST timezone is daily', () => {
    expect(auto('0 9 * * *', 'Europe/London')).toBe(false);
    expect(auto('0 9 * * *', 'America/New_York')).toBe(false);
    expect(auto('0 9 * * *', 'UTC')).toBe(false);
    expect(auto('0 9,21 * * *', 'Europe/London')).toBe(true);
    expect(auto('0 * * * *', 'Europe/London')).toBe(true);
  });
});

describe('approval requests across a reset', () => {
  it.each(['approval', 'schedule'] as const)(
    'fences a due snapshot when %s changes before the ledger transaction',
    async (change) => {
      const s = stub(`run-snapshot-${change}`);
      await s.init();
      const at = inOneMinute();
      const task = await s.create({
        title: 'Fenced fire',
        intent: 'Run frozen inputs.',
        schedule: { kind: 'once', at },
        approval: 'never',
        dedicatedRoom: 'no',
      });
      await s.blockNextTransaction();
      void s.tick(Date.parse(at) + 1);
      await waitFor(() => s.isTransactionBlocked());
      if (change === 'approval')
        await s.update(task.id, { approval: 'before-action' });
      else
        await s.update(task.id, {
          schedule: {
            kind: 'once',
            at: new Date(Date.parse(at) + 3600000).toISOString(),
          },
        });
      await s.releaseTransaction();
      await s.tick(Date.parse(at) + 2);
      expect(await s.turnRequests()).toEqual([]);
      expect(
        (await s.runsFor(task.id)).filter(
          (run) => run.detail !== 'approval requested',
        ),
      ).toEqual([]);
      const current = await s.get(task.id);
      expect(current).toMatchObject(
        change === 'approval'
          ? { approval: 'before-action' }
          : { nextRunAt: new Date(Date.parse(at) + 3600000).toISOString() },
      );
    },
  );
  it('recovers a reset before the first approval message reaches Matrix', async () => {
    const s = stub('approval-reset-before-send');
    await s.init();
    const at = inOneMinute();
    const task = await s.create({
      title: 'Before send',
      intent: 'Publish once.',
      dedicatedRoom: 'no',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.setSendBehavior('hang-before-send');
    void s.tick(Date.parse(at) + 1);
    await waitFor(async () => Boolean((await s.get(task.id))?.approvalRequest));
    const pending = await s.get(task.id);
    expect(pending?.approvalRequest?.delivery).toBe('pending');
    expect(pending?.nextRunAt).toBeDefined();
    expect(
      (await s.sentMessages()).filter((message) =>
        message.body.includes('needs your approval'),
      ),
    ).toEqual([]);
    await s.simulateReset();
    await s.setSendBehavior('ok');
    await s.tick(Date.parse(pending!.nextRunAt!));
    expect((await s.get(task.id))?.approvalRequest).toEqual({
      ...pending?.approvalRequest,
      delivery: 'delivered',
    });
    expect(
      (await s.sentMessages()).filter((message) =>
        message.body.includes('needs your approval'),
      ),
    ).toEqual([
      expect.objectContaining({
        txnId: `task-approval-${task.id}-${pending?.approvalRequest?.id}`,
      }),
    ]);
    expect(await s.turnRequests()).toEqual([]);
  });
  it('reissues legacy timestamp approvals rather than executing or stranding them', async () => {
    const s = stub('approval-legacy-migration');
    await s.init();
    const at = inOneMinute();
    const task = await s.create({
      title: 'Legacy approval',
      intent: 'Publish.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.runSql(
      `UPDATE tasks SET next_run_at = NULL, pending_approval_at = ?, approved_at = ?, approval_request_json = NULL WHERE id = ?`,
      [at, Date.now(), task.id],
    );
    await s.simulateReset();
    await s.tick(Date.now() + 1);
    expect(await s.turnRequests()).toEqual([]);
    expect((await s.get(task.id))?.approvalRequest?.id).toBeDefined();
    expect((await s.get(task.id))?.approvalRequest?.delivery).toBe('delivered');
  });
  it('invalidates the exact request when inputs change before or after approval', async () => {
    const s = stub('approval-revision-bound');
    await s.init();
    const at = inOneMinute();
    const task = await s.create({
      title: 'Frozen inputs',
      intent: 'Publish version one.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.tick(Date.parse(at) + 1);
    const first = (await s.get(task.id))?.approvalRequest;
    expect(first?.digest).toMatch(/^[a-f0-9]{64}$/);
    await s.update(task.id, { intent: 'Publish version two.' });
    expect(
      await s.resolveApproval(task.id, 'approve', undefined, first?.id),
    ).toEqual({ resolved: false });
    await s.tick(Date.now() + 1);
    const second = (await s.get(task.id))?.approvalRequest;
    expect(second?.id).not.toBe(first?.id);
    expect(second?.digest).not.toBe(first?.digest);
    expect(
      await s.resolveApproval(task.id, 'approve', undefined, second?.id),
    ).toEqual({ resolved: true });
    await s.update(task.id, { intent: 'Publish version three.' });
    await s.tick(Date.now() + 1);
    expect(await s.turnRequests()).toEqual([]);
    expect((await s.get(task.id))?.intent).toBe('Publish version three.');
    expect((await s.get(task.id))?.approvalRequest?.id).not.toBe(second?.id);
  });

  it('does not overwrite an edit made while an approval message is in flight', async () => {
    const s = stub('approval-edit-during-send');
    await s.init();
    const at = inOneMinute();
    const task = await s.create({
      title: 'Edit in flight',
      intent: 'Original.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.setSendBehavior('hang');
    void s.tick(Date.parse(at) + 1);
    await waitFor(async () => Boolean((await s.get(task.id))?.approvalRequest));
    const originalId = (await s.get(task.id))?.approvalRequest?.id;
    await s.update(task.id, { intent: 'Replacement.' });
    await s.releaseSends();
    expect((await s.get(task.id))?.intent).toBe('Replacement.');
    expect(
      await s.resolveApproval(task.id, 'approve', undefined, originalId),
    ).toEqual({ resolved: false });
    expect(await s.turnRequests()).toEqual([]);
  });

  it('retries a failed approval delivery after restart with the persisted occurrence and request id', async () => {
    const s = stub('approval-delivery-retry');
    await s.init();
    const at = inOneMinute();
    const task = await s.create({
      title: 'Retry delivery',
      intent: 'Publish once.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    await s.setSendBehavior('fail');
    await s.tick(Date.parse(at) + 1);
    const pending = (await s.get(task.id))?.approvalRequest;
    expect(pending?.delivery).toBe('pending');
    const retryAt = (await s.get(task.id))?.nextRunAt;
    expect(retryAt).toBeDefined();
    await s.simulateReset();
    await s.setSendBehavior('ok');
    await s.tick(Date.parse(retryAt!));
    const delivered = (await s.get(task.id))?.approvalRequest;
    expect(delivered).toEqual({ ...pending, delivery: 'delivered' });
    expect(
      (await s.sentMessages()).find((message) =>
        message.body.includes('needs your approval'),
      )?.txnId,
    ).toBe(`task-approval-${task.id}-${pending?.id}`);
    expect(await s.turnRequests()).toEqual([]);
  });
  it('a request sent just before a reset is not posted again by the next tick', async () => {
    const s = stub('approval-reset-mid-send');
    await s.init();
    const at = inOneMinute();
    const created = await s.create({
      title: 'Reset Mid Send',
      intent: 'Publish the post.',
      schedule: { kind: 'once', at },
      approval: 'before-action',
    });
    // The send reaches Matrix, then the object resets before acknowledgement.
    await s.setSendBehavior('hang');
    void s.tick(Date.parse(at) + 1);
    await waitFor(async () =>
      (await s.sentMessages()).some((m) =>
        m.body.includes('needs your approval'),
      ),
    );
    const before = await s.get(created.id);
    expect(before?.approvalRequest?.delivery).toBe('pending');
    expect(before?.nextRunAt).toBeDefined();
    expect((await s.requestedAlarms()).at(-1)).toBe(
      Date.parse(before!.nextRunAt!),
    );
    await s.simulateReset();
    await s.setSendBehavior('ok');
    await s.tick(Date.parse(at) + 60_000);
    const requests = (await s.sentMessages()).filter((m) =>
      m.body.includes('needs your approval'),
    );
    expect(requests).toHaveLength(1);
    const recovered = await s.get(created.id);
    expect(recovered?.approvalRequest).toEqual({
      ...before?.approvalRequest,
      delivery: 'delivered',
    });
    expect(recovered?.nextRunAt).toBeUndefined();
    expect(pendingApprovalOf(recovered!)).toBeDefined();
    expect(await s.turnRequests()).toEqual([]);
  });
});
