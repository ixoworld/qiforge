/**
 * The shell's public surface and its guards: which routes answer without a
 * UCAN invocation (and why), the operator debug routes behind auth, the
 * socket upgrade's pre-auth checks, the per-oracle rate-limit keys, body
 * caps enforced before buffering, the public gateway probes, CORS, and the
 * error body a 500 carries.
 */
import {
  createInvocation,
  generateKeypair,
  serializeInvocation,
  type Signer,
} from '@ixo/ucan';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { userObjectName } from '../do/contracts';
import {
  ABORT_BODY_BYTES,
  BUILTIN_EXCLUSIONS,
  createShell,
  DEBUG_BODY_BYTES,
  DELEGATION_BODY_BYTES,
  isDidShaped,
  rateLimitKey,
  type PluginRoute,
} from './app';

// did:key throughout: every DID resolves locally, Blocksync is never asked.
const ORACLE_DID = (await generateKeypair()).did;
const user = await generateKeypair();

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

/** A deployment's env with recording fakes for both objects and the limiter. */
function environment(
  opts: {
    running?: boolean;
    limited?: (key: string) => boolean;
    healthFails?: boolean;
    extra?: Record<string, unknown>;
  } = {},
) {
  const calls: string[] = [];
  const limiterKeys: string[] = [];
  const env = {
    ORACLE_DID,
    BLOCKSYNC_GRAPHQL_URL: 'https://blocksync.invalid/graphql',
    RATE_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        limiterKeys.push(key);
        return { success: !(opts.limited?.(key) ?? false) };
      },
    },
    MATRIX_GATEWAY: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string) => {
          calls.push(`gateway.fetch ${new URL(url).pathname}`);
          if (opts.healthFails) throw new Error('no such method');
          return Response.json({ running: opts.running ?? true });
        },
        status: async () => {
          calls.push('gateway.status');
          return { running: true, inbox: 0 };
        },
        ensureStarted: async () => {
          calls.push('gateway.ensureStarted');
          return { started: false, userId: '@bot:ixo.test', deviceId: 'D' };
        },
        stop: async () => {
          calls.push('gateway.stop');
        },
        restart: async () => {
          calls.push('gateway.restart');
          return { started: true, userId: '@bot:ixo.test', deviceId: 'D' };
        },
      }),
    },
    USER_ORACLE: {
      idFromName: (name: string) => name,
      get: (object: string) => ({
        fetch: async (request: Request | string) => {
          calls.push(
            `user.fetch ${object} ${new URL(typeof request === 'string' ? request : request.url).pathname}`,
          );
          return new Response('forwarded', { status: 200 });
        },
        abortTurn: async () => {
          calls.push(`user.abortTurn ${object}`);
          return false;
        },
        realtimeStatus: async () => {
          calls.push(`user.realtimeStatus ${object}`);
          return { sockets: 0 };
        },
      }),
    },
    ...opts.extra,
  };
  return { env, calls, limiterKeys };
}

