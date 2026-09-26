/**
 * Delegations must expire. The runtime stores a delegation and mints
 * downstream invocations on it long after the request that brought it, so
 * one with no expiry anywhere in its chain is refused — as an
 * `x-ucan-delegation` header, and as the delegation a user deposits with
 * `POST /delegation`, whose stored expiry is the token's own.
 */
import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeDelegation,
  serializeInvocation,
  type Signer,
} from '@ixo/ucan';
import { describe, expect, it } from 'vitest';
import { decodeRoomStateContent } from '../matrix/room-state-codec';
import { createShell } from './app';
import { authenticate } from './auth';

// did:key throughout: every DID resolves locally, Blocksync is never asked.
const ORACLE_DID = (await generateKeypair()).did;
const BLOCKSYNC = 'https://blocksync.invalid/graphql';
const CFG = { oracleDid: ORACLE_DID, blocksyncUri: BLOCKSYNC };
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function delegationFrom(
  issuer: Signer,
  expiration?: number,
): Promise<string> {
  return serializeDelegation(
    await createDelegation({
      issuer,
      audience: ORACLE_DID,
      capabilities: [{ can: '*', with: 'ixo:oracle' }],
      // Omitted: the library's default, a delegation that never expires.
      ...(expiration !== undefined ? { expiration } : {}),
    }),
  );
}

async function invocationFrom(issuer: Signer): Promise<string> {
  return serializeInvocation(
    await createInvocation({
      issuer,
      audience: ORACLE_DID,
      capability: { can: '*', with: 'ixo:oracle' },
      proofs: [],
      expiration: nowSeconds() + 300,
    }),
  );
}

describe('delegation header', () => {
  it('refuses a delegation that never expires as the only credential', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      new Headers({ 'x-ucan-delegation': await delegationFrom(user.signer) }),
      CFG,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(401);
    expect(outcome.error).toMatch(/no expiration/i);
  });

  it('accepts a bounded delegation and reports its expiry', async () => {
    const user = await generateKeypair();
    const expiration = nowSeconds() + 3600;
    const outcome = await authenticate(
      new Headers({
        'x-ucan-delegation': await delegationFrom(user.signer, expiration),
      }),
      CFG,
    );
    expect(outcome).toMatchObject({
      ok: true,
      auth: {
        userDid: user.did,
        via: 'delegation',
        delegationExpiration: expiration,
      },
    });
  });

  it('refuses an expired delegation', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      new Headers({
        'x-ucan-delegation': await delegationFrom(
          user.signer,
          nowSeconds() - 60,
        ),
      }),
      CFG,
    );
    expect(outcome.ok).toBe(false);
  });

  it('with a valid invocation, drops an unbounded delegation instead of carrying it downstream', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      new Headers({
        authorization: `Bearer ${await invocationFrom(user.signer)}`,
        'x-auth-type': 'ucan',
        'x-ucan-delegation': await delegationFrom(user.signer),
      }),
      CFG,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.auth.via).toBe('invocation');
    expect(outcome.auth.delegation).toBeUndefined();
  });
});

describe('POST /delegation', () => {
  function environment() {
    const stored: unknown[] = [];
    const pushed: Array<{ did: string; expiration?: number }> = [];
    const env = {
      ORACLE_DID,
      BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC,
      MATRIX_GATEWAY: {
        idFromName: (name: string) => name,
        get: () => ({
          resolveUserRoom: async (did: string) => ({
            roomId: '!room:test',
            alias: `#${did}`,
          }),
          sendStateEvent: async (
            _roomId: string,
            _type: string,
            content: string,
          ) => {
            stored.push(JSON.parse(content));
          },
        }),
      },
      USER_ORACLE: {
        idFromName: (name: string) => name,
        get: () => ({
          setDelegation: async (
            did: string,
            _raw: string,
            expiration?: number,
          ) => {
            pushed.push({ did, expiration });
          },
        }),
      },
    };
    return { env, stored, pushed };
  }

  async function deposit(
    env: ReturnType<typeof environment>['env'],
    caller: Signer,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return createShell().request(
      '/delegation',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await invocationFrom(caller)}`,
          'x-auth-type': 'ucan',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it('refuses to store a delegation that never expires', async () => {
    const user = await generateKeypair();
    const { env, stored, pushed } = environment();
    const res = await deposit(env, user.signer, {
      raw: await delegationFrom(user.signer),
      expiration: nowSeconds() + 3600,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      message: expect.stringMatching(/no expiration/i),
    });
    expect(stored).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("refuses to store another user's delegation", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const { env, stored } = environment();
    const res = await deposit(env, alice.signer, {
      raw: await delegationFrom(bob.signer, nowSeconds() + 3600),
    });
    expect(res.status).toBe(403);
    expect(stored).toEqual([]);
  });

  it("stores a bounded delegation with the token's own expiry, whatever the body states", async () => {
    const user = await generateKeypair();
    const expiration = nowSeconds() + 3600;
    const { env, stored, pushed } = environment();
    const res = await deposit(env, user.signer, {
      raw: await delegationFrom(user.signer, expiration),
      expiration: nowSeconds() + 10 * 365 * 24 * 3600,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, expiration });
    expect(stored).toHaveLength(1);
    expect(await decodeRoomStateContent(stored[0])).toMatchObject({
      issuer: user.did,
      audience: ORACLE_DID,
      expiration,
    });
    expect(pushed).toEqual([{ did: user.did, expiration }]);
  });
});
