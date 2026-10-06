import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
  researchInputDigest,
  type TopicResearchRequest,
  type TopicResearchResult,
} from './topic-research';
const stub = (name: string) =>
  env.TASKS_TEST.get(env.TASKS_TEST.idFromName(name));
const request: TopicResearchRequest = {
  topic: {
    id: 'one',
    roomId: '!room',
    threadId: '$thread',
    attemptId: 'attempt1',
    observedRevision: 'revision1',
  },
  title: 'Research',
  goal: 'Investigate',
  instructions: 'Evidence report',
  sources: [],
  skill: { id: 'capsule1', version: '1', digest: 'a'.repeat(64) },
  capabilities: [],
  credentialNames: [],
};
function snapshot(result: TopicResearchResult) {
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}
describe('authorized Topic research in the existing scheduler', () => {
  it('recovers concurrent identical starts and keeps conflicts and task limits explicit', async () => {
    const s = stub('research-concurrent');
    await s.init({ maxTasksPerUser: 1 });
    const results = await Promise.all([
      s.research('start', 'op1', request),
      s.research('start', 'op1', request),
    ]);
    expect(results.map(snapshot).map((x) => x.taskId)[0]).toBe(
      results.map(snapshot).map((x) => x.taskId)[1],
    );
    expect(
      snapshot(results[0] ?? { ok: false, status: 404, message: 'missing' })
        .inputDigest,
    ).toBe(await researchInputDigest(request));
    expect(
      await s.research('start', 'op1', { ...request, goal: 'changed' }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(await s.research('start', 'op2', request)).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(await s.list()).toEqual([]);
  });
  it('concurrent cancel before start and start/cancel interleavings keep a single cancelled binding', async () => {
    const s = stub('research-cancel');
    await s.init();
    await Promise.all([
      s.research('cancel', 'op1', request),
      s.research('cancel', 'op1', request),
    ]);
    expect(snapshot(await s.research('start', 'op1', request)).status).toBe(
      'cancelled',
    );
    const raced = await Promise.all([
      s.research('start', 'op2', request),
      s.research('cancel', 'op2', request),
    ]);
    expect(raced.every((x) => x.ok)).toBe(true);
    expect(snapshot(await s.research('read', 'op2', request)).status).toBe(
      'cancelled',
    );
    await s.tick(Date.now() + 1000);
    expect(await s.turnRequests()).toEqual([]);
    expect(
      await s.research('cancel', 'op2', { ...request, goal: 'changed' }),
    ).toMatchObject({ ok: false, status: 409 });
  });
  it('runs one owner profile, commits version receipts and recovers delivery without rerunning', async () => {
    const s = stub('research-result');
    await s.init();
    await s.research('start', 'op1', request);
    await s.setSendBehavior('fail');
    await s.tick(Date.now() + 1000);
    const result = snapshot(await s.research('read', 'op1', request));
    expect(result.status).toBe('ready');
    expect(result.artifacts[0]?.version).toBe(1);
    expect(result.artifacts[0]?.sha256).toBe(result.output?.sha256);
    expect((await s.turnRequests())[0]?.executionProfile).toBe(
      'topic-research-v1',
    );
    expect(await s.researchCommitCount()).toBe(1);
    await s.simulateReset();
    await s.setSendBehavior('ok');
    await s.tick(Date.now() + 10000);
    expect(await s.turnRequests()).toHaveLength(1);
    expect(await s.researchCommitCount()).toBe(1);
    expect(snapshot(await s.research('read', 'op1', request)).delivery).toBe(
      'delivered',
    );
    expect(await s.research('cancel', 'op1', request)).toMatchObject({
      ok: false,
      status: 409,
    });
  });
  it('preserves cancellation during a recovered report commit and suppresses delivery', async () => {
    const s = stub('research-recovery-cancel');
    await s.init();
    const queued = snapshot(await s.research('start', 'op1', request));
    await s.runSql(
      "INSERT INTO task_runs(run_id,task_id,started_at,state,txn_id,attempts) VALUES (?,?,?,'running',?,0)",
      ['recovered1', queued.taskId, new Date().toISOString(), 'txn-recovered1'],
    );
    await s.blockResearchCommit();
    const recovering = s.completeRecoveredRun('recovered1', 'Recovered report');
    await vi.waitFor(async () =>
      expect(await s.isResearchCommitBlocked()).toBe(true),
    );
    await s.research('cancel', 'op1', request);
    await s.unblockResearchCommit();
    await recovering;
    expect(snapshot(await s.research('read', 'op1', request)).status).toBe(
      'cancelled',
    );
    expect(await s.sentMessages()).toEqual([]);
    expect(await s.openRuns()).toEqual([]);
  });
  it('fails closed on revoked queued research and disallows generic creation of the research profile', async () => {
    const s = stub('research-revoked');
    await s.init();
    await s.setResearchAuthorized(false);
    expect(await s.researchError('op1', request)).toMatch(/revoked/);
    expect(
      await s.createResearchError({
        title: 'bypass',
        intent: 'bypass',
        schedule: {
          kind: 'once',
          at: new Date(Date.now() + 60000).toISOString(),
        },
        executionProfile: 'topic-research-v1',
      }),
    ).toMatch(/authenticated Topic/);
    await s.setResearchAuthorized(true);
    await s.research('start', 'op1', request);
    await s.setResearchAuthorized(false);
    await s.tick(Date.now() + 1000);
    expect(snapshot(await s.research('read', 'op1', request)).status).toBe(
      'failed',
    );
    expect(await s.researchCommitCount()).toBe(0);
    expect(await s.turnRequests()).toEqual([]);
  });
});
