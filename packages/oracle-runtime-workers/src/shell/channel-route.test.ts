/**
 * `POST /channels/turn`: the caller is limited as soon as the user-rooted
 * invocation proves who it is, before the Auth Hub binding check — a flood
 * or a tight poll must not cost an Auth Hub round trip per request.
 */
import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeInvocation,
  type Capability,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channelRequestHash,
  type ChannelTurnInput,
} from '../channels/contract';
import { createShell } from './app';

const USER_DID = 'did:ixo:ixo1channeluser';

const input: ChannelTurnInput = {
  provider: 'whatsapp',
  bindingId: 'chb_route',
  bindingRevision: 1,
  requestId: 'wa:route1',
  remoteMessageRef: `hmac:${'b'.repeat(64)}`,
  message: 'Hello',
  context: { kind: 'companion' },
};

/** A channel turn signed by the channel service under the user's direct grant. */
async function signedTurn() {
  const user = await generateKeypair();
  const service = await generateKeypair();
  const oracle = await generateKeypair();
  const signer = user.signer.withDID(USER_DID);
  const capability: Capability = {
    can: 'ixo:channel/invoke',
    with: `ixo:channel:${input.bindingId}`,
    nb: {
      provider: input.provider,
      bindingRevision: input.bindingRevision,
      oracleDid: oracle.did,
    },
  };
  const grant = await createDelegation({
    issuer: signer,
    audience: service.did,
    capabilities: [capability],
    expiration: Math.floor(Date.now() / 1000) + 300,
  });
  const raw = JSON.stringify(input);
  // The did:ixo resolver and its key cache are shared per Blocksync URL per
  // isolate, so each turn's freshly generated user key gets its own URL.
  const blocksync = `https://blocksync-${crypto.randomUUID()}.test/graphql`;
  const token = await serializeInvocation(
    await createInvocation({
      issuer: service.signer,
      audience: oracle.did,
      capability,
      proofs: [grant],
      expiration: Math.floor(Date.now() / 1000) + 60,
      facts: [
        {
          requestId: input.requestId,
          requestHash: await channelRequestHash(raw),
        },
      ],
    }),
  );
  // Blocksync serves the user's DID document (its Ed25519 key).
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) !== blocksync)
      throw new Error(`unexpected fetch ${String(url)}`);
    return Response.json({
      data: {
        iids: {
          nodes: [
            {
              id: USER_DID,
              verificationMethod: [
                {
                  id: `${USER_DID}#key-1`,
                  type: 'Ed25519VerificationKey2020',
                  controller: USER_DID,
                  publicKeyMultibase: user.did.slice('did:key:'.length),
                },
              ],
            },
          ],
        },
      },
    });
  });
  return {
    raw,
    headers: {
      authorization: `Bearer ${token}`,
      'x-auth-type': 'ucan',
      'content-type': 'application/json',
    },
    oracleDid: oracle.did,
    serviceDid: service.did,
    blocksync,
  };
}

function environment(
  turn: Awaited<ReturnType<typeof signedTurn>>,
  limited: boolean,
) {
  const authHubCalls: string[] = [];
  const limiterKeys: string[] = [];
  const turns: string[] = [];
  const env = {
    ORACLE_DID: turn.oracleDid,
    BLOCKSYNC_GRAPHQL_URL: turn.blocksync,
    CHANNEL_SERVICE_DID: turn.serviceDid,
    AUTH_HUB_CHANNEL_SERVICE_KEY: 'k',
    AUTH_HUB: {
      fetch: async (request: Request) => {
        authHubCalls.push(new URL(request.url).pathname);
        return Response.json({ active: true });
      },
    },
    RATE_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        limiterKeys.push(key);
        return { success: !limited };
      },
    },
    USER_ORACLE: {
      idFromName: (name: string) => name,
      get: () => ({
        channelTurn: async (identity: { userDid: string }) => {
          turns.push(identity.userDid);
          return {
            ok: true,
            result: { status: 'completed', requestId: input.requestId },
          };
        },
      }),
    },
  };
  return { env, authHubCalls, limiterKeys, turns };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /channels/turn rate limit', () => {
  it('answers 429 over the limit without calling the Auth Hub', async () => {
    const turn = await signedTurn();
    const { env, authHubCalls, limiterKeys, turns } = environment(turn, true);
    const res = await createShell().request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body: turn.raw },
      env,
    );
    expect(res.status).toBe(429);
    expect(limiterKeys).toEqual([`${turn.oracleDid}|user|${USER_DID}`]);
    expect(authHubCalls).toEqual([]);
    expect(turns).toEqual([]);
  });

  it('checks the binding with the Auth Hub once within the limit', async () => {
    const turn = await signedTurn();
    const { env, authHubCalls, turns } = environment(turn, false);
    const res = await createShell().request(
      '/channels/turn',
      { method: 'POST', headers: turn.headers, body: turn.raw },
      env,
    );
    expect(res.status).toBe(200);
    expect(authHubCalls).toEqual(['/api/internal/channels/validate-binding']);
    expect(turns).toEqual([USER_DID]);
  });
});

describe('POST /channels/turn retries', () => {
  it('admits two concurrent identical requests under one invocation', async () => {
    // A poll repeats the exact body and may reuse its invocation; the durable
    // receipt, not a replay mark, keeps the repeats on one run.
    const turn = await signedTurn();
    const { env, turns } = environment(turn, false);
    const shell = createShell();
    const send = () =>
      shell.request(
        '/channels/turn',
        { method: 'POST', headers: turn.headers, body: turn.raw },
        env,
      );
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(turns).toEqual([USER_DID, USER_DID]);
  });
});
