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
const { signer, did } = await signerFromMnemonic(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const decision = {
  approvalRequestId: '00000000-0000-4000-8000-000000000001',
  decision: 'approve',
  note: 'Audit only',
};
function fixture() {
  const taskApproval = vi.fn(async () => ({
    resolved: true,
    task: null,
    receipts: [],
  }));
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn(() => ({ taskApproval }));
  return {
    app: createShell(),
    taskApproval,
    idFromName,
    get,
    bindings: {
      ORACLE_DID: oracleDid,
      BLOCKSYNC_GRAPHQL_URL: 'https://unused.example.com',
      UCAN_ALLOW_BARE_DELEGATION_AUTH: 'true',
      USER_ORACLE: { idFromName, get },
    },
  };
}
async function invocation() {
  return serializeInvocation(
    await createInvocation({
      issuer: signer,
      audience: oracleDid,
      capability: { can: '*', with: 'ixo:oracle' },
      expiration: Math.floor(Date.now() / 1000) + 300,
    }),
  );
}
describe('trusted task approval HTTP boundary', () => {
  it('requires signed owner invocation even when legacy delegation fallback is enabled', async () => {
    const f = fixture();
    const delegation = await serializeDelegation(
      await createDelegation({
        issuer: signer,
        audience: oracleDid,
        capabilities: [{ can: '*', with: 'ixo:oracle' }],
        expiration: Math.floor(Date.now() / 1000) + 300,
      }),
    );
    for (const method of ['GET', 'POST']) {
      const res = await f.app.request(
        '/task-approvals/task_post_a1b2c3d4',
        {
          method,
          headers: {
            'x-ucan-delegation': delegation,
            'content-type': 'application/json',
          },
          ...(method === 'POST' ? { body: JSON.stringify(decision) } : {}),
        },
        f.bindings,
      );
      expect(res.status).toBe(401);
    }
    expect(f.get).not.toHaveBeenCalled();
  });
  it('uses signed principal and rejects forged actor fields before owner mutation', async () => {
    const f = fixture();
    const headers = {
      authorization: `Bearer ${await invocation()}`,
      'x-auth-type': 'ucan',
      'x-did': 'did:web:victim.example',
      'content-type': 'application/json',
    };
    const res = await f.app.request(
      '/task-approvals/task_post_a1b2c3d4?userDid=did:web:victim.example',
      { method: 'POST', headers, body: JSON.stringify(decision) },
      f.bindings,
    );
    expect(res.status).toBe(200);
    expect(f.idFromName).toHaveBeenCalledWith(`${oracleDid}::${did}`);
    expect(f.taskApproval).toHaveBeenCalledWith(
      expect.objectContaining({ userDid: did }),
      'task_post_a1b2c3d4',
      decision,
    );
    const forged = await f.app.request(
      '/task-approvals/task_post_a1b2c3d4',
      {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${await invocation()}` },
        body: JSON.stringify({
          ...decision,
          actorDid: 'did:web:victim.example',
        }),
      },
      f.bindings,
    );
    expect(forged.status).toBe(400);
    expect(f.taskApproval).toHaveBeenCalledTimes(1);
  });
});
