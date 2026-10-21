import { describe, expect, it, vi } from 'vitest';
import {
  createInvocation,
  generateKeypair,
  serializeInvocation,
} from '@ixo/ucan';
import { createShell } from './app';

const oracle = await generateKeypair();
const user = await generateKeypair();
async function authHeaders() {
  return {
    authorization: `Bearer ${await serializeInvocation(await createInvocation({ issuer: user.signer, audience: oracle.did, capability: { can: '*', with: 'ixo:oracle' }, expiration: Math.floor(Date.now() / 1000) + 300 }))}`,
    'content-type': 'application/json',
    'x-auth-type': 'ucan',
  };
}
function fixture(enabled = 'true') {
  const actionInteraction = vi.fn(async () => ({
    ok: false,
    status: 409,
    code: 'stale_revision',
    message: 'changed',
  }));
  const checkClaimDispatch = vi.fn(async () => ({
    ok: false,
    status: 409,
    code: 'review_required',
    message: 'Managed draft exists',
  }));
  const readActionInteraction = vi.fn(async () => ({ ok: true, value: '[]' }));
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn(() => ({
    actionInteraction,
    readActionInteraction,
    checkClaimDispatch,
  }));
  return {
    app: createShell(),
    actionInteraction,
    readActionInteraction,
    checkClaimDispatch,
    idFromName,
    get,
    bindings: {
      ORACLE_DID: oracle.did,
      BLOCKSYNC_GRAPHQL_URL: 'https://unused.example',
      ACTION_INTERACTIONS_ENABLED: enabled,
      USER_ORACLE: { idFromName, get },
    },
  };
}

describe('interaction HTTP authority and structural boundary', () => {
  it('advertises only the explicitly enabled draft protocol', async () => {
    const enabled = fixture();
    const advertised = await enabled.app.request(
      '/health',
      {},
      enabled.bindings,
    );
    expect(await advertised.json()).toMatchObject({
      actionInteractions: {
        version: 1,
        owners: ['flow-claim', 'question', 'artifact'],
      },
    });
    const disabled = fixture('false');
    expect(
      await (
        await disabled.app.request('/health', {}, disabled.bindings)
      ).json(),
    ).not.toHaveProperty('actionInteractions');
  });

  it('requires authentication and explicit enablement before selecting a user object', async () => {
    const f = fixture();
    expect(
      (
        await f.app.request(
          '/action-interactions?sessionId=$session',
          {},
          f.bindings,
        )
      ).status,
    ).toBe(401);
    const disabled = fixture('false');
    expect(
      (
        await disabled.app.request(
          '/action-interactions?sessionId=$session',
          { headers: await authHeaders() },
          disabled.bindings,
        )
      ).status,
    ).toBe(404);
    expect(f.get).not.toHaveBeenCalled();
    expect(disabled.get).not.toHaveBeenCalled();
  });
  it('keeps the host duplicate guard active when preparation is disabled', async () => {
    const f = fixture('false');
    const response = await f.app.request(
      '/action-interactions/claim-dispatch',
      {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          version: 1,
          owner: {
            kind: 'flow-claim',
            accountDid: user.did,
            flowId: 'flow',
            runId: 'run',
            stepId: 'step',
            collectionId: 'collection',
            schemaDigest: 'schema',
            network: 'testnet',
          },
        }),
      },
      f.bindings,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'review_required' });
    expect(f.checkClaimDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ userDid: user.did }),
      expect.objectContaining({
        owner: expect.objectContaining({ runId: 'run' }),
      }),
    );
  });

  it('selects the signed user and refuses extra identity/execution fields before RPC mutation', async () => {
    const f = fixture();
    const headers = await authHeaders();
    const response = await f.app.request(
      '/action-interactions?sessionId=$session',
      { headers },
      f.bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(f.idFromName).toHaveBeenCalledWith(`${oracle.did}::${user.did}`);
    expect(f.readActionInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ userDid: user.did }),
      '$session',
      undefined,
    );
    const bad = await f.app.request(
      '/action-interactions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: '$session',
          owner: { kind: 'question', requestId: 'q' },
          values: {},
          userDid: 'did:ixo:another',
          execute: true,
        }),
      },
      f.bindings,
    );
    expect(bad.status).toBe(400);
    expect(f.actionInteraction).not.toHaveBeenCalled();
  });
  it('preserves serialized CAS errors across the Durable Object boundary', async () => {
    const f = fixture();
    const response = await f.app.request(
      '/action-interactions/id',
      {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({
          version: 1,
          requestId: crypto.randomUUID(),
          sessionId: '$session',
          expectedRevision: 1,
          kind: 'cancel',
        }),
      },
      f.bindings,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'stale_revision',
      message: 'changed',
    });
  });
});
