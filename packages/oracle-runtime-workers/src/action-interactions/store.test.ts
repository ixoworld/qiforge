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
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...input,
          requestId: crypto.randomUUID(),
          owner: { ...input.owner, schemaDigest: 'changed' },
        },
      }),
    ).toMatchObject({ code: 'target_changed' });
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
    expect(await dispatch(check)).toMatchObject({
      ok: false,
      code: 'review_required',
    });
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
    // Neither a new Companion session nor a normal manually reopened form has a bypass key.
    expect(await dispatch(check)).toMatchObject({ code: 'review_required' });
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
    ).toMatchObject({ code: 'not_found' });
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

describe('additional action card owners', () => {
  function approval(
    family: 'plugin' | 'domain-write' | 'recipe-release' = 'plugin',
  ): PrepareInteraction {
    return {
      ...prepare(),
      owner: {
        kind: 'approval',
        family,
        requestKey: crypto.randomUUID(),
        accountDid: alice,
      },
      values: { request: { action: 'install', pluginId: 'example' } },
    };
  }
  it('makes approval requests immutable and consumes exact review bindings once', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('approval-immutable');
    const input = approval();
    const initial = unwrap(
      await command(stub, alice, { kind: 'prepare', input }),
    ).interaction;
    for (const source of ['agent', 'user'] satisfies ('agent' | 'user')[])
      expect(
        await command(stub, alice, {
          kind: 'update',
          id: initial.id,
          input: {
            version: 1,
            kind: 'update',
            source,
            requestId: crypto.randomUUID(),
            sessionId: initial.sessionId,
            expectedRevision: 1,
            patch: { request: { action: 'different' } },
          },
        }),
      ).toMatchObject({ ok: false, code: 'immutable_request' });
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...input,
          requestId: crypto.randomUUID(),
          values: { request: { action: 'different' } },
        },
      }),
    ).toMatchObject({ ok: false, code: 'request_conflict' });
    const reserved = unwrap(
      await command(stub, alice, {
        kind: 'reserve',
        id: initial.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: initial.sessionId,
          expectedRevision: 1,
          valuesDigest: await interactionValuesDigest(initial.values),
        },
      }),
    ).interaction;
    const binding = {
      version: 1,
      owner: initial.owner,
      cardRef: initial.id,
      operationKey: reserved.reservation?.operationKey,
      valuesDigest: reserved.reservation?.valuesDigest,
    };
    expect(
      JSON.parse(
        await stub.dispatch(
          alice,
          JSON.stringify({ ...binding, valuesDigest: '0'.repeat(64) }),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'review_required' });
    expect(
      JSON.parse(await stub.dispatch(alice, JSON.stringify(binding))),
    ).toMatchObject({ ok: true, result: { managed: true } });
    expect(
      JSON.parse(await stub.dispatch(alice, JSON.stringify(binding))),
    ).toMatchObject({ ok: false, code: 'dispatch_consumed' });
    const operationKey = reserved.reservation?.operationKey;
    if (!operationKey) throw new Error('Missing reservation');
    const receipt = {
      files: [
        { path: 'one.md', status: 'written' },
        { path: 'two.md', status: 'failed' },
      ],
    };
    const partial = unwrap(
      await command(stub, alice, {
        kind: 'observe',
        id: initial.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: initial.sessionId,
          expectedRevision: 2,
          operationKey,
          outcome: 'partial',
          ownerExecutionRef: 'domain-write:one',
          receipt,
        },
      }),
    ).interaction;
    expect(
      await command(stub, alice, {
        kind: 'observe',
        id: initial.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: initial.sessionId,
          expectedRevision: 3,
          operationKey,
          outcome: 'partial',
          ownerExecutionRef: 'domain-write:one',
          receipt: { files: [] },
        },
      }),
    ).toMatchObject({ ok: false, code: 'receipt_conflict' });
    expect(partial).toMatchObject({ status: 'partial', receipt });
    expect(
      unwrap(await read(stub, alice, initial.id, initial.sessionId)),
    ).toEqual(partial);
    expect(
      await command(stub, alice, {
        kind: 'reserve',
        id: initial.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: initial.sessionId,
          expectedRevision: 3,
          valuesDigest: await interactionValuesDigest(initial.values),
        },
      }),
    ).toMatchObject({ ok: false, code: 'not_dispatchable' });
  });
  it('requires a managed approval, but permits an unmanaged bid and binds claim-block collections separately', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('owner-families');
    expect(
      JSON.parse(
        await stub.dispatch(
          alice,
          JSON.stringify({ version: 1, owner: approval().owner }),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'review_required' });
    const claim = prepare().owner;
    if (claim.kind !== 'flow-claim') throw new Error('Claim fixture');
    const bid = { ...claim, kind: 'flow-bid', roleId: 'service_agent' };
    expect(
      JSON.parse(
        await stub.dispatch(alice, JSON.stringify({ version: 1, owner: bid })),
      ),
    ).toMatchObject({ ok: true, result: { managed: false } });
    const first = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...prepare(), owner: { ...claim, kind: 'flow-claim-block' } },
      }),
    ).interaction;
    const second = unwrap(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...prepare(),
          owner: { ...claim, kind: 'flow-claim-block', collectionId: 'second' },
        },
      }),
    ).interaction;
    expect(first.id).not.toEqual(second.id);
  });
  it('stores a 1MiB UTF8 domain-write request in private chunks and enforces byte limits for other owners', async () => {
    const stub = env.ACTION_INTERACTIONS_TEST.getByName('large-domain-write');
    const request = {
      files: [{ path: 'unicode.md', content: '😀'.repeat(262144) }],
    };
    const input = { ...approval('domain-write'), values: { request } };
    const initial = unwrap(
      await command(stub, alice, { kind: 'prepare', input }),
    ).interaction;
    const references = JSON.parse(
      await stub.references(alice, initial.sessionId),
    );
    expect(references).toMatchObject([{ id: initial.id, owner: input.owner }]);
    expect(references[0]).not.toHaveProperty('values');

    expect(
      unwrap(await read(stub, alice, initial.id, initial.sessionId)).values,
    ).toEqual({ request });
    const reserved = unwrap(
      await command(stub, alice, {
        kind: 'reserve',
        id: initial.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: initial.sessionId,
          expectedRevision: 1,
          valuesDigest: await interactionValuesDigest(initial.values),
        },
      }),
    ).interaction;
    expect(reserved.values).toEqual({ request });
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...approval('plugin'), values: { request } },
      }),
    ).toMatchObject({ ok: false, code: 'too_large' });
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: {
          ...approval('domain-write'),
          values: { request: { content: '😀'.repeat(530000) } },
        },
      }),
    ).toMatchObject({ ok: false, code: 'too_large' });
    expect(
      await command(stub, alice, {
        kind: 'prepare',
        input: { ...prepare(), values: { content: '😀'.repeat(17000) } },
      }),
    ).toMatchObject({ ok: false, code: 'too_large' });
  });
});

