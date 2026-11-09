import { describe, expect, it, vi } from 'vitest';
import type { OracleWorkerEnv } from '../../do/contracts';
import {
  credentialsResponseRoute,
  isWellFormedDelivery,
  openResponseToken,
  sealResponseToken,
  WindowLimiter,
  type VerifyInOwner,
} from './response-route';
import { ORACLE_DID, PERSON_DID, SERVICE_KEY } from './test-fixtures';

const SECRET = { serviceKey: SERVICE_KEY, oracleDid: ORACLE_DID };
const NOW = 1_793_000_000;
const KID = 'enc-AbCdEfGhIjKl';
const TARGET = {
  ownerDid: PERSON_DID,
  checkId: 'abcdefghijklmnopqrstuv',
  expiresAt: NOW + 900,
  kid: KID,
};

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** A body shaped like an encrypted OpenID4VP answer (direct_post.jwt). */
function answerBody(header: Record<string, unknown> = {}) {
  const protectedHeader = b64({
    alg: 'ECDH-ES',
    enc: 'A256GCM',
    kid: KID,
    epk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    ...header,
  });
  return `response=${protectedHeader}..aXY.Y2lwaGVy.dGFn`;
}

function envOf(): OracleWorkerEnv {
  // Only the keys the route reads; the rest of the env is not used.
  return Object.assign(Object.create(null), {
    CREDENTIALS_ENABLED: 'true',
    AUTH_HUB_CHANNEL_SERVICE_KEY: SERVICE_KEY,
    ORACLE_DID,
  });
}

