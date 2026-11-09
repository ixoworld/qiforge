import { describe, expect, it, vi } from 'vitest';
import type { OracleWorkerEnv } from '../../do/contracts';
import {
  credentialsResponseRoute,
  openResponseToken,
  sealResponseToken,
  type DeliverToOwner,
} from './response-route';
import { ORACLE_DID, PERSON_DID, SERVICE_KEY } from './test-fixtures';

const SECRET = { serviceKey: SERVICE_KEY, oracleDid: ORACLE_DID };
const NOW = 1_793_000_000;
const TARGET = {
  ownerDid: PERSON_DID,
  checkId: 'abcdefghijklmnopqrstuv',
  expiresAt: NOW + 900,
};

function envOf(): OracleWorkerEnv {
  // Only the two keys the route reads; the rest of the env is not used.
  return Object.assign(Object.create(null), {
    AUTH_HUB_CHANNEL_SERVICE_KEY: SERVICE_KEY,
    ORACLE_DID,
  });
}

function post(token: string, body = 'response=JWE') {
  return new Request(`https://oracle.ixo.world/credentials/response/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

describe('response tokens', () => {
  it('round-trip, and never show the person in the token', async () => {
    const token = await sealResponseToken(TARGET, SECRET);
    expect(token).not.toContain('ixo1');
    await expect(openResponseToken(token, SECRET, NOW)).resolves.toEqual(
      TARGET,
    );
  });

  it('are refused when tampered with, ended, or sealed with another key', async () => {
    const token = await sealResponseToken(TARGET, SECRET);
    const flipped = `${token.slice(0, -2)}${token.endsWith('AA') ? 'AB' : 'AA'}`;
    await expect(openResponseToken(flipped, SECRET, NOW)).resolves.toBeNull();
    await expect(
      openResponseToken(token, SECRET, NOW + 901),
    ).resolves.toBeNull();
    await expect(
      openResponseToken(token, { ...SECRET, serviceKey: 'another-key' }, NOW),
    ).resolves.toBeNull();
    await expect(
      openResponseToken(token, { ...SECRET, oracleDid: 'did:ixo:other' }, NOW),
    ).resolves.toBeNull();
  });
});

describe('POST /credentials/response/:token', () => {
  it('delivers the answer to the owner of the check', async () => {
    const deliver = vi.fn<DeliverToOwner>(async () => true);
    const route = credentialsResponseRoute(deliver);
    const token = await sealResponseToken(
      { ...TARGET, expiresAt: Math.floor(Date.now() / 1000) + 900 },
      SECRET,
    );
    const res = await route.handler(post(token), envOf(), { auth: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerDid: PERSON_DID,
        checkId: TARGET.checkId,
      }),
      'response=JWE',
    );
  });

  it('refuses a token it did not make without waking any object', async () => {
    const deliver = vi.fn<DeliverToOwner>(async () => true);
    const res = await credentialsResponseRoute(deliver).handler(
      post('A'.repeat(80)),
      envOf(),
      { auth: null },
    );
    expect(res.status).toBe(404);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('answers 410 for a closed check, 413 for a large body, 503 when the object fails', async () => {
    const token = await sealResponseToken(
      { ...TARGET, expiresAt: Math.floor(Date.now() / 1000) + 900 },
      SECRET,
    );
    const closed = credentialsResponseRoute(async () => false);
    expect(
      (await closed.handler(post(token), envOf(), { auth: null })).status,
    ).toBe(410);
    const big = credentialsResponseRoute(async () => true);
    expect(
      (
        await big.handler(post(token, 'x'.repeat(30 * 1024)), envOf(), {
          auth: null,
        })
      ).status,
    ).toBe(413);
    const down = credentialsResponseRoute(async () => {
      throw new Error('object unavailable');
    });
    expect(
      (await down.handler(post(token), envOf(), { auth: null })).status,
    ).toBe(503);
  });
});
