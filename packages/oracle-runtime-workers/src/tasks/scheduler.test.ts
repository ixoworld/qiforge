/**
 * Task scheduler over a REAL `DoSqliteDatabase` inside workerd, driven
 * through `TasksTestDO` (see `test-do.ts` / `test/wrangler.test.jsonc`). The
 * gateway and agent turn are recording fakes; storage, scheduling and the
 * approval flow are the production path.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parseTaskSpec, TASK_ID_PATTERN } from './spec';
import { pendingApprovalOf } from './store';
import { TASK_SESSION_PREFIX } from './scheduler';
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
    expect(t?.lastResult?.summary).toContain('boom');
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
    expect(sent.some((m) => m.body.includes('failed 3 times in a row'))).toBe(
      true,
    );

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
    expect(sent.some((m) => m.body.includes('suggest a fix'))).toBe(true);
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
    expect(after?.lastResult?.summary).toMatch(/delivery room/);
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

    // Approving executes the run now (with the user's note) and completes it.
    const resolved = await s.resolveApproval(
      created.id,
      'approve',
      'fix the title first',
    );
    expect(resolved.resolved).toBe(true);
    const turns = await s.turnRequests();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).toContain('fix the title first');
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
