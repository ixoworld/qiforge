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
