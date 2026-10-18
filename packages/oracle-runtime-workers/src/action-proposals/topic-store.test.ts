import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  TopicProposalV2Schema,
  BeginTopicStepResultSchema,
  type TopicStepId,
} from '@ixo/ixo-transaction/topic-proposals';
import { OWNER } from './fixtures/proposal';
import { actor, executor, subject } from './fixtures/topic';
const stub = (name: string) =>
  env.ACTION_PROPOSAL_TEST.get(
    env.ACTION_PROPOSAL_TEST.idFromName(`topic-${name}`),
  );
const parse = (raw: string | null) =>
  TopicProposalV2Schema.parse(JSON.parse(raw!));
describe('durable topic effect journal', () => {
  it('allows one claim and one effect permit across simultaneous devices and restarts', async () => {
    const s = stub('race');
    const p = parse(await s.topicCreate(JSON.stringify(await subject())));
    const claims = await Promise.allSettled([
      s.topicTransition(OWNER, p.id, 'claim', p.digest),
      s.topicTransition(OWNER, p.id, 'claim', p.digest),
    ]);
    expect(claims.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    const input = JSON.stringify({
      digest: p.digest,
      step: 'anchor',
      executor,
    });
    const starts = await Promise.all([
      s.topicBegin(OWNER, p.id, input),
      s.topicBegin(OWNER, p.id, input),
    ]);
    const results = starts.map((r) =>
      BeginTopicStepResultSchema.parse(JSON.parse(r!)),
    );
    expect(results.filter((r) => r.status === 'permitted')).toHaveLength(1);
    await s.reopen();
    const duplicate = BeginTopicStepResultSchema.parse(
      JSON.parse((await s.topicBegin(OWNER, p.id, input))!),
    );
    expect(duplicate.status).toBe('already_started');
    expect(
      JSON.parse(
        (await s.topicBegin(
          OWNER,
          p.id,
          JSON.stringify({ digest: p.digest, step: 'body', executor }),
        ))!,
      ).error,
    ).toContain('verified root');
    expect(JSON.parse(await s.topicGet('did:ixo:other', p.id))).toBeNull();
  });
  it('restores verified references after every send and emits a real Matrix receipt', async () => {
    const s = stub('steps');
    const p = parse(await s.topicCreate(JSON.stringify(await subject())));
    await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const events: Record<string, unknown> = {};
    const states: unknown[] = [];
    let final = p;
    for (const step of [
      'anchor',
      'body',
      'operation',
      'snapshot',
    ] satisfies TopicStepId[]) {
      const result = BeginTopicStepResultSchema.parse(
        JSON.parse(
          (await s.topicBegin(
            OWNER,
            p.id,
            JSON.stringify({ digest: p.digest, step, executor }),
          ))!,
        ),
      );
      if (result.status !== 'permitted') throw new Error('Missing permit');
      const effect = result.permit.effect;
      if (effect.kind !== 'matrix') throw new Error('Expected Matrix');
      const eventId = `$${step}`;
      const event = {
        event_id: eventId,
        type: effect.eventType,
        sender: actor,
        room_id: effect.roomId,
        content: effect.content,
        ...(effect.stateKey ? { state_key: effect.stateKey } : {}),
      };
      events[eventId] = event;
      if (step === 'snapshot') states.push(event);
      await s.reopen();
      final = parse(
        await s.topicReconcile(
          OWNER,
          p.id,
          JSON.stringify({
            v: 2,
            references: [{ kind: 'matrix', step, eventId }],
          }),
          JSON.stringify(events),
          JSON.stringify(states),
        ),
      );
      expect(final.lifecycle.steps.find((v) => v.step === step)?.status).toBe(
        'verified',
      );
    }
    expect(final.lifecycle.status).toBe('succeeded');
    expect(final.lifecycle.receipt).toEqual({
      kind: 'topic-created',
      roomId: '!room:mx.test',
      topicId:
        p.action.name === 'create_topic' ? p.action.plan.identity.topicId : '',
      rootEventId: '$anchor',
      bodyEventId: '$body',
      operationEventId: '$operation',
      stateEventId: '$snapshot',
      verifiedAt: expect.any(String),
    });
    expect('transactionHash' in final.lifecycle.receipt!).toBe(false);
  });
  it('rejects forged receipt sender and preserves unknown without rearming', async () => {
    const s = stub('forged');
    const p = parse(await s.topicCreate(JSON.stringify(await subject())));
    await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const result = BeginTopicStepResultSchema.parse(
      JSON.parse(
        (await s.topicBegin(
          OWNER,
          p.id,
          JSON.stringify({ digest: p.digest, step: 'anchor', executor }),
        ))!,
      ),
    );
    if (result.status !== 'permitted') throw new Error('Missing permit');
    const e = result.permit.effect;
    const final = parse(
      await s.topicReconcile(
        OWNER,
        p.id,
        JSON.stringify({
          v: 2,
          references: [{ kind: 'matrix', step: 'anchor', eventId: '$forged' }],
        }),
        JSON.stringify({
          $forged: {
            event_id: '$forged',
            type: 'm.room.message',
            sender: '@attacker:evil.test',
            room_id: '!room:mx.test',
            content: e.kind === 'matrix' ? e.content : {},
          },
        }),
        '[]',
      ),
    );
    expect(final.lifecycle.status).toBe('unknown');
    expect(final.lifecycle.steps[0]?.status).toBe('started');
    expect(
      JSON.parse(
        (await s.topicBegin(
          OWNER,
          p.id,
          JSON.stringify({ digest: p.digest, step: 'body', executor }),
        ))!,
      ).error,
    ).toBeDefined();
  });
  it('revocation blocks untouched effects and retains read-only recovery of started effects', async () => {
    const s = stub('revoke');
    const p = parse(await s.topicCreate(JSON.stringify(await subject())));
    await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const result = BeginTopicStepResultSchema.parse(
      JSON.parse(
        (await s.topicBegin(
          OWNER,
          p.id,
          JSON.stringify({ digest: p.digest, step: 'anchor', executor }),
        ))!,
      ),
    );
    if (result.status !== 'permitted' || result.permit.effect.kind !== 'matrix')
      throw new Error('Missing Matrix permit');
    const e = result.permit.effect;
    await s.topicTransition(OWNER, p.id, 'revoke', p.digest);
    const recovered = parse(
      await s.topicReconcile(
        OWNER,
        p.id,
        JSON.stringify({
          v: 2,
          references: [{ kind: 'matrix', step: 'anchor', eventId: '$root' }],
        }),
        JSON.stringify({
          $root: {
            event_id: '$root',
            type: e.eventType,
            sender: e.sender,
            room_id: e.roomId,
            content: e.content,
          },
        }),
        '[]',
      ),
    );
    expect(recovered.lifecycle.status).toBe('revoked');
    expect(recovered.lifecycle.steps[0]?.status).toBe('verified');
    expect(
      JSON.parse(
        (await s.topicBegin(
          OWNER,
          p.id,
          JSON.stringify({ digest: p.digest, step: 'body', executor }),
        ))!,
      ).error,
    ).toContain('not claimed');
  });
});

it('returns the same invocation after restart and rejects changed evidence without extending expiry', async () => {
  const s = stub('replay');
  const input = await subject();
  const candidate = { action: 'create_topic', title: 'Harvest' };
  const { digestTopicProposalEffect } = await import('./topic-store');
  input.evidenceRefs.push(
    `candidate:${await digestTopicProposalEffect(candidate)}`,
  );
  const p = parse(await s.topicCreate(JSON.stringify(input)));
  await s.reopen();
  expect(
    parse(
      await s.topicReplay(
        OWNER,
        JSON.stringify(input.origin),
        JSON.stringify(candidate),
        ['source'],
      ),
    ),
  ).toEqual(p);
  expect(
    JSON.parse(
      await s.topicReplay(
        OWNER,
        JSON.stringify(input.origin),
        JSON.stringify({ ...candidate, title: 'Different' }),
        ['source'],
      ),
    ).error,
  ).toContain('different values');
  expect(
    JSON.parse(
      await s.topicReplay(
        OWNER,
        JSON.stringify({ ...input.origin, sessionId: '$different' }),
        JSON.stringify(candidate),
        ['source'],
      ),
    ).error,
  ).toContain('different values');
});
