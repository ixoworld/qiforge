/**
 * `POST /messages/abort` reaches only the caller's own user object: the
 * object is chosen from the DID the UCAN invocation proves, never from the
 * body or a header, so one user cannot stop another user's turn by naming
 * its session.
 */
import {
  createInvocation,
  generateKeypair,
  serializeInvocation,
  type Signer,
} from '@ixo/ucan';
import { describe, expect, it } from 'vitest';
import { userObjectName } from '../do/contracts';
import { createShell } from './app';

// did:key throughout, oracle included: the validator resolves every DID in
// the invocation, and did:key resolves locally — Blocksync is never asked.
const ORACLE_DID = (await generateKeypair()).did;

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

/** A `USER_ORACLE` namespace that records which object each abort reached. */
function recordingUserObjects(liveTurns: ReadonlySet<string>) {
  const aborts: Array<{ object: string; sessionId: string }> = [];
  const USER_ORACLE = {
    idFromName: (name: string) => name,
    get: (object: string) => ({
      abortTurn: async (sessionId: string) => {
        aborts.push({ object, sessionId });
        return liveTurns.has(`${object}|${sessionId}`);
      },
    }),
  };
  return { USER_ORACLE, aborts };
}

describe('POST /messages/abort', () => {
  it("aborts in the caller's own object and cannot reach another user's turn", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const aliceObject = userObjectName(alice.did, ORACLE_DID);
    const bobObject = userObjectName(bob.did, ORACLE_DID);
    const { USER_ORACLE, aborts } = recordingUserObjects(
      new Set([`${aliceObject}|s-alice`]),
    );
    const env = {
      ORACLE_DID,
      BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.invalid/graphql',
      USER_ORACLE,
    };
    const app = createShell();

    // Bob names Alice's session and claims her DID in a header: the proven
    // signer decides, so the abort lands in Bob's object and finds nothing.
    const bobTry = await app.request(
      '/messages/abort',
      {
        method: 'POST',
        headers: { ...(await authHeaders(bob.signer)), 'x-did': alice.did },
        body: JSON.stringify({ sessionId: 's-alice' }),
      },
      env,
    );
    expect(bobTry.status).toBe(200);
    expect(await bobTry.json()).toEqual({ success: false });
    expect(aborts).toEqual([{ object: bobObject, sessionId: 's-alice' }]);

    const aliceAbort = await app.request(
      '/messages/abort',
      {
        method: 'POST',
        headers: await authHeaders(alice.signer),
        body: JSON.stringify({ sessionId: 's-alice' }),
      },
      env,
    );
    expect(await aliceAbort.json()).toEqual({ success: true });
    expect(aborts.at(-1)).toEqual({
      object: aliceObject,
      sessionId: 's-alice',
    });
  });

  it('refuses an unauthenticated abort before any user object is touched', async () => {
    const { USER_ORACLE, aborts } = recordingUserObjects(new Set());
    const res = await createShell().request(
      '/messages/abort',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-alice' }),
      },
      {
        ORACLE_DID,
        BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.invalid/graphql',
        USER_ORACLE,
      },
    );
    expect(res.status).toBe(401);
    expect(aborts).toEqual([]);
  });
});
