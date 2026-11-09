import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CredentialsServiceError } from './errors';
import {
  canonicalJson,
  HubPermissionsClient,
  permissionBodySha256,
  PERMISSIONS_PATH,
} from './hub-client';
import {
  BINDING,
  HUB,
  json,
  noSleep,
  routedFetch,
  SERVICE_KEY,
} from './test-fixtures';

const CARD = {
  id: 'card_1',
  url: `${HUB}/a/card_1?t=permission`,
  status: 'pending',
  expiresAt: 1793000000,
};

const REQUEST = {
  ...BINDING,
  requestKey: 'key-1',
  expiresAt: 1793000000,
  permission: {
    kind: 'credential-check' as const,
    vct: 'https://credentials.ixo.world/types/IdentityLevel1',
    issuers: ['did:ixo:entity:80f392610e8a128b4f4b1ed828dbeb7f'],
    claims: ['age_over_18', 'identity_level'],
    days: 30,
  },
};

function client(fetchImpl: (r: Request) => Promise<Response>) {
  const facts: Record<string, unknown>[][] = [];
  let n = 0;
  const hub = new HubPermissionsClient({
    hubUrl: HUB,
    serviceKey: SERVICE_KEY,
    mint: async (f) => {
      facts.push(f);
      return `invocation-${++n}`;
    },
    fetchImpl,
    sleep: noSleep,
  });
  return { hub, facts };
}

describe('canonicalJson and body_sha256', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1}',
    );
  });

  it('hashes the body without its invocation field, keys sorted', async () => {
    const body = {
      permission: {
        kind: 'service-action',
        days: 7,
        action: 'self.identity-check',
      },
      bindingId: 'b',
      invocation: 'CAR',
    };
    const expected = createHash('sha256')
      .update(
        '{"bindingId":"b","permission":{"action":"self.identity-check","days":7,"kind":"service-action"}}',
      )
      .digest('hex');
    expect(await permissionBodySha256(body)).toBe(expected);
    // The invocation never changes the hash.
    expect(await permissionBodySha256({ ...body, invocation: 'OTHER' })).toBe(
      expected,
    );
  });
});

describe('HubPermissionsClient.request', () => {
  it('posts the card request with the service key and a body-bound invocation', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}${PERMISSIONS_PATH}`]: () => json(CARD, 201),
    });
    const { hub, facts } = client(fetchImpl);
    await expect(hub.request(REQUEST)).resolves.toEqual(CARD);
    const [call] = calls;
    expect(call?.headers.get('x-channels-service-key')).toBe(SERVICE_KEY);
    expect(call?.headers.get('content-type')).toBe('application/json');
    const sent = JSON.parse(call?.body ?? '{}');
    expect(sent.invocation).toBe('invocation-1');
    expect(sent.permission).toEqual(REQUEST.permission);
    // The fact binds method, path and the hash of exactly what was sent.
    expect(facts).toEqual([
      [
        {
          method: 'POST',
          path: PERMISSIONS_PATH,
          body_sha256: await permissionBodySha256(sent),
        },
      ],
    ]);
  });

  it('answers 401 as a typed refusal, without retrying', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}${PERMISSIONS_PATH}`]: () =>
        json(
          {
            error: 'unauthorized',
            message: "We couldn't confirm who is asking.",
          },
          401,
        ),
    });
    const { hub } = client(fetchImpl);
    const error = await hub.request(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialsServiceError);
    expect(error).toMatchObject({
      service: 'hub',
      status: 401,
      code: 'unauthorized',
    });
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 once after Retry-After, with a fresh invocation', async () => {
    const sleep = vi.fn(noSleep);
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}${PERMISSIONS_PATH}`]: [
        () =>
          json({ error: 'rate_limited', message: 'slow down' }, 429, {
            'retry-after': '2',
          }),
        () => json(CARD, 201),
      ],
    });
    const facts: unknown[] = [];
    const hub = new HubPermissionsClient({
      hubUrl: HUB,
      serviceKey: SERVICE_KEY,
      mint: async (f) => {
        facts.push(f);
        return `invocation-${facts.length}`;
      },
      fetchImpl,
      sleep,
    });
    await expect(hub.request(REQUEST)).resolves.toEqual(CARD);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls.map((c) => JSON.parse(c.body).invocation)).toEqual([
      'invocation-1',
      'invocation-2',
    ]);
    // Same body, same hash on the retry.
    expect(facts[0]).toEqual(facts[1]);
  });

  it('does not wait out a long Retry-After', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}${PERMISSIONS_PATH}`]: () =>
        json({ error: 'too_many_pending', message: 'wait' }, 429, {
          'retry-after': '60',
        }),
    });
    const { hub } = client(fetchImpl);
    await expect(hub.request(REQUEST)).rejects.toMatchObject({
      status: 429,
      code: 'too_many_pending',
      retryAfterSeconds: 60,
    });
    expect(calls).toHaveLength(1);
  });

  it('retries a 5xx once, then gives up', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`POST ${HUB}${PERMISSIONS_PATH}`]: () =>
        json({ error: 'name_unavailable', message: 'later' }, 503),
    });
    const { hub } = client(fetchImpl);
    await expect(hub.request(REQUEST)).rejects.toMatchObject({
      status: 503,
      code: 'name_unavailable',
    });
    expect(calls).toHaveLength(2);
  });

  it('turns a timeout into a typed error and does not retry it', async () => {
    let attempts = 0;
    const { hub } = client(async () => {
      attempts++;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    await expect(hub.request(REQUEST)).rejects.toMatchObject({
      status: 0,
      code: 'timeout',
    });
    expect(attempts).toBe(1);
  });

  it('refuses a card link that is not on the Hub', async () => {
    const { fetchImpl } = routedFetch({
      [`POST ${HUB}${PERMISSIONS_PATH}`]: () =>
        json({ ...CARD, url: 'https://evil.example/a/card_1' }, 201),
    });
    const { hub } = client(fetchImpl);
    await expect(hub.request(REQUEST)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('HubPermissionsClient.status', () => {
  it('reads with a GET-bound invocation in Authorization', async () => {
    const grants = [
      {
        can: 'identity/link',
        with: 'ixo:identity',
        audience: 'did:web:api.dev.self.ixo.earth',
        expiresAt: 1793000000,
        token: 'TOKEN',
      },
    ];
    const { fetchImpl, calls } = routedFetch({
      [`GET ${HUB}${PERMISSIONS_PATH}/card_1`]: () =>
        json({
          id: 'card_1',
          status: 'allowed',
          allowedAt: 1792000000,
          grants,
        }),
    });
    const { hub, facts } = client(fetchImpl);
    await expect(hub.status('card_1')).resolves.toMatchObject({
      status: 'allowed',
      grants,
    });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer invocation-1');
    expect(calls[0]?.headers.get('x-channels-service-key')).toBe(SERVICE_KEY);
    expect(facts).toEqual([
      [{ method: 'GET', path: `${PERMISSIONS_PATH}/card_1` }],
    ]);
  });

  it('refuses a malformed id without calling the Hub', async () => {
    const { fetchImpl, calls } = routedFetch({});
    const { hub } = client(fetchImpl);
    await expect(hub.status('../x')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(calls).toHaveLength(0);
  });
});