describe('route exclusions', () => {
  it('are exactly the read-only / idempotent public routes', () => {
    expect(BUILTIN_EXCLUSIONS).toEqual([
      { path: '/', method: 'GET' },
      { path: '/health', method: 'ALL' },
      { path: '/health/*', method: 'ALL' },
      { path: '/models', method: 'GET' },
      { path: '/matrix/status', method: 'GET' },
      { path: '/matrix/start', method: 'POST' },
    ]);
  });

  it('each one answers without credentials', async () => {
    const { env, calls } = environment();
    const app = createShell();
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/health'],
      ['GET', '/health/matrix'],
      ['GET', '/models'],
      ['GET', '/matrix/status'],
      ['POST', '/matrix/start'],
    ] as const) {
      const res = await app.request(path, { method }, env);
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(calls).toEqual([
      'gateway.fetch /health',
      'gateway.status',
      'gateway.ensureStarted',
    ]);
  });

  it('a route that is not excluded refuses an anonymous caller', async () => {
    const { env, calls } = environment();
    const res = await createShell().request('/sessions', {}, env);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('operator debug routes', () => {
  const debugOn = { extra: { ORACLE_DEBUG_ROUTES: 'true' } };

  it('refuse an unauthenticated stop or restart of the gateway (401), and never touch it', async () => {
    const { env, calls } = environment(debugOn);
    const app = createShell();
    for (const path of ['/debug/matrix/stop', '/debug/matrix/restart']) {
      const res = await app.request(path, { method: 'POST' }, env);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
    expect(calls).toEqual([]);
  });

  it('run for any authenticated caller when the routes are enabled and no operator list is set', async () => {
    const { env, calls } = environment(debugOn);
    const res = await createShell().request(
      '/debug/matrix/stop',
      { method: 'POST', headers: await authHeaders(user.signer) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    expect(calls).toEqual(['gateway.stop']);
  });

  it('with ORACLE_OPERATOR_DIDS set, answer 403 to every other caller before the gateway is addressed', async () => {
    const operator = await generateKeypair();
    const { env, calls } = environment({
      extra: {
        ORACLE_DEBUG_ROUTES: 'true',
        ORACLE_OPERATOR_DIDS: ` ${operator.did} , did:ixo:ixo1someoneelse`,
      },
    });
    const app = createShell();
    const headers = await authHeaders(user.signer);
    for (const [method, path] of [
      ['POST', '/debug/matrix/stop'],
      ['POST', '/debug/matrix/restart'],
      ['POST', '/debug/matrix/abort'],
      ['POST', '/debug/matrix/rotate-device'],
      ['GET', '/debug/matrix/outbox'],
      ['POST', '/debug/matrix/event'],
    ] as const) {
      const res = await app.request(path, { method, headers }, env);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    expect(calls).toEqual([]);

    const res = await app.request(
      '/debug/matrix/stop',
      { method: 'POST', headers: await authHeaders(operator.signer) },
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(['gateway.stop']);
  });

  it('a malformed ORACLE_OPERATOR_DIDS admits nobody', async () => {
    const { env, calls } = environment({
      extra: {
        ORACLE_DEBUG_ROUTES: 'true',
        ORACLE_OPERATOR_DIDS: `${user.did},not-a-did`,
      },
    });
    const res = await createShell().request(
      '/debug/matrix/stop',
      { method: 'POST', headers: await authHeaders(user.signer) },
      env,
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("the allowlist governs only the gateway-wide routes, not the caller's own debug routes", async () => {
    const { env, calls } = environment({
      extra: {
        ORACLE_DEBUG_ROUTES: 'true',
        ORACLE_OPERATOR_DIDS: 'did:ixo:ixo1operator',
      },
    });
    const res = await createShell().request(
      '/debug/realtime',
      { headers: await authHeaders(user.signer) },
      env,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      `user.realtimeStatus ${userObjectName(user.did, ORACLE_DID)}`,
    ]);
  });

  it('are not found while ORACLE_DEBUG_ROUTES is off, even authenticated', async () => {
    const { env, calls } = environment();
    const res = await createShell().request(
      '/debug/matrix/stop',
      { method: 'POST', headers: await authHeaders(user.signer) },
      env,
    );
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('cap their bodies before reading them', async () => {
    const { env, calls } = environment(debugOn);
    const res = await createShell().request(
      '/debug/matrix/event',
      {
        method: 'POST',
        headers: await authHeaders(user.signer),
        body: JSON.stringify({
          type: 'm.test',
          content: { pad: 'x'.repeat(DEBUG_BODY_BYTES) },
        }),
      },
      env,
    );
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });
});

describe('socket upgrade (before CONNECT)', () => {
  const upgrade = (userDid: string, ip = '203.0.113.7') =>
    new Request(
      `https://oracle.test/socket.io/?EIO=4&transport=websocket&sessionId=s1&userDid=${encodeURIComponent(userDid)}`,
      { headers: { upgrade: 'websocket', 'cf-connecting-ip': ip } },
    );

  it('refuses a userDid that is not a DID before any object is addressed', async () => {
    const { env, calls, limiterKeys } = environment();
    for (const bad of [
      'alice',
      'did:ixo:',
      'did::x',
      'did:IXO:x',
      'did:ixo:a b',
    ]) {
      const res = await createShell().fetch(upgrade(bad), env);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
    expect(calls).toEqual([]);
    expect(limiterKeys).toEqual([]);
  });

  it('limits upgrades per client IP, under this oracle, before the user object is woken', async () => {
    const { env, calls, limiterKeys } = environment({
      limited: (key) => key.endsWith('|198.51.100.9'),
    });
    const ok = await createShell().fetch(upgrade(user.did), env);
    expect(ok.status).toBe(200);
    const limited = await createShell().fetch(
      upgrade(user.did, '198.51.100.9'),
      env,
    );
    expect(limited.status).toBe(429);
    expect(limiterKeys).toEqual([
      `${ORACLE_DID}|socket|203.0.113.7`,
      `${ORACLE_DID}|socket|198.51.100.9`,
    ]);
    expect(calls).toEqual([
      `user.fetch ${userObjectName(user.did, ORACLE_DID)} /socket.io/`,
    ]);
  });
});

describe('rate-limit keys', () => {
  it('carry the oracle DID, so bindings sharing a namespace_id do not share a budget', async () => {
    expect(
      rateLimitKey({ ORACLE_DID: 'did:ixo:a' }, 'user', 'did:ixo:u'),
    ).not.toBe(rateLimitKey({ ORACLE_DID: 'did:ixo:b' }, 'user', 'did:ixo:u'));
    const { env, limiterKeys } = environment();
    await createShell().request(
      '/messages/abort',
      {
        method: 'POST',
        headers: await authHeaders(user.signer),
        body: JSON.stringify({ sessionId: 's' }),
      },
      env,
    );
    expect(limiterKeys).toEqual([`${ORACLE_DID}|user|${user.did}`]);
  });
});

describe('public gateway probes', () => {
  it('GET /health/matrix asks the gateway for its in-memory flag only, never the full status', async () => {
    const up = environment({ running: true });
    const res = await createShell().request('/health/matrix', {}, up.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true });
    expect(up.calls).toEqual(['gateway.fetch /health']);

    const down = environment({ running: false });
    const stopped = await createShell().request('/health/matrix', {}, down.env);
    expect(stopped.status).toBe(503);
    expect(await stopped.json()).toEqual({ running: false });
  });

  it('GET /health/matrix answers 503 when the gateway cannot answer', async () => {
    const { env } = environment({ healthFails: true });
    const res = await createShell().request('/health/matrix', {}, env);
    expect(res.status).toBe(503);
  });

  it('POST /matrix/start is limited per IP, and an over-budget caller never reaches the gateway', async () => {
    const { env, calls, limiterKeys } = environment({ limited: () => true });
    const res = await createShell().request(
      '/matrix/start',
      { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.7' } },
      env,
    );
    expect(res.status).toBe(429);
    expect(limiterKeys).toEqual([`${ORACLE_DID}|start|203.0.113.7`]);
    expect(calls).toEqual([]);
  });

  it('GET /matrix/status is limited per IP when a limiter is bound, and an over-budget caller never reaches the gateway', async () => {
    const { env, calls, limiterKeys } = environment({ limited: () => true });
    const res = await createShell().request(
      '/matrix/status',
      { headers: { 'cf-connecting-ip': '203.0.113.7' } },
      env,
    );
    expect(res.status).toBe(429);
    expect(limiterKeys).toEqual([`${ORACLE_DID}|status|203.0.113.7`]);
    expect(calls).toEqual([]);
  });
});

describe('body caps', () => {
  it('refuse an oversized abort or delegation deposit with 413 before the handler runs', async () => {
    const { env, calls } = environment();
    const headers = await authHeaders(user.signer);
    const abort = await createShell().request(
      '/messages/abort',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'x'.repeat(ABORT_BODY_BYTES) }),
      },
      env,
    );
    expect(abort.status).toBe(413);
    const deposit = await createShell().request(
      '/delegation',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ raw: 'x'.repeat(DELEGATION_BODY_BYTES) }),
      },
      env,
    );
    expect(deposit.status).toBe(413);
    expect(calls).toEqual([]);
  });
});

describe('GET /models', () => {
  it("hands the provider a waitUntil that reaches the request's execution context", async () => {
    const { env } = environment();
    const kept: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => {
        kept.push(work);
      },
      passThroughOnException: () => undefined,
      props: {},
    };
    const refresh = Promise.resolve('prices');
    const app = createShell({
      listModels: (_env, options) => {
        options?.waitUntil?.(refresh);
        return { models: ['m'], default: 'm' };
      },
    });
    const res = await app.request('/models', {}, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ['m'], default: 'm' });
    expect(kept).toEqual([refresh]);
  });

  it('still answers when the app runs without an execution context', async () => {
    const { env } = environment();
    let handedOff = false;
    const app = createShell({
      listModels: (_env, options) => {
        options?.waitUntil?.(Promise.resolve());
        handedOff = true;
        return { models: [], default: null };
      },
    });
    const res = await app.request('/models', {}, env);
    expect(res.status).toBe(200);
    expect(handedOff).toBe(true);
  });
});

describe('CORS', () => {
  const preflight = (origin: string) =>
    new Request('https://oracle.test/sessions', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-auth-type',
      },
    });

  it('answers any origin without credentials when CORS_ORIGIN is unset', async () => {
    const { env } = environment();
    const res = await createShell().fetch(preflight('https://a.example'), env);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'authorization',
    );
  });

  it('answers only the configured origin, with credentials, when CORS_ORIGIN is set', async () => {
    const { env } = environment({
      extra: { CORS_ORIGIN: 'https://portal.example' },
    });
    const res = await createShell().fetch(
      preflight('https://portal.example'),
      env,
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://portal.example',
    );
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

describe('errors', () => {
  const throwing = (err: unknown): PluginRoute => ({
    method: 'GET',
    path: '/boom',
    handler: () => {
      throw err;
    },
  });

  it('a 500 carries a generic message and the request id, never the error text', async () => {
    const { env } = environment();
    const app = createShell({
      routes: [
        throwing(new Error('SQLITE_ERROR near "turn_inbox" !room:ixo.test')),
      ],
      authExcludedRoutes: [{ path: '/boom', method: 'GET' }],
    });
    const res = await app.request('/boom', {}, env);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(body)).not.toContain('SQLITE');
    expect(res.headers.get('x-request-id')).toBe(
      (body as { requestId: string }).requestId,
    );
    // The client's own request id is echoed when it is a sane token.
    const echoed = await app.request(
      '/boom',
      { headers: { 'x-request-id': 'req-123' } },
      env,
    );
    expect(await echoed.json()).toMatchObject({ requestId: 'req-123' });
  });

  it('an error thrown on purpose with a status keeps its status and message', async () => {
    const { env } = environment();
    const app = createShell({
      routes: [
        throwing(new HTTPException(409, { message: 'Already running' })),
      ],
      authExcludedRoutes: [{ path: '/boom', method: 'GET' }],
    });
    const res = await app.request('/boom', {}, env);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Already running');
  });
});

describe('isDidShaped', () => {
  it('accepts W3C DIDs and nothing else', () => {
    for (const did of [
      'did:ixo:ixo1abc',
      'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      'did:web:example.com:user:alice',
      'did:ixo:entity:abc%20def',
    ])
      expect({ did, shaped: isDidShaped(did) }).toEqual({ did, shaped: true });
    for (const not of [
      '',
      'did',
      'did:ixo',
      'did:ixo:',
      'did:ixo:a:',
      'DID:ixo:a',
      'did:ixo:a/b',
      'did:ixo:a?b',
      `did:ixo:${'a'.repeat(600)}`,
    ])
      expect({ not, shaped: isDidShaped(not) }).toEqual({
        not,
        shaped: false,
      });
  });
});
