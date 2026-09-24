import {
  createDelegation,
  createInvocation,
  generateKeypair,
  serializeDelegation,
  serializeInvocation,
} from '@ixo/ucan';
import { describe, expect, it, vi } from 'vitest';
import { createShell } from '../shell/app';

it('authenticates a Reporter request and forwards local grants without depositing them', async () => {
  const user = await generateKeypair();
  const oracle = await generateKeypair();
  const expiration = Math.floor(Date.now() / 1000) + 55;
  const invocation = await serializeInvocation(
    await createInvocation({
      issuer: user.signer,
      audience: oracle.did,
      capability: { can: '*', with: 'ixo:oracle' },
      expiration,
    }),
  );
  const delegation = await serializeDelegation(
    await createDelegation({
      issuer: user.signer,
      audience: oracle.did,
      capabilities: [{ can: 'fs/list', with: 'ixo:filesystem/.oracles' }],
      expiration,
    }),
  );
  const dispatch = vi.fn(async (_url: string, init: RequestInit) =>
    Response.json({
      identity: JSON.parse(new Headers(init.headers).get('x-identity') ?? '{}'),
    }),
  );
  const setDelegation = vi.fn();
  const sendStateEvent = vi.fn();
  const env = {
    ORACLE_DID: oracle.did,
    BLOCKSYNC_GRAPHQL_URL: 'https://unused.example',
    USER_ORACLE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: dispatch, setDelegation }),
    },
    MATRIX_GATEWAY: { get: () => ({ sendStateEvent }) },
  };
  const response = await createShell({
    reporter: { profile: 'reporter-grounded-v1' },
  }).request(
    '/reporter/capabilities',
    {
      headers: {
        authorization: `Bearer ${invocation}`,
        'x-auth-type': 'ucan',
        'x-ucan-delegation': delegation,
      },
    },
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    identity: {
      userDid: user.did,
      ucanDelegation: delegation,
      ucanDelegationExpiration: expiration,
    },
  });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(setDelegation).not.toHaveBeenCalled();
  expect(sendStateEvent).not.toHaveBeenCalled();
});

describe('Reporter authentication cannot be excluded by host settings', () => {
  it('rejects an unauthenticated request even when the host excluded the namespace', async () => {
    const response = await createShell({
      reporter: { profile: 'reporter-grounded-v1' },
      authExcludedRoutes: [{ path: '/reporter/*' }],
    }).request('/reporter/capabilities', {}, { ORACLE_DID: 'did:ixo:oracle' });
    expect(response.status).toBe(401);
  });
});
