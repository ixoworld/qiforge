import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  interactionValuesDigest,
  PrepareInteractionSchema,
  UpdateInteractionSchema,
  InteractionSchema,
  createActionInteractionsClient,
} from './index.js';

describe('portable interaction contract', () => {
  it('canonicalizes keys while preserving arrays and hashes reviewed values', async () => {
    expect(canonicalJson({ z: 1, a: { b: 2, a: 3 } })).toBe(
      '{"a":{"a":3,"b":2},"z":1}',
    );
    expect(await interactionValuesDigest({ b: 1, a: 2 })).toBe(
      await interactionValuesDigest({ a: 2, b: 1 }),
    );
    expect(await interactionValuesDigest({ a: [1, 2] })).not.toBe(
      await interactionValuesDigest({ a: [2, 1] }),
    );
  });
  it('rejects unsupported versions, execution fields and non-JSON payloads', () => {
    const input = {
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId: '$session',
      owner: { kind: 'question', requestId: 'question' },
      values: {},
    };
    expect(PrepareInteractionSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...input, version: 2 },
      { ...input, execute: true },
      { ...input, values: { unsafe: NaN } },
      { ...input, owner: { ...input.owner, handler: 'function' } },
    ])
      expect(PrepareInteractionSchema.safeParse(invalid).success).toBe(false);
  });
  it('supports explicit removals and rejects ambiguous or repeated field mutations', () => {
    const update = {
      version: 1,
      requestId: crypto.randomUUID(),
      sessionId: '$session',
      expectedRevision: 1,
      kind: 'update',
      source: 'user',
      patch: {},
      remove: ['answer'],
    };
    expect(UpdateInteractionSchema.safeParse(update).success).toBe(true);
    expect(
      UpdateInteractionSchema.safeParse({
        ...update,
        patch: { answer: 'both' },
      }).success,
    ).toBe(false);
    expect(
      UpdateInteractionSchema.safeParse({
        ...update,
        remove: ['answer', 'answer'],
      }).success,
    ).toBe(false);
  });
  it('encodes session context and forwards current authentication', async () => {
    const requests: { url: string; auth: string | null }[] = [];
    const client = createActionInteractionsClient({
      baseUrl: 'https://oracle.example/',
      headers: async () => ({ authorization: 'Bearer current' }),
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return Response.json([]);
      },
    });
    expect(await client.list('$session?private=true')).toEqual([]);
    expect(requests).toEqual([
      {
        url: 'https://oracle.example/action-interactions?sessionId=%24session%3Fprivate%3Dtrue',
        auth: 'Bearer current',
      },
    ]);
  });
  it('preserves transport failures for conflict handling', async () => {
    const client = createActionInteractionsClient({
      baseUrl: 'https://oracle.example',
      headers: async () => ({}),
      fetch: async () =>
        Response.json(
          { code: 'stale_revision', message: 'changed' },
          { status: 409 },
        ),
    });
    await expect(client.list('$session')).rejects.toMatchObject({
      status: 409,
      code: 'stale_revision',
    });
  });
  it('reads records from a newer runtime but refuses unknown request fields', () => {
    const record = {
      version: 1,
      id: crypto.randomUUID(),
      revision: 2,
      sessionId: '$session',
      oracleDid: 'did:ixo:oracle',
      owner: { kind: 'question', requestId: 'q', newOwnerField: 1 },
      values: { a: 1 },
      updatedByUser: [],
      status: 'cancelled',
      cancelReason: 'not-submitted',
      createdAt: 1,
      expiresAt: 2,
      newRecordField: true,
    };
    const parsed = InteractionSchema.parse(record);
    expect(parsed).not.toHaveProperty('newRecordField');
    expect(parsed.owner).not.toHaveProperty('newOwnerField');
    expect(
      PrepareInteractionSchema.safeParse({
        version: 1,
        requestId: crypto.randomUUID(),
        sessionId: '$session',
        owner: { kind: 'question', requestId: 'q', newOwnerField: 1 },
        values: {},
      }).success,
    ).toBe(false);
  });
  it('turns a non-JSON error page into a typed error and skips unreadable list items', async () => {
    const page = createActionInteractionsClient({
      baseUrl: 'https://oracle.example',
      headers: async () => ({}),
      fetch: async () => new Response('Payload Too Large', { status: 413 }),
    });
    await expect(page.list('$session')).rejects.toMatchObject({
      status: 413,
      code: 'request_failed',
    });
    const good = {
      version: 1,
      id: crypto.randomUUID(),
      revision: 1,
      sessionId: '$session',
      oracleDid: 'did:ixo:oracle',
      owner: { kind: 'artifact', artifactId: 'a' },
      values: {},
      updatedByUser: [],
      status: 'draft',
      createdAt: 1,
      expiresAt: 2,
    };
    const mixed = createActionInteractionsClient({
      baseUrl: 'https://oracle.example',
      headers: async () => ({}),
      fetch: async () => Response.json([good, { version: 9 }]),
    });
    expect((await mixed.list('$session')).map((r) => r.id)).toEqual([good.id]);
  });
  it("codes the shell's own 401 and 429 bodies by status", async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [429, 'rate_limited'],
    ] as const) {
      const client = createActionInteractionsClient({
        baseUrl: 'https://oracle.example',
        headers: async () => ({}),
        fetch: async () =>
          Response.json({ statusCode: status, message: 'nope' }, { status }),
      });
      await expect(client.list('$session')).rejects.toMatchObject({
        status,
        code,
        message: 'nope',
      });
    }
  });
});
