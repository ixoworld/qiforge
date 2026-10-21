import { z } from 'zod';
import {
  InteractionResultSchema,
  type ReserveInteraction,
  type UpdateInteraction,
} from '@ixo/action-interactions';
import type { InteractionCommand } from './store';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  InteractionSchema,
  PrepareInteractionSchema,
  interactionValuesDigest,
  type Interaction,
  type PrepareInteraction,
} from '@ixo/action-interactions';
import type { ActionInteractionsTestDO } from './test-do';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Workers test binding augmentation.
  namespace Cloudflare {
    interface Env {
      ACTION_INTERACTIONS_TEST: DurableObjectNamespace<ActionInteractionsTestDO>;
    }
  }
}
const ResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: InteractionResultSchema }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
const ReadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: InteractionSchema }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
async function command(
  stub: DurableObjectStub<ActionInteractionsTestDO>,
  userDid: string,
  input: InteractionCommand,
) {
  return ResultSchema.parse(
    JSON.parse(await stub.command(userDid, JSON.stringify(input))),
  );
}
async function read(
  stub: DurableObjectStub<ActionInteractionsTestDO>,
  userDid: string,
  id: string,
  sessionId: string,
) {
  return ReadSchema.parse(JSON.parse(await stub.read(userDid, id, sessionId)));
}
const alice = 'did:ixo:alice';
function prepare(): PrepareInteraction {
  return {
    version: 1,
    requestId: crypto.randomUUID(),
    sessionId: '$session',
    owner: {
      kind: 'flow-claim',
      accountDid: alice,
      flowId: 'flow',
      runId: 'run',
      stepId: 'claim',
      collectionId: 'collection',
      schemaDigest: 'sha256:schema',
      network: 'testnet',
    },
    values: { name: 'suggested', age: 12 },
  };
}
function unwrap<T>(value: { ok: boolean; result?: T; code?: string }): T {
  if (!value.ok || value.result === undefined) throw new Error(value.code);
  return value.result;
}