it('checkpoints partial effects durably and reconciles once without releasing dispatch', async () => {
  const stub = env.ACTION_INTERACTIONS_TEST.getByName('partial-checkpoint');
  const input: PrepareInteraction = {
    ...prepare(),
    owner: {
      kind: 'approval',
      family: 'domain-write',
      requestKey: 'checkpoint',
      accountDid: alice,
    },
    values: { request: { files: ['one', 'two'] } },
  };
  const initial = unwrap(
    await command(stub, alice, { kind: 'prepare', input }),
  ).interaction;
  const reserved = unwrap(
    await command(stub, alice, {
      kind: 'reserve',
      id: initial.id,
      input: {
        version: 1,
        requestId: crypto.randomUUID(),
        sessionId: initial.sessionId,
        expectedRevision: 1,
        valuesDigest: await interactionValuesDigest(initial.values),
      },
    }),
  ).interaction;
  const operationKey = reserved.reservation?.operationKey;
  if (!operationKey) throw new Error('Missing reservation');
  const first = { files: [{ path: 'one', status: 'written' }] };
  unwrap(
    await command(stub, alice, {
      kind: 'observe',
      id: initial.id,
      input: {
        version: 1,
        requestId: crypto.randomUUID(),
        sessionId: initial.sessionId,
        expectedRevision: 2,
        operationKey,
        outcome: 'partial',
        ownerExecutionRef: 'checkpoint',
        receipt: first,
      },
    }),
  );
  expect(
    unwrap(await read(stub, alice, initial.id, initial.sessionId)),
  ).toMatchObject({ status: 'partial', receipt: first });
  const receipt = {
    files: [...first.files, { path: 'two', status: 'written' }],
  };
  const final = unwrap(
    await command(stub, alice, {
      kind: 'observe',
      id: initial.id,
      input: {
        version: 1,
        requestId: crypto.randomUUID(),
        sessionId: initial.sessionId,
        expectedRevision: 3,
        operationKey,
        outcome: 'reported',
        ownerExecutionRef: 'checkpoint',
        receipt,
      },
    }),
  ).interaction;
  expect(final).toMatchObject({ status: 'observed', receipt, revision: 4 });
});

it('rejects competing checkpoint writers and reconciles a lost acknowledgment by reading the current record', async () => {
  const stub = env.ACTION_INTERACTIONS_TEST.getByName('checkpoint-cas');
  const input: PrepareInteraction = {
    ...prepare(),
    owner: {
      kind: 'approval',
      family: 'recipe-release',
      requestKey: 'recipe',
      accountDid: alice,
    },
    values: { request: { recipeId: 'recipe' } },
  };
  const initial = unwrap(
    await command(stub, alice, { kind: 'prepare', input }),
  ).interaction;
  const reserved = unwrap(
    await command(stub, alice, {
      kind: 'reserve',
      id: initial.id,
      input: {
        version: 1,
        requestId: crypto.randomUUID(),
        sessionId: initial.sessionId,
        expectedRevision: 1,
        valuesDigest: await interactionValuesDigest(initial.values),
      },
    }),
  ).interaction;
  const operationKey = reserved.reservation?.operationKey;
  if (!operationKey) throw new Error('Missing reservation');
  const results = await Promise.all(
    ['shape-created', 'conflicting-shape'].map((phase) =>
      command(stub, alice, {
        kind: 'observe',
        id: initial.id,
        input: {
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: initial.sessionId,
          expectedRevision: 2,
          operationKey,
          outcome: 'partial',
          ownerExecutionRef: 'recipe',
          receipt: { events: [{ phase }] },
        },
      }),
    ),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toEqual([
    { ok: false, code: 'stale_revision' },
  ]);
  const recovered = unwrap(
    await read(stub, alice, initial.id, initial.sessionId),
  );
  expect(recovered).toMatchObject({
    revision: 3,
    status: 'partial',
    receipt: { events: [{ phase: expect.any(String) }] },
  });
  expect(
    JSON.parse(
      await stub.dispatch(
        alice,
        JSON.stringify({
          version: 1,
          owner: initial.owner,
          cardRef: initial.id,
          operationKey,
          valuesDigest: reserved.reservation?.valuesDigest,
        }),
      ),
    ),
  ).toMatchObject({ ok: false, code: 'review_required' });
});
