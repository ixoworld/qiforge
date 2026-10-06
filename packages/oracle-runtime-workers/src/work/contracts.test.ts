import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ExecutionRequestSchema,
  SkillManifestSchema,
  WorkspaceBindingSchema,
  type ExecutionReceipt,
  type WakeSubscription,
} from '@ixo/common/work';
import type { WorkTestDO } from './test-do';
import { createConsequenceGuard } from './consequence-guard';
import { executionRequest, manifest } from './test-fixtures';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Cloudflare environment augmentation
  namespace Cloudflare {
    interface Env {
      WORK_TEST: DurableObjectNamespace<WorkTestDO>;
    }
  }
}
const stub = (name: string) =>
  env.WORK_TEST.get(env.WORK_TEST.idFromName(name));
const prepared = {
  request: executionRequest,
  target: {
    version: 1,
    providerId: 'ixo-sandbox',
    targetId: 'sandbox:did:ixo:user1',
    kind: 'sandbox',
    capabilities: ['pinned-skill'],
    isolation: 'principal',
    locality: 'remote',
    lifecycle: 'persistent',
  },
} satisfies Parameters<WorkTestDO['begin']>[1];
const receipt: ExecutionReceipt = {
  version: 1,
  providerId: 'ixo-sandbox',
  targetId: prepared.target.targetId,
  requestId: executionRequest.requestId,
  principalDID: executionRequest.principalDID,
  workRef: executionRequest.workRef,
  inputDigest: executionRequest.inputDigest,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  status: 'completed',
  artifacts: [],
  evidenceRefs: ['capsule1'],
  result: 'evidence',
};
const subscription: WakeSubscription = {
  version: 1,
  subscriptionId: 'wake1',
  principalDID: 'did:ixo:user1',
  source: { kind: 'topic', roomId: '!room', topicId: 'one' },
  resourceRef: 'topic:one',
  filter: { eventTypes: ['research'] },
  deliveryPolicy: 'evaluate',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  state: 'active',
  createdAt: new Date().toISOString(),
};
const event = {
  id: 'event1',
  cursor: 'revision1',
  eventType: 'research',
  resourceRef: 'topic:one',
};
describe('shared contracts and durable execution boundaries', () => {
  it('rejects unchecked credentials, entrypoint traversal and private owner paths', () => {
    expect(
      ExecutionRequestSchema.safeParse({
        ...executionRequest,
        inputs: { credential: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      SkillManifestSchema.safeParse({
        ...manifest,
        execution: { ...manifest.execution, entrypoint: '../private.py' },
      }).success,
    ).toBe(false);
    expect(
      WorkspaceBindingSchema.safeParse({
        version: 1,
        workspaceId: 'one',
        principalDID: 'did:ixo:user1',
        resourceRef: 'ixo:filesystem',
        rootPath: '/.oracles/',
      }).success,
    ).toBe(false);
    expect(
      SkillManifestSchema.safeParse({ ...manifest, authority: 'self' }).success,
    ).toBe(false);
  });
  it('rereads authority and denies admin and settlement regardless of model labels', async () => {
    let authorized = true;
    const guard = createConsequenceGuard({
      policyVersion: '1',
      allowedConsequences: ['none', 'settlement'],
      authorize: async () => authorized,
    });
    const action = {
      version: 1,
      actionId: 'action1',
      principalDID: 'did:ixo:user1',
      resourceRef: 'topic:one',
      inputDigest: 'a'.repeat(64),
      privilegePlane: 'orchestration',
      consequence: 'none',
      requiredCapabilities: [],
      evidenceRefs: [],
      decisionRefs: [],
    } satisfies Parameters<typeof guard.evaluate>[0];
    expect((await guard.evaluate(action)).decision).toBe('allow');
    authorized = false;
    expect((await guard.evaluate(action)).decision).toBe('deny');
    authorized = true;
    expect(
      (await guard.evaluate({ ...action, privilegePlane: 'admin' })).decision,
    ).toBe('deny');
    expect(
      (await guard.evaluate({ ...action, consequence: 'settlement' })).decision,
    ).toBe('deny');
  });
  it('retains uncertainty after reset and rejects different work under the same digest', async () => {
    const s = stub('unknown');
    expect((await s.begin('operation1', prepared)).state).toBe('started');
    await s.reopen();
    expect((await s.begin('operation1', prepared)).state).toBe('unknown');
    expect(
      await s.beginError('operation1', {
        ...prepared,
        request: { ...prepared.request, workRef: 'topic:other' },
      }),
    ).toMatch(/different prepared/);
  });
  it('fences complete receipt identity, persists completed replay and rejects conflicting receipts', async () => {
    const s = stub('complete');
    await s.begin('operation1', prepared);
    expect(
      await s.recordError('operation1', { ...receipt, targetId: 'different' }),
    ).toMatch(/prepared target/);
    expect(
      await s.recordError('operation1', {
        ...receipt,
        principalDID: 'did:ixo:other',
      }),
    ).toMatch(/prepared target/);
    await s.record('operation1', receipt);
    await s.reopen();
    expect((await s.begin('operation1', prepared)).receipt).toEqual(receipt);
    expect(
      await s.recordError('operation1', { ...receipt, result: 'different' }),
    ).toMatch(/different receipt/);
  });
  it('deduplicates authenticated wakes, retains cursor and revocation across reopen', async () => {
    const s = stub('wake');
    await Promise.all([
      s.register(subscription),
      s.register({
        ...subscription,
        createdAt: new Date(Date.now() + 1).toISOString(),
      }),
    ]);
    expect(await s.wake('wake1', event, false)).toEqual({ accepted: false });
    const attempts = await Promise.all([
      s.wake('wake1', event, true),
      s.wake('wake1', event, true),
    ]);
    expect(attempts.filter((x) => x.accepted)).toHaveLength(1);
    await s.reopen();
    expect((await s.subscription('wake1'))?.cursor).toBe('revision1');
    expect(
      await s.wakeError('wake1', { ...event, cursor: 'revision2' }),
    ).toMatch(/different cursor/);
    await s.revoke('wake1');
    await s.register(subscription);
    expect(await s.wake('wake1', { ...event, id: 'event2' }, true)).toEqual({
      accepted: false,
    });
  });
});
