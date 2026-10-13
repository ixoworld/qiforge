/**
 * The turn body cap, enforced by the shell BEFORE the body is read: an
 * oversized turn is refused with 413 and never reaches the user object.
 */
import {
  createInvocation,
  generateKeypair,
  serializeInvocation,
  type Signer,
} from '@ixo/ucan';
import { describe, expect, it } from 'vitest';
import { createShell } from './app';
import { MAX_TURN_BODY_BYTES } from './turn-body-cap';

// did:key throughout: every DID resolves locally, Blocksync is never asked.
const ORACLE_DID = (await generateKeypair()).did;
const user = await generateKeypair();

async function authHeaders(signer: Signer): Promise<Record<string, string>> {
  const invocation = await createInvocation({
    issuer: signer,
    audience: ORACLE_DID,
    capability: { can: '*', with: 'ixo:oracle' },
    proofs: [],
    expiration: Math.floor(Date.now() / 1000) + 300,
  });
  return {
    authorization: `Bearer ${await serializeInvocation(invocation)}`,
    'x-auth-type': 'ucan',
    'content-type': 'application/json',
  };
}

function environment() {
  const forwarded: number[] = [];
  return {
    forwarded,
    env: {
      ORACLE_DID,
      BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.invalid/graphql',
      USER_ORACLE: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (_url: string, init: { body: string }) => {
            forwarded.push(new TextEncoder().encode(init.body).byteLength);
            return Response.json({ ok: true });
          },
        }),
      },
    },
  };
}

/** A JSON turn body of exactly `bytes` UTF-8 bytes, padded with `fill`. */
function bodyOf(bytes: number, fill = 'x'): string {
  const shell = JSON.stringify({ message: '' });
  const fillBytes = new TextEncoder().encode(fill).byteLength;
  return JSON.stringify({
    message: fill.repeat((bytes - shell.length) / fillBytes),
  });
}

async function postTurn(
  env: ReturnType<typeof environment>['env'],
  body: string | ReadableStream<Uint8Array>,
): Promise<Response> {
  return createShell().request(
    '/messages/s1',
    {
      method: 'POST',
      headers: await authHeaders(user.signer),
      body,
      ...(typeof body === 'string' ? {} : { duplex: 'half' }),
    },
    env,
  );
}

describe('turn body cap', () => {
  it('is 256 KiB', () => {
    expect(MAX_TURN_BODY_BYTES).toBe(262_144);
  });

  it('forwards a body exactly at the cap and refuses one byte more without forwarding it', async () => {
    const { env, forwarded } = environment();
    const atCap = await postTurn(env, bodyOf(MAX_TURN_BODY_BYTES));
    expect(atCap.status).toBe(200);
    expect(forwarded).toEqual([MAX_TURN_BODY_BYTES]);
    const over = await postTurn(env, bodyOf(MAX_TURN_BODY_BYTES + 2));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({
      statusCode: 413,
      message: 'request entity too large',
    });
    expect(forwarded).toHaveLength(1);
  });

  it('refuses a 300 KB body sent without a declared length, without the user object seeing it', async () => {
    const { env, forwarded } = environment();
    const bytes = new TextEncoder().encode(bodyOf(300_000));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 16_384)
          controller.enqueue(bytes.slice(i, i + 16_384));
        controller.close();
      },
    });
    const res = await postTurn(env, stream);
    expect(res.status).toBe(413);
    expect(forwarded).toEqual([]);
  });

  it('lets a Portal-sized turn through where the old 100 KiB cap refused it', async () => {
    // The measured devnet rejections: 102,514 and 114,697 bytes.
    const { env, forwarded } = environment();
    expect((await postTurn(env, bodyOf(102_514))).status).toBe(200);
    expect((await postTurn(env, bodyOf(114_697))).status).toBe(200);
    expect(forwarded).toHaveLength(2);
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const { env, forwarded } = environment();
    // 'é' is two bytes: a body under the cap in characters, over it in bytes.
    const res = await postTurn(env, bodyOf(MAX_TURN_BODY_BYTES + 2, 'é'));
    expect(res.status).toBe(413);
    expect(forwarded).toEqual([]);
  });
});