function post(token: string, body = answerBody(), ip = '203.0.113.7') {
  return new Request(`https://oracle.ixo.world/credentials/response/${token}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': ip,
    },
    body,
  });
}

/** Fresh limiters per test (the module's own are per isolate). */
function limits(perCheck = 10, perIp = 60) {
  return {
    perCheck: new WindowLimiter(perCheck),
    perIp: new WindowLimiter(perIp),
  };
}

const live = () => ({
  ...TARGET,
  expiresAt: Math.floor(Date.now() / 1000) + 900,
});

describe('response tokens', () => {
  it('round-trip with the answer key id, and never show the person', async () => {
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

describe('isWellFormedDelivery', () => {
  it('takes one encrypted answer for this key', () => {
    expect(isWellFormedDelivery(answerBody(), KID)).toBe(true);
    expect(isWellFormedDelivery(answerBody({ enc: 'A128GCM' }), KID)).toBe(
      true,
    );
  });

  it('refuses anything else', () => {
    expect(isWellFormedDelivery('response=junk', KID)).toBe(false);
    expect(isWellFormedDelivery(answerBody({ kid: 'enc-other' }), KID)).toBe(
      false,
    );
    expect(isWellFormedDelivery(answerBody({ alg: 'RSA-OAEP' }), KID)).toBe(
      false,
    );
    expect(isWellFormedDelivery(answerBody({ epk: null }), KID)).toBe(false);
    expect(isWellFormedDelivery(`${answerBody()}&state=x`, KID)).toBe(false);
    expect(isWellFormedDelivery('error=access_denied&state=s', KID)).toBe(
      false,
    );
    // An encrypted key segment means a key-wrapping algorithm, not ECDH-ES.
    expect(
      isWellFormedDelivery(answerBody().replace('..aXY', '.a2V5.aXY'), KID),
    ).toBe(false);
  });
});

const OK = { status: 200 as const };
const REFUSED = {
  status: 400 as const,
  body: { error: 'invalid_response', message: 'x' },
};

describe('POST /credentials/response/:token', () => {
  it("hands a well-formed answer to the person's object, which verifies it", async () => {
    const verify = vi.fn<VerifyInOwner>(async () => OK);
    const route = credentialsResponseRoute(verify, limits());
    const token = await sealResponseToken(live(), SECRET);
    const res = await route.handler(post(token), envOf(), { auth: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(verify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerDid: PERSON_DID,
        checkId: TARGET.checkId,
      }),
      answerBody(),
    );
  });

  it('is off (404) unless CREDENTIALS_ENABLED is true', async () => {
    const verify = vi.fn<VerifyInOwner>(async () => OK);
    const token = await sealResponseToken(live(), SECRET);
    const env = Object.assign(envOf(), { CREDENTIALS_ENABLED: 'false' });
    const res = await credentialsResponseRoute(verify, limits()).handler(
      post(token),
      env,
      { auth: null },
    );
    expect(res.status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses junk with 400 before any object is woken, and charges no check budget', async () => {
    const verify = vi.fn<VerifyInOwner>(async () => OK);
    const limiter = limits(1, 100);
    const route = credentialsResponseRoute(verify, limiter);
    const token = await sealResponseToken(live(), SECRET);
    for (const body of [
      'response=junk',
      answerBody({ kid: 'enc-other' }),
      'a=b',
      '',
    ]) {
      const res = await route.handler(post(token, body), envOf(), {
        auth: null,
      });
      expect(res.status).toBe(400);
    }
    expect(verify).not.toHaveBeenCalled();
    expect(limiter.perCheck.blocked(TARGET.checkId)).toBe(false);
  });

  it("passes the object's refusal on and charges the check's failed-answer budget only then", async () => {
    const verify = vi.fn<VerifyInOwner>(async () => REFUSED);
    const route = credentialsResponseRoute(verify, limits(2, 100));
    const token = await sealResponseToken(live(), SECRET);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await route.handler(post(token), envOf(), { auth: null })).status,
      );
    expect(statuses).toEqual([400, 400, 429]);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('charges every answer that is not accepted (400, 503, a thrown error) to the check', async () => {
    const token = await sealResponseToken(live(), SECRET);
    for (const verify of [
      async () => REFUSED,
      async () => ({ status: 503 as const }),
      async () => {
        throw new Error('boom');
      },
    ]) {
      const route = credentialsResponseRoute(verify, limits(2, 100));
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++)
        statuses.push(
          (await route.handler(post(token), envOf(), { auth: null })).status,
        );
      expect(statuses[2]).toBe(429);
    }
  });

  it('refuses a token it did not make without waking any object', async () => {
    const verify = vi.fn<VerifyInOwner>(async () => OK);
    const res = await credentialsResponseRoute(verify, limits()).handler(
      post('A'.repeat(80)),
      envOf(),
      { auth: null },
    );
    expect(res.status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
  });

  it('limits calls per IP', async () => {
    const verify = vi.fn<VerifyInOwner>(async () => OK);
    const token = await sealResponseToken(live(), SECRET);
    const perIp = credentialsResponseRoute(verify, limits(100, 1));
    expect(
      (await perIp.handler(post(token), envOf(), { auth: null })).status,
    ).toBe(200);
    const limited = await perIp.handler(post(token), envOf(), { auth: null });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('10');
  });

  it('uses the CREDENTIALS_RATE_LIMIT binding (its own budget, keyed by IP) when the Worker has one', async () => {
    const verify = vi.fn<VerifyInOwner>(async () => OK);
    const keys: string[] = [];
    const env = Object.assign(envOf(), {
      CREDENTIALS_RATE_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const token = await sealResponseToken(live(), SECRET);
    const res = await credentialsResponseRoute(verify, limits()).handler(
      post(token),
      env,
      { auth: null },
    );
    expect(res.status).toBe(429);
    expect(keys).toEqual([`${ORACLE_DID}|credentials-response|203.0.113.7`]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('answers 410 for a closed check, 413 for a large body, 503 when the object fails', async () => {
    const token = await sealResponseToken(live(), SECRET);
    const closed = credentialsResponseRoute(
      async () => ({
        status: 410,
        body: { error: 'check_closed', message: 'ended' },
      }),
      limits(),
    );
    expect(
      (await closed.handler(post(token), envOf(), { auth: null })).status,
    ).toBe(410);
    const big = credentialsResponseRoute(async () => OK, limits());
    expect(
      (
        await big.handler(post(token, 'x'.repeat(30 * 1024)), envOf(), {
          auth: null,
        })
      ).status,
    ).toBe(413);
    const down = credentialsResponseRoute(async () => {
      throw new Error('object unavailable');
    }, limits());
    expect(
      (await down.handler(post(token), envOf(), { auth: null })).status,
    ).toBe(503);
  });
});
