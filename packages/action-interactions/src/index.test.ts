import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  interactionValuesDigest,
  PrepareInteractionSchema,
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
});