describe('private interaction drafts on Workers', () => {
  it('isolates users and sessions; rejects body account substitution and unknown protocol fields', async () => {
    const a = env.ACTION_INTERACTIONS_TEST.getByName('alice');
    const b = env.ACTION_INTERACTIONS_TEST.getByName('bob');
    const input = prepare();
    const result = unwrap(await command(a, alice, { kind: 'prepare', input }));
    expect(InteractionSchema.safeParse(result.interaction).success).toBe(true);
    expect(
      await read(b, 'did:ixo:bob', result.interaction.id, input.sessionId),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(await read(a, alice, result.interaction.id, '$other')).toMatchObject(
      {
        ok: false,
        code: 'not_found',
      },
    );
    expect(
      await command(b, 'did:ixo:bob', { kind: 'prepare', input }),
    ).toMatchObject({ ok: false, code: 'account_mismatch' });
    expect(
      PrepareInteractionSchema.safeParse({ ...input, userDid: alice }).success,
    ).toBe(false);
    expect(
      PrepareInteractionSchema.safeParse({
        ...input,
        values: { invalid: () => null },
      }).success,
    ).toBe(false);
  });

  it('preserves user edits across agent patches and rejects stale concurrent writers', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('edit');
    const initial = unwrap(
      await command(stub, alice, { kind: 'prepare', input: prepare() }),
    ).interaction;
    const input = {
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId: initial.sessionId,
      expectedRevision: 1,
      kind: 'update',
      source: 'user',
      patch: { name: 'human' },
    } satisfies UpdateInteraction;
    const results = await Promise.all([
      command(stub, alice, { kind: 'update', id: initial.id, input }),
      command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: {
          ...input,
          requestId: crypto.randomUUID(),
          patch: { name: 'other' },
        },
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([
      { code: 'stale_revision' },
    ]);
    const updated = unwrap(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: {
          ...input,
          source: 'agent',
          requestId: crypto.randomUUID(),
          expectedRevision: 2,
          patch: { name: 'agent', age: 13 },
        },
      }),
    ).interaction;
    expect(updated.values).toEqual({ name: 'human', age: 13 });
  });

  it('persists user-cleared fields and preserves deletions against later agent pre-fill', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('clear-answer');
    const initial = unwrap(
      await command(stub, alice, { kind: 'prepare', input: prepare() }),
    ).interaction;
    const clear = {
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId: initial.sessionId,
      expectedRevision: 1,
      kind: 'update',
      source: 'user',
      patch: {},
      remove: ['name'],
    } satisfies UpdateInteraction;
    const cleared = unwrap(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: clear,
      }),
    ).interaction;
    expect(cleared.values).toEqual({ age: 12 });
    expect(cleared.updatedByUser).toContain('name');
    expect(
      unwrap(await read(stub, alice, initial.id, initial.sessionId)).values,
    ).toEqual({ age: 12 });
    expect(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: { ...clear, requestId: crypto.randomUUID() },
      }),
    ).toMatchObject({ code: 'stale_revision' });
    const suggested = unwrap(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: {
          ...clear,
          requestId: crypto.randomUUID(),
          expectedRevision: 2,
          source: 'agent',
          patch: { name: 'restored by agent' },
          remove: ['age'],
        },
      }),
    ).interaction;
    expect(suggested.values).toEqual({});
    const protectedClear = unwrap(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: {
          ...clear,
          requestId: crypto.randomUUID(),
          expectedRevision: 3,
          source: 'user',
          patch: { name: 'user restored' },
          remove: [],
        },
      }),
    ).interaction;
    const agentRemove = unwrap(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: {
          ...clear,
          requestId: crypto.randomUUID(),
          expectedRevision: 4,
          source: 'agent',
        },
      }),
    ).interaction;
    expect(agentRemove.values).toEqual(protectedClear.values);
  });

  it('replays request IDs, reserves once across two clients and never reopens unknown outcomes', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('reservation');
    const input = prepare();
    const first = unwrap(
      await command(stub, alice, { kind: 'prepare', input }),
    );
    expect(
      unwrap(await command(stub, alice, { kind: 'prepare', input })),
    ).toEqual({ ...first, replayed: true });
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...input, values: {} },
      }),
    ).toMatchObject({ code: 'request_conflict' });
    const reopened = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...input, requestId: crypto.randomUUID() },
      }),
    );
    expect(reopened).toEqual({
      interaction: first.interaction,
      replayed: true,
    });
    if (input.owner.kind !== 'flow-claim')
      throw new Error('Expected claim owner');
    const draft = first.interaction;
    const reserve = {
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId: input.sessionId,
      expectedRevision: 1,
      valuesDigest: await interactionValuesDigest(draft.values),
    } satisfies ReserveInteraction;
    const attempts = await Promise.all([
      command(stub, alice, { kind: 'reserve', id: draft.id, input: reserve }),
      command(stub, alice, {
        kind: 'reserve',
        id: draft.id,
        input: { ...reserve, requestId: crypto.randomUUID() },
      }),
    ]);
    const winner = attempts.find((r) => r.ok);
    if (!winner) throw new Error('No reservation won');
    const reserved = unwrap(winner).interaction;
    expect(attempts.filter((r) => r.ok)).toHaveLength(1);
    expect(reserved.reservation).toBeDefined();
    if (!reserved.reservation) throw new Error('Missing reservation');
    const unknown = unwrap(
      await command(stub, alice, {
        kind: 'observe',
        id: draft.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: input.sessionId,
          expectedRevision: 2,
          operationKey: reserved.reservation.operationKey,
          outcome: 'unknown',
        },
      }),
    ).interaction;
    expect(unknown.status).toBe('outcome-unknown');
    expect(
      await command(stub, alice, {
        kind: 'reserve',
        id: draft.id,
        input: {
          ...reserve,
          requestId: crypto.randomUUID(),
          expectedRevision: 3,
        },
      }),
    ).toMatchObject({ code: 'not_dispatchable' });
    const observed = unwrap(
      await command(stub, alice, {
        kind: 'observe',
        id: draft.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: input.sessionId,
          expectedRevision: 3,
          operationKey: reserved.reservation.operationKey,
          outcome: 'reported',
          ownerExecutionRef: 'flow-receipt',
        },
      }),
    ).interaction;
    expect(observed.status).toBe('observed');
    expect(observed).not.toHaveProperty('verified');
    // A reported operation is never replaced, even by a changed form.
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...input,
          requestId: crypto.randomUUID(),
          owner: { ...input.owner, schemaDigest: 'changed' },
        },
      }),
    ).toMatchObject({ code: 'dispatch_consumed' });
  });

  it('checks every host dispatch across sessions and consumes a reserved operation once', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName(
      'dispatch-precondition',
    );
    const input = prepare();
    if (input.owner.kind !== 'flow-claim')
      throw new Error('Expected claim owner');
    const check = { version: 1, owner: input.owner };
    const dispatch = async (value: unknown) =>
      JSON.parse(await stub.dispatch(alice, JSON.stringify(value)));
    expect(await dispatch(check)).toEqual({
      ok: true,
      result: { allowed: true, managed: false },
    });
    const draft = unwrap(
      await command(stub, alice, { kind: 'prepare', input }),
    ).interaction;
    const reserved = unwrap(
      await command(stub, alice, {
        kind: 'reserve',
        id: draft.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: input.sessionId,
          expectedRevision: 1,
          valuesDigest: await interactionValuesDigest(draft.values),
        },
      }),
    ).interaction;
    if (!reserved.reservation) throw new Error('Missing reservation');
    const bound = {
      ...check,
      cardRef: reserved.id,
      operationKey: reserved.reservation.operationKey,
      valuesDigest: reserved.reservation.valuesDigest,
    };
    expect(
      await dispatch({ ...bound, valuesDigest: '0'.repeat(64) }),
    ).toMatchObject({ code: 'review_required' });
    const attempts = await Promise.all([dispatch(bound), dispatch(bound)]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(attempts.filter((result) => !result.ok)).toMatchObject([
      { code: 'dispatch_consumed' },
    ]);
    expect(
      await dispatch({
        ...bound,
        owner: { ...input.owner, schemaDigest: 'changed-schema' },
      }),
    ).toMatchObject({ code: 'review_required' });
    await command(stub, alice, {
      kind: 'observe',
      id: reserved.id,
      input: {
        version: 1,
        requestId: crypto.randomUUID(),
        sessionId: input.sessionId,
        expectedRevision: reserved.revision,
        operationKey: reserved.reservation.operationKey,
        outcome: 'unknown',
      },
    });
    // The operation reached the claim service: neither a manually reopened
    // form, nor the card again, nor a new Companion chat may submit the step.
    expect(await dispatch(check)).toMatchObject({ code: 'dispatch_consumed' });
    expect(await dispatch(bound)).toMatchObject({ code: 'review_required' });
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...input,
          requestId: crypto.randomUUID(),
          sessionId: '$new-session',
        },
      }),
    ).toMatchObject({ code: 'dispatch_consumed' });
  });

  it('lets the ordinary form supersede a card that never reached the claim service', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('manual-supersede');
    const input = prepare();
    if (input.owner.kind !== 'flow-claim')
      throw new Error('Expected claim owner');
    const check = { version: 1, owner: input.owner };
    const dispatch = async (value: unknown) =>
      JSON.parse(await stub.dispatch(alice, JSON.stringify(value)));
    const reserve = async (draft: Interaction) =>
      command(stub, alice, {
        kind: 'reserve',
        id: draft.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: draft.sessionId,
          expectedRevision: draft.revision,
          valuesDigest: await interactionValuesDigest(draft.values),
        },
      });
    // An open draft: the manual submission goes ahead and ends the card.
    const first = unwrap(
      await command(stub, alice, { kind: 'prepare', input }),
    ).interaction;
    expect(await dispatch(check)).toEqual({
      ok: true,
      result: { allowed: true, managed: false },
    });
    const ended = unwrap(await read(stub, alice, first.id, input.sessionId));
    expect(ended).toMatchObject({
      status: 'cancelled',
      cancelReason: 'superseded',
      revision: 2,
    });
    expect(await reserve(first)).toMatchObject({ code: 'stale_revision' });
    expect(await reserve(ended)).toMatchObject({ code: 'not_dispatchable' });

    // A reservation whose dispatch check never ran is superseded too, and its
    // card can no longer pass that check.
    const second = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...input, requestId: crypto.randomUUID() },
      }),
    );
    expect(second.replayed).toBe(false);
    expect(second.interaction.id).not.toBe(first.id);
    const reserved = unwrap(await reserve(second.interaction)).interaction;
    if (!reserved.reservation) throw new Error('Missing reservation');
    expect(await dispatch(check)).toMatchObject({ ok: true });
    expect(
      await dispatch({
        ...check,
        cardRef: reserved.id,
        operationKey: reserved.reservation.operationKey,
        valuesDigest: reserved.reservation.valuesDigest,
      }),
    ).toMatchObject({ code: 'review_required' });

    // An expired draft never blocks the step either.
    const third = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...input, requestId: crypto.randomUUID() },
      }),
    ).interaction;
    await stub.advance(8 * 24 * 60 * 60 * 1000);
    expect(await dispatch(check)).toMatchObject({ ok: true });
    expect(
      unwrap(await read(stub, alice, third.id, input.sessionId)),
    ).toMatchObject({ status: 'cancelled', cancelReason: 'superseded' });
  });

  it('replaces its own stale draft for a changed form and keeps another chat off a live card', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('changed-form');
    const input = prepare();
    if (input.owner.kind !== 'flow-claim')
      throw new Error('Expected claim owner');
    const first = unwrap(
      await command(stub, alice, { kind: 'prepare', input }),
    ).interaction;
    const changed = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...input,
          requestId: crypto.randomUUID(),
          owner: { ...input.owner, schemaDigest: 'changed' },
        },
      }),
    );
    expect(changed.replayed).toBe(false);
    expect(changed.interaction.owner).toMatchObject({
      schemaDigest: 'changed',
    });
    expect(
      unwrap(await read(stub, alice, first.id, input.sessionId)),
    ).toMatchObject({ status: 'cancelled', cancelReason: 'superseded' });
    const elsewhere = {
      ...input,
      requestId: crypto.randomUUID(),
      sessionId: '$other-chat',
      owner: { ...input.owner, schemaDigest: 'changed' },
    };
    expect(
      await command(stub, alice, { kind: 'prepare', input: elsewhere }),
    ).toMatchObject({ code: 'target_in_use' });
    await stub.advance(8 * 24 * 60 * 60 * 1000);
    const adopted = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...elsewhere, requestId: crypto.randomUUID() },
      }),
    ).interaction;
    expect(adopted.sessionId).toBe('$other-chat');
    expect(adopted.status).toBe('draft');
  });

  it('lists one session through its index, newest records last', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('session-index');
    const question = (sessionId: string, n: number): PrepareInteraction => ({
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId,
      owner: { kind: 'question', requestId: `q-${n}` },
      values: { n },
    });
    for (let n = 0; n < 55; n++) {
      await stub.advance(1);
      unwrap(
        await command(stub, alice, {
          kind: 'prepare',
          input: question('$busy', n),
        }),
      );
    }
    unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: question('$quiet', 0),
      }),
    );
    const busy = z
      .array(InteractionSchema)
      .parse(JSON.parse(await stub.list(alice, '$busy')));
    expect(busy).toHaveLength(50);
    expect(busy.map((r) => r.values.n)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 5),
    );
    const quiet = z
      .array(InteractionSchema)
      .parse(JSON.parse(await stub.list(alice, '$quiet')));
    expect(quiet.map((r) => r.sessionId)).toEqual(['$quiet']);
  });

  it('retention drops abandoned drafts and keeps only the tombstones of a dispatched claim', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('retention');
    const input = prepare();
    if (input.owner.kind !== 'flow-claim')
      throw new Error('Expected claim owner');
    const abandoned = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...prepare(),
          owner: { kind: 'question', requestId: 'abandoned' },
        },
      }),
    ).interaction;
    const claim = unwrap(
      await command(stub, alice, { kind: 'prepare', input }),
    ).interaction;
    const reserved = unwrap(
      await command(stub, alice, {
        kind: 'reserve',
        id: claim.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: input.sessionId,
          expectedRevision: 1,
          valuesDigest: await interactionValuesDigest(claim.values),
        },
      }),
    ).interaction;
    if (!reserved.reservation) throw new Error('Missing reservation');
    const check = { version: 1, owner: input.owner };
    expect(
      JSON.parse(
        await stub.dispatch(
          alice,
          JSON.stringify({
            ...check,
            cardRef: reserved.id,
            operationKey: reserved.reservation.operationKey,
            valuesDigest: reserved.reservation.valuesDigest,
          }),
        ),
      ),
    ).toMatchObject({ ok: true });
    // The outcome arrives after the draft expired: still recorded.
    await stub.advance(8 * 24 * 60 * 60 * 1000);
    expect(
      unwrap(
        await command(stub, alice, {
          kind: 'observe',
          id: claim.id,
          input: {
            version: 1,
            requestId: crypto.randomUUID(),
            sessionId: input.sessionId,
            expectedRevision: reserved.revision,
            operationKey: reserved.reservation.operationKey,
            outcome: 'unknown',
          },
        }),
      ).interaction.status,
    ).toBe('outcome-unknown');
    await stub.advance(31 * 24 * 60 * 60 * 1000);
    expect(await stub.prune(alice)).toBe(2);
    const keys = await stub.keys();
    expect(keys.filter((k) => k.includes(abandoned.id))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('interaction-request:'))).toEqual(
      [],
    );
    expect(keys.filter((k) => k.startsWith('interaction-expiry:'))).toEqual([]);
    const kept = unwrap(await read(stub, alice, claim.id, input.sessionId));
    expect(kept).toMatchObject({ status: 'outcome-unknown', values: {} });
    expect(
      keys.filter((k) => k.startsWith('interaction-dispatch:')),
    ).toHaveLength(1);
    expect(
      JSON.parse(await stub.dispatch(alice, JSON.stringify(check))),
    ).toMatchObject({ code: 'dispatch_consumed' });
    expect(await stub.prune(alice)).toBe(0);
  });

  it('refuses expired and cancelled drafts', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('expiry');
    const initial = unwrap(
      await command(stub, alice, { kind: 'prepare', input: prepare() }),
    ).interaction;
    const update = {
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId: initial.sessionId,
      expectedRevision: 1,
      kind: 'cancel',
    } satisfies UpdateInteraction;
    const cancelled = unwrap(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: update,
      }),
    ).interaction;
    expect(cancelled.status).toBe('cancelled');
    expect(
      await command(stub, alice, {
        kind: 'update',
        id: initial.id,
        input: {
          ...update,
          requestId: crypto.randomUUID(),
          expectedRevision: 2,
        },
      }),
    ).toMatchObject({ code: 'not_editable' });
    const expiresInput = prepare();
    if (expiresInput.owner.kind === 'flow-claim')
      expiresInput.owner.runId = 'another-run';
    const expires = unwrap(
      await command(stub, alice, { kind: 'prepare', input: expiresInput }),
    ).interaction;
    await stub.advance(8 * 24 * 60 * 60 * 1000);
    expect(
      await command(stub, alice, {
        kind: 'update',
        id: expires.id,
        input: { ...update, requestId: crypto.randomUUID() },
      }),
    ).toMatchObject({ code: 'expired' });
  });
});
