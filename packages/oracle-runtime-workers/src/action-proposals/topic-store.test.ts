import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  TopicProposalV2Schema,
  BeginTopicStepResultSchema,
  type TopicStepId,
} from '@ixo/ixo-transaction/topic-proposals';
import protobuf from 'protobufjs/minimal.js';
import {
  TxBody,
  TxRaw,
} from '@ixo/impactxclient-sdk/module/codegen/cosmos/tx/v1beta1/tx.js';
import { NOW, OWNER } from './fixtures/proposal';
import { actor, executor, grantSubject, subject } from './fixtures/topic';
const stub = (name: string) =>
  env.ACTION_PROPOSAL_TEST.get(
    env.ACTION_PROPOSAL_TEST.idFromName(`topic-${name}`),
  );
const parse = (raw: string | null) =>
  TopicProposalV2Schema.parse(JSON.parse(raw!));
/**
 * A signed transaction as a node would index it: `hash` is the real hash of
 * the bytes, `tx` the `/tx` answer. Plain writers, as in verify.test.ts:
 * workerd's Buffer polyfill breaks protobufjs's BufferWriter on strings of
 * 40 characters or more.
 */
async function encodedTransaction(
  memo: string,
  messages = [{ typeUrl: '/other.Msg', value: new Uint8Array([1]) }],
) {
  const body = TxBody.encode(
    TxBody.fromPartial({ memo, messages }),
    new protobuf.Writer(),
  ).finish();
  const bytes = TxRaw.encode(
    TxRaw.fromPartial({
      bodyBytes: body,
      authInfoBytes: new Uint8Array(),
      signatures: [new Uint8Array([1])],
    }),
    new protobuf.Writer(),
  ).finish();
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  )
    .join('')
    .toUpperCase();
  return {
    hash,
    tx: {
      result: {
        hash,
        height: '12',
        tx: btoa(String.fromCharCode(...bytes)),
        tx_result: { code: 0 },
      },
    },
  };
}
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
      executor: { ...executor, deviceId: 'DEVICEONE' },
    });
    // The same owner from the same device gets ONE frozen permit, re-issued:
    // identical effect and transaction id, so a second send is a no-op at
    // the homeserver, and a device whose pre-check failed can try again.
    const starts = await Promise.all([
      s.topicBegin(OWNER, p.id, input),
      s.topicBegin(OWNER, p.id, input),
    ]);
    const results = starts.map((r) =>
      BeginTopicStepResultSchema.parse(JSON.parse(r!)),
    );
    expect(results.map((r) => r.status)).toEqual(['permitted', 'permitted']);
    expect(results[0]).toEqual(results[1]);
    // The device id binds the permit but is never echoed: consumers parse
    // step records and permits with the identity-only executor.
    if (results[0]!.status !== 'permitted') throw new Error('Missing permit');
    expect(results[0]!.permit.executor).toEqual(executor);
    await s.reopen();
    const again = BeginTopicStepResultSchema.parse(
      JSON.parse((await s.topicBegin(OWNER, p.id, input))!),
    );
    expect(again).toEqual(results[0]);
    // Another device of the same owner is not the holder: the homeserver
    // deduplicates a transaction id per device, so it gets no permit.
    const elsewhere = BeginTopicStepResultSchema.parse(
      JSON.parse(
        (await s.topicBegin(
          OWNER,
          p.id,
          JSON.stringify({
            digest: p.digest,
            step: 'anchor',
            executor: { ...executor, deviceId: 'OTHERDEVICE' },
          }),
        ))!,
      ),
    );
    expect(elsewhere.status).toBe('already_started');
    if (elsewhere.status !== 'already_started') throw new Error('unreachable');
    expect(elsewhere.proposal.lifecycle.steps[0]).toMatchObject({
      status: 'started',
      executor,
    });
    // Once a reference is recorded the step is spoken for: no new permit.
    await s.topicReconcile(
      OWNER,
      p.id,
      JSON.stringify({
        v: 2,
        references: [{ kind: 'matrix', step: 'anchor', eventId: '$pending' }],
      }),
      '{}',
      '[]',
    );
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
  it('bounds the first step by the card expiry and the rest by the execution window', async () => {
    const s = stub('window');
    const p = parse(await s.topicCreate(JSON.stringify(await subject())));
    await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const begin = (step: TopicStepId) =>
      s.topicBegin(
        OWNER,
        p.id,
        JSON.stringify({ digest: p.digest, step, executor }),
      );
    // Nothing started by minute fifteen: the card is expired.
    await s.setNow(NOW + 15 * 60_000);
    expect(JSON.parse((await begin('anchor'))!).error).toContain('expired');
    // Started in time: the anchor is posted and verified at minute fourteen...
    await s.setNow(NOW + 14 * 60_000);
    const anchor = BeginTopicStepResultSchema.parse(
      JSON.parse((await begin('anchor'))!),
    );
    if (anchor.status !== 'permitted' || anchor.permit.effect.kind !== 'matrix')
      throw new Error('Missing permit');
    const e = anchor.permit.effect;
    await s.topicReconcile(
      OWNER,
      p.id,
      JSON.stringify({
        v: 2,
        references: [{ kind: 'matrix', step: 'anchor', eventId: '$anchor' }],
      }),
      JSON.stringify({
        $anchor: {
          event_id: '$anchor',
          type: e.eventType,
          sender: e.sender,
          room_id: e.roomId,
          content: e.content,
        },
      }),
      '[]',
    );
    // ...so the body may still start after the card expiry: the topic is
    // not left half-created at minute fifteen.
    await s.setNow(NOW + 20 * 60_000);
    expect(
      BeginTopicStepResultSchema.parse(JSON.parse((await begin('body'))!))
        .status,
    ).toBe('permitted');
    // The execution window (an hour from the claim) is the hard stop.
    await s.setNow(NOW + 61 * 60_000);
    expect(JSON.parse((await begin('body'))!).error).toContain(
      'Execution window closed',
    );
  });
  it('refuses a second grant card while another for the same account is still in progress', async () => {
    const s = stub('concurrent-grants');
    const first = parse(await s.topicCreate(JSON.stringify(grantSubject())));
    const second = parse(
      await s.topicCreate(JSON.stringify(grantSubject({ runId: 'run-2' }))),
    );
    for (const p of [first, second])
      await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const begin = (p: typeof first) =>
      s.topicBegin(
        OWNER,
        p.id,
        JSON.stringify({ digest: p.digest, step: 'grant', executor }),
      );
    expect(
      BeginTopicStepResultSchema.parse(JSON.parse((await begin(first))!))
        .status,
    ).toBe('permitted');
    expect(JSON.parse((await begin(second))!).error).toContain(
      'still in progress',
    );
    // The same owner retrying the first card gets its permit back.
    expect(
      BeginTopicStepResultSchema.parse(JSON.parse((await begin(first))!))
        .status,
    ).toBe('permitted');
  });
  it('keeps the card expiry on a permitted step that was never sent', async () => {
    const s = stub('never-sent');
    const p = parse(await s.topicCreate(JSON.stringify(await subject())));
    await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const input = JSON.stringify({
      digest: p.digest,
      step: 'anchor',
      executor,
    });
    expect(
      BeginTopicStepResultSchema.parse(
        JSON.parse((await s.topicBegin(OWNER, p.id, input))!),
      ).status,
    ).toBe('permitted');
    // Permitted at minute zero, nothing posted: at minute sixteen the card
    // has expired like any other, the permit does not outlive it.
    await s.setNow(NOW + 16 * 60_000);
    expect(
      JSON.parse((await s.topicBegin(OWNER, p.id, input))!).error,
    ).toContain('expired');
  });
  it('rebuilds the pre-release topic tables instead of failing every request', async () => {
    const s = stub('legacy-shape');
    await s.topicLegacyTable();
    const p = parse(await s.topicCreate(JSON.stringify(await subject())));
    expect(parse(await s.topicGet(OWNER, p.id))).toEqual(p);
    expect(
      JSON.parse(
        await s.topicGet(
          'did:ixo:legacy',
          'ap_00000000-0000-4000-8000-00000000dead',
        ),
      ),
    ).toBeNull();
    await s.reopen();
    expect(parse(await s.topicGet(OWNER, p.id))).toEqual(p);
  });
  it('lets the owner replace a grant reference the verifier proved is another transaction', async () => {
    const s = stub('wrong-grant-hash');
    // The steps table as first shipped, without `reference_rejected`: the
    // store adds the column on open.
    await s.topicLegacySteps();
    const p = parse(await s.topicCreate(JSON.stringify(grantSubject())));
    await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const begin = async () =>
      BeginTopicStepResultSchema.parse(
        JSON.parse(
          (await s.topicBegin(
            OWNER,
            p.id,
            JSON.stringify({ digest: p.digest, step: 'grant', executor }),
          ))!,
        ),
      ).status;
    expect(await begin()).toBe('permitted');
    const reconcile = (hash: string, tx: unknown) =>
      s.topicReconcile(
        OWNER,
        p.id,
        JSON.stringify({
          v: 2,
          references: [{ kind: 'chain', step: 'grant', transactionHash: hash }],
        }),
        '{}',
        '[]',
        JSON.stringify({ network: 'pandora-8', tx }),
      );
    // The chain holds that transaction, signed under ANOTHER card's memo:
    // provably not this card's, not one still to be indexed.
    const other = await encodedTransaction('Qi topic access ap_other');
    let current = parse(await reconcile(other.hash, other.tx));
    expect(current.lifecycle.status).toBe('unknown');
    expect(JSON.parse(await s.topicReferences(OWNER, p.id))).toEqual([]);
    // The executor gets its permit back to sign the right transaction; the
    // rejected hash is refused for good.
    expect(await begin()).toBe('permitted');
    expect(JSON.parse((await reconcile(other.hash, other.tx))!).error).toBe(
      'Step reference was rejected',
    );
    // A node answering with bytes that hash differently is a faulty node,
    // not a proof about the card: the reference stays and is retried.
    const right = 'B'.repeat(64);
    current = parse(
      await reconcile(right, {
        result: {
          hash: right,
          height: '12',
          tx: btoa('garbage'),
          tx_result: { code: 0 },
        },
      }),
    );
    expect(current.lifecycle.steps[0]).toMatchObject({
      step: 'grant',
      status: 'started',
    });
    expect(JSON.parse(await s.topicReferences(OWNER, p.id))).toEqual([
      { kind: 'chain', step: 'grant', transactionHash: right },
    ]);
    expect(await begin()).toBe('already_started');
  });
  it('blocks a card whose memo-bound transaction carries other messages instead of re-permitting it', async () => {
    const s = stub('memo-bound-mismatch');
    const p = parse(await s.topicCreate(JSON.stringify(grantSubject())));
    await s.topicTransition(OWNER, p.id, 'claim', p.digest);
    const begin = () =>
      s.topicBegin(
        OWNER,
        p.id,
        JSON.stringify({ digest: p.digest, step: 'grant', executor }),
      );
    const permitted = BeginTopicStepResultSchema.parse(
      JSON.parse((await begin())!),
    );
    if (
      permitted.status !== 'permitted' ||
      permitted.permit.effect.kind !== 'chain'
    )
      throw new Error('Missing chain permit');
    // The owner signed a transaction with the card's memo and a message
    // the card never proposed, and reports its real hash.
    const { hash, tx } = await encodedTransaction(permitted.permit.effect.memo);
    const blocked = parse(
      await s.topicReconcile(
        OWNER,
        p.id,
        JSON.stringify({
          v: 2,
          references: [{ kind: 'chain', step: 'grant', transactionHash: hash }],
        }),
        '{}',
        '[]',
        JSON.stringify({ network: 'pandora-8', tx }),
      ),
    );
    // Not set aside: the hash stays listed, the card is blocked, unknown.
    expect(blocked.lifecycle.status).toBe('unknown');
    expect(blocked.lifecycle.executionBlockedAt).toBeDefined();
    expect(JSON.parse(await s.topicReferences(OWNER, p.id))).toEqual([
      { kind: 'chain', step: 'grant', transactionHash: hash },
    ]);
    expect(JSON.parse((await begin())!).error).toBe('Execution is blocked');
  });
  it('holds the grant lock by the other step, not the other card', async () => {
    const s = stub('grant-lock');
    const begin = (p: { id: string; digest: string }) =>
      s.topicBegin(
        OWNER,
        p.id,
        JSON.stringify({ digest: p.digest, step: 'grant', executor }),
      );
    // A: permitted, never broadcast. Its lock lasts its execution window.
    const a = parse(await s.topicCreate(JSON.stringify(grantSubject())));
    await s.topicTransition(OWNER, a.id, 'claim', a.digest);
    expect(
      BeginTopicStepResultSchema.parse(JSON.parse((await begin(a))!)).status,
    ).toBe('permitted');
    await s.setNow(NOW + 61 * 60_000);
    const late = NOW + 61 * 60_000;
    const b = parse(
      await s.topicCreate(
        JSON.stringify(grantSubject({ runId: 'run-b' }, late)),
      ),
    );
    await s.topicTransition(OWNER, b.id, 'claim', b.digest);
    expect(
      BeginTopicStepResultSchema.parse(JSON.parse((await begin(b))!)).status,
    ).toBe('permitted');
    // B records a hash and is then revoked: the hash may still land, so the
    // lock holds for C until verification gives up, revoked or not.
    await s.topicReconcile(
      OWNER,
      b.id,
      JSON.stringify({
        v: 2,
        references: [
          { kind: 'chain', step: 'grant', transactionHash: 'F'.repeat(64) },
        ],
      }),
      '{}',
      '[]',
    );
    await s.topicTransition(OWNER, b.id, 'revoke', b.digest);
    const c = parse(
      await s.topicCreate(
        JSON.stringify(grantSubject({ runId: 'run-c' }, late)),
      ),
    );
    await s.topicTransition(OWNER, c.id, 'claim', c.digest);
    expect(JSON.parse((await begin(c))!).error).toContain(
      `still in progress (${b.id})`,
    );
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
