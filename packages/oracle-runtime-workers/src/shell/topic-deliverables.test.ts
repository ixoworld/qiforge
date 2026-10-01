import { describe, expect, it, vi } from 'vitest';
import {
  createDelegation,
  createInvocation,
  serializeDelegation,
  serializeInvocation,
  signerFromMnemonic,
} from '@ixo/ucan';
import { createShell } from './app';

const { did: oracleDid } = await signerFromMnemonic(
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
);
const request = {
  topic: {
    id: 'topic',
    roomId: '!room:example.com',
    threadId: '$root',
    attemptId: 'attempt',
  },
  title: 'Brief',
  goal: 'A goal',
  instructions: 'Write a brief.',
  sources: [],
};
async function credentials() {
  const { signer, did } = await signerFromMnemonic(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const expiration = Math.floor(Date.now() / 1000) + 300;
  const invocation = await serializeInvocation(
    await createInvocation({
      issuer: signer,
      audience: oracleDid,
      capability: { can: '*', with: 'ixo:oracle' },
      expiration,
    }),
  );
  const delegation = await serializeDelegation(
    await createDelegation({
      issuer: signer,
      audience: oracleDid,
      capabilities: [{ can: '*', with: 'ixo:oracle' }],
      expiration,
    }),
  );
  return { did, invocation, delegation };
}
function fixture(enabled = 'true') {
  const topicDeliverable = vi.fn(async () => ({
    ok: false,
    status: 404,
    message: 'Deliverable not found.',
  }));
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn(() => ({ topicDeliverable }));
  const bindings = {
    TOPIC_DELIVERABLES_ENABLED: enabled,
    ORACLE_DID: oracleDid,
    BLOCKSYNC_GRAPHQL_URL: 'https://unused.example.com',
    USER_ORACLE: { idFromName, get },
  };
  return { app: createShell(), bindings, topicDeliverable, idFromName, get };
}

describe('Topic deliverable HTTP authority boundary', () => {
  it.each([
    // Default shell: a bare delegation never authenticates at all.
    ['', /^UCAN invocation required/],
    // Legacy fallback on: the shell accepts it, the Topic routes still do not.
    ['true', /^A signed invocation is required\.$/],
  ])(
    'requires a signed invocation on every route before selecting any user object (bare-delegation fallback %j)',
    async (allowBare, message) => {
      const { delegation } = await credentials();
      const f = fixture();
      const bindings = {
        ...f.bindings,
        UCAN_ALLOW_BARE_DELEGATION_AUTH: allowBare,
      };
      for (const [method, path] of [
        ['PUT', '/topic-deliverables/op'],
        ['GET', '/topic-deliverables/op'],
        ['POST', '/topic-deliverables/op/cancel'],
      ]) {
        const res = await f.app.request(
          path!,
          {
            method,
            headers: {
              'x-ucan-delegation': delegation,
              'content-type': 'application/json',
            },
            ...(method !== 'GET' ? { body: JSON.stringify(request) } : {}),
          },
          bindings,
        );
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({
          message: expect.stringMatching(message),
        });
      }
      expect(f.get).not.toHaveBeenCalled();
    },
  );

  it('routes solely to the signed owner and rejects caller-selected authority and oversized input', async () => {
    const { invocation, did } = await credentials();
    const f = fixture();
    const headers = {
      authorization: `Bearer ${invocation}`,
      'x-auth-type': 'ucan',
      'x-did': 'did:web:victim.example.com',
      'content-type': 'application/json',
    };
    const res = await f.app.request(
      '/topic-deliverables/op?userDid=did:web:victim.example.com',
      { method: 'PUT', headers, body: JSON.stringify(request) },
      f.bindings,
    );
    expect(res.status).toBe(404);
    expect(f.idFromName).toHaveBeenCalledWith(`${oracleDid}::${did}`);
    expect(f.topicDeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ userDid: did }),
      'op',
      { action: 'start', request },
    );
    const forged = await f.app.request(
      '/topic-deliverables/forged',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...request, owner: 'someone else' }),
      },
      f.bindings,
    );
    expect(forged.status).toBe(400);
    const large = await f.app.request(
      '/topic-deliverables/large',
      { method: 'PUT', headers, body: 'x'.repeat(128 * 1024 + 1) },
      f.bindings,
    );
    expect(large.status).toBe(413);
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it('reads and cancels only the signed owner operation, including an operation named cancel', async () => {
    const { invocation, did } = await credentials();
    const f = fixture();
    const headers = {
      authorization: `Bearer ${invocation}`,
      'x-auth-type': 'ucan',
    };
    expect(
      (
        await f.app.request(
          '/topic-deliverables/cancel',
          { headers },
          f.bindings,
        )
      ).status,
    ).toBe(404);
    expect(f.topicDeliverable).toHaveBeenLastCalledWith(
      expect.objectContaining({ userDid: did }),
      'cancel',
      { action: 'read' },
    );
    expect(
      (
        await f.app.request(
          '/topic-deliverables/cancel/cancel',
          { method: 'POST', headers, body: JSON.stringify(request) },
          f.bindings,
        )
      ).status,
    ).toBe(404);
    expect(f.topicDeliverable).toHaveBeenLastCalledWith(
      expect.objectContaining({ userDid: did }),
      'cancel',
      { action: 'cancel', request },
    );
    expect(f.idFromName).toHaveBeenCalledWith(`${oracleDid}::${did}`);
  });

  it('requires the full validated Start body to cancel before selecting an owner object', async () => {
    const { invocation } = await credentials();
    const f = fixture();
    const headers = {
      authorization: `Bearer ${invocation}`,
      'x-auth-type': 'ucan',
      'content-type': 'application/json',
    };
    for (const body of [
      undefined,
      '{}',
      JSON.stringify({ ...request, owner: 'forged' }),
    ]) {
      const res = await f.app.request(
        '/topic-deliverables/op/cancel',
        { method: 'POST', headers, body },
        f.bindings,
      );
      expect(res.status).toBe(400);
    }
    const res = await f.app.request(
      '/topic-deliverables/op/cancel',
      { method: 'POST', headers, body: 'x'.repeat(128 * 1024 + 1) },
      f.bindings,
    );
    expect(res.status).toBe(413);
    expect(f.get).not.toHaveBeenCalled();
  });

  it('stays off by default and rejects missing or invalid authentication', async () => {
    const { invocation } = await credentials();
    const f = fixture('');
    expect(
      (
        await f.app.request(
          '/topic-deliverables/op',
          {
            headers: {
              authorization: `Bearer ${invocation}`,
              'x-auth-type': 'ucan',
            },
          },
          f.bindings,
        )
      ).status,
    ).toBe(404);
    expect(
      (await f.app.request('/topic-deliverables/op', {}, f.bindings)).status,
    ).toBe(401);
    expect(
      (
        await f.app.request(
          '/topic-deliverables/op',
          {
            headers: { authorization: 'Bearer forged', 'x-auth-type': 'ucan' },
          },
          f.bindings,
        )
      ).status,
    ).toBe(401);
    expect(f.get).not.toHaveBeenCalled();
  });
});
