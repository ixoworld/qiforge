import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeDelegation,
  serializeInvocation,
} from '@ixo/ucan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { authenticate, validateCurrentDelegation } from './auth';
import { createShell } from './app';
const oracle = await generateKeypair();
const cfg = {
  oracleDid: oracle.did,
  blocksyncUri: 'https://unused.example/graphql',
  revocationStoreUrl: 'https://store.example',
};
afterEach(() => vi.unstubAllGlobals());
async function credentials() {
  const user = await generateKeypair();
  const expiration = Math.floor(Date.now() / 1000) + 300;
  const delegation = await serializeDelegation(
    await createDelegation({
      issuer: user.signer,
      audience: oracle.did,
      capabilities: [{ with: 'ixo:oracle', can: '*' }],
      expiration,
    }),
  );
  const invocation = await serializeInvocation(
    await createInvocation({
      issuer: user.signer,
      audience: oracle.did,
      capability: { with: 'ixo:oracle', can: '*' },
      expiration,
    }),
  );
  return {
    did: user.did,
    delegation,
    headers: {
      authorization: `Bearer ${invocation}`,
      'x-auth-type': 'ucan',
      'x-ucan-delegation': delegation,
    },
  };
}
const request = {
  topic: {
    id: 'one',
    roomId: '!room',
    threadId: '$thread',
    attemptId: 'attempt',
    observedRevision: 'r1',
  },
  title: 'Research',
  goal: 'Research',
  instructions: '',
  sources: [],
  skill: { id: 'capsule1', version: '1', digest: 'a'.repeat(64) },
  capabilities: [],
  credentialNames: [],
};
describe('fresh signed research authorization', () => {
  it('rereads signature-bound revocation and fails closed on service outage', async () => {
    const owner = await credentials();
    let revoked = false;
    let checks = 0;
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const body = z
        .object({ cids: z.array(z.string()) })
        .parse(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      checks += 1;
      return Response.json({ revoked: revoked ? body.cids : [] });
    });
    await validateCurrentDelegation(owner.delegation, owner.did, cfg);
    revoked = true;
    await expect(
      validateCurrentDelegation(owner.delegation, owner.did, cfg),
    ).rejects.toThrow(/revoked/);
    expect(checks).toBe(2);
    vi.stubGlobal(
      'fetch',
      async () => new Response('unavailable', { status: 503 }),
    );
    await expect(
      validateCurrentDelegation(owner.delegation, owner.did, cfg),
    ).rejects.toThrow(/invalid/);
    await expect(
      validateCurrentDelegation(owner.delegation, 'did:ixo:other', cfg),
    ).rejects.toThrow();
  });
  it('forwards only strict owner research requests over signed routes', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ revoked: [] }));
    const owner = await credentials();
    const topicResearch = vi.fn(
      async (_identity: unknown, _operationId: string, _command: unknown) => ({
        ok: false,
        status: 404,
        message: 'Missing',
      }),
    );
    const idFromName = vi.fn((name: string) => name);
    const bindings = {
      TOPIC_RESEARCH_ENABLED: 'true',
      UCAN_STORE_URL: 'https://store.example',
      ORACLE_DID: oracle.did,
      BLOCKSYNC_GRAPHQL_URL: cfg.blocksyncUri,
      USER_ORACLE: { idFromName, get: () => ({ topicResearch }) },
    };
    const app = createShell();
    const start = await app.request(
      '/topic-research/op1',
      { method: 'PUT', headers: owner.headers, body: JSON.stringify(request) },
      bindings,
    );
    expect(start.status).toBe(404);
    expect(idFromName).toHaveBeenCalledWith(`${oracle.did}::${owner.did}`);
    expect(topicResearch.mock.calls[0]?.[0]).toMatchObject({
      userDid: owner.did,
    });
    expect(topicResearch.mock.calls[0]?.[2]).toEqual({
      action: 'start',
      request,
    });
    const invalid = await app.request(
      '/topic-research/op2',
      {
        method: 'PUT',
        headers: owner.headers,
        body: JSON.stringify({ ...request, requesterDid: 'forged' }),
      },
      bindings,
    );
    expect(invalid.status).toBe(400);
    expect(topicResearch).toHaveBeenCalledOnce();
    const bare = await app.request(
      '/topic-research/op1',
      { method: 'GET', headers: { 'x-ucan-delegation': owner.delegation } },
      { ...bindings, UCAN_ALLOW_BARE_DELEGATION_AUTH: 'true' },
    );
    expect(bare.status).toBe(401);
    const disabled = await app.request(
      '/topic-research/op1',
      { method: 'GET', headers: owner.headers },
      { ...bindings, TOPIC_RESEARCH_ENABLED: 'false' },
    );
    expect(disabled.status).toBe(404);
    expect((await authenticate(new Headers(owner.headers), cfg)).ok).toBe(true);
  });
});
