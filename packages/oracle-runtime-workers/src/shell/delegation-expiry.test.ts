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
import {
  authConfigFromEnv,
  authenticate,
  INVOCATION_REQUIRED_ERROR,
} from './auth';

// did:key throughout: every DID resolves locally, Blocksync is never asked.
const ORACLE_DID = (await generateKeypair()).did;
const BLOCKSYNC = 'https://blocksync.invalid/graphql';
const CFG = { oracleDid: ORACLE_DID, blocksyncUri: BLOCKSYNC };
/** The legacy fallback (`UCAN_ALLOW_BARE_DELEGATION_AUTH=true`): a bare delegation authenticates. */
const LEGACY = { ...CFG, allowBareDelegation: true };
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

describe('bare delegation (no invocation)', () => {
  it('does not authenticate by default, however valid the delegation', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      new Headers({
        'x-ucan-delegation': await delegationFrom(
          user.signer,
          nowSeconds() + 3600,
        ),
      }),
      CFG,
    );
    expect(outcome).toEqual({
      ok: false,
      status: 401,
      error: INVOCATION_REQUIRED_ERROR,
    });
  });

  it('is refused by the shell unless the deployment opts into the legacy fallback', async () => {
    const user = await generateKeypair();
    const headers = {
      'x-ucan-delegation': await delegationFrom(
        user.signer,
        nowSeconds() + 3600,
      ),
    };
    const env = {
      ORACLE_DID,
      BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC,
      USER_ORACLE: {
        idFromName: (name: string) => name,
        get: () => ({ abortTurn: async () => false }),
      },
    };
    const abort = (extra: Record<string, unknown>) =>
      createShell().request(
        '/messages/abort',
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 's' }),
        },
        { ...env, ...extra },
      );
    const refused = await abort({});
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      message: INVOCATION_REQUIRED_ERROR,
    });
    const legacy = await abort({ UCAN_ALLOW_BARE_DELEGATION_AUTH: 'true' });
    expect(legacy.status).toBe(200);
  });

  it('reads the fallback switch from UCAN_ALLOW_BARE_DELEGATION_AUTH', () => {
    const base = { ORACLE_DID, BLOCKSYNC_GRAPHQL_URL: BLOCKSYNC };
    expect(authConfigFromEnv(base).allowBareDelegation).toBe(false);
    expect(
      authConfigFromEnv({ ...base, UCAN_ALLOW_BARE_DELEGATION_AUTH: 'false' })
        .allowBareDelegation,
    ).toBe(false);
    expect(
      authConfigFromEnv({ ...base, UCAN_ALLOW_BARE_DELEGATION_AUTH: 'true' })
        .allowBareDelegation,
    ).toBe(true);
  });
});

describe('delegation header', () => {
  it('refuses a delegation that never expires as the only credential (legacy fallback on)', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      new Headers({ 'x-ucan-delegation': await delegationFrom(user.signer) }),
      LEGACY,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(401);
    expect(outcome.error).toMatch(/no expiration/i);
  });

  it('accepts a bounded delegation and reports its expiry (legacy fallback on)', async () => {
    const user = await generateKeypair();
    const expiration = nowSeconds() + 3600;
    const outcome = await authenticate(
      new Headers({
        'x-ucan-delegation': await delegationFrom(user.signer, expiration),
      }),
      LEGACY,
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

  it('refuses an expired delegation (legacy fallback on)', async () => {
    const user = await generateKeypair();
    const outcome = await authenticate(
      new Headers({
        'x-ucan-delegation': await delegationFrom(
          user.signer,
          nowSeconds() - 60,
        ),
      }),
      LEGACY,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatch(/expired/i);
  });

  it('with a valid invocation, carries a bounded delegation downstream', async () => {
    const user = await generateKeypair();
    const expiration = nowSeconds() + 3600;
    const delegation = await delegationFrom(user.signer, expiration);
    const outcome = await authenticate(
      new Headers({
        authorization: `Bearer ${await invocationFrom(user.signer)}`,
        'x-auth-type': 'ucan',
        'x-ucan-delegation': delegation,
      }),
      CFG,
    );
    expect(outcome).toMatchObject({
      ok: true,
      auth: {
        userDid: user.did,
        via: 'invocation',
        delegation,
        delegationExpiration: expiration,
      },
    });
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
