/* eslint-disable no-console -- console IS the logger on Workers (Logs/observability). */
/**
 * The HTTP shell — a Hono app that speaks the same wire protocol as the Node
 * runtime's NestJS modules (`/sessions`, `/messages`, `/delegation`,
 * `/health`, `/models`) so the Portal, the CLI and `@ixo/oracles-client-sdk`
 * work unchanged. Every authenticated route resolves the caller's
 * `UserOracleDO` and forwards to it; streaming turns are proxied byte-for-byte.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { OracleWorkerEnv, TurnIdentity } from '../do/contracts';
import { parseOwnerCopyFailure } from '../owner-store/owner-copy-errors';
import { userObjectName } from '../do/contracts';
import { ROUTED_USER_HEADER } from '../realtime/realtime-endpoint';
import {
  decodeRoomStateContent,
  encodeRoomStateContent,
} from '../matrix/room-state-codec';
import {
  listDelegationCapabilities,
  type DelegatedCapability,
} from '../do/ucan-service';
import {
  authenticate,
  isExcluded,
  type AuthResult,
  type RouteExclusion,
} from './auth';
import { turnBodyTooLarge } from './turn-body-cap';

export interface PluginRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  path: string;
  /**
   * `ctx.auth` carries the validated caller identity for routes that are NOT
   * auth-excluded; it is null on excluded routes. Handlers may ignore it.
   */
  handler: (
    request: Request,
    env: OracleWorkerEnv,
    ctx: { auth: AuthResult | null },
  ) => Response | Promise<Response>;
}

export interface ShellOptions {
  /** Routes contributed by plugins (`getRoutes`) and the host. */
  routes?: PluginRoute[];
  /** Auth exclusions contributed by plugins and the host. */
  authExcludedRoutes?: RouteExclusion[];
  /** `GET /models` payload provider (may fetch live prices). */
  listModels?: (env: OracleWorkerEnv) => unknown | Promise<unknown>;
  /** Version banner for `GET /`. */
  banner?: { name: string; description?: string };
}

type Variables = { auth: AuthResult };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The rejection an in-flight RPC gets when `ctx.abort()` resets its object. */
function isAbortRejection(err: unknown): boolean {
  return /debug reset requested|reset requested by the debug route|durable object reset|no longer active|aborted/i.test(
    errorText(err),
  );
}

const BUILTIN_EXCLUSIONS: RouteExclusion[] = [
  { path: '/', method: 'GET' },
  { path: '/health', method: 'ALL' },
  { path: '/health/*', method: 'ALL' },
  { path: '/models', method: 'GET' },
  { path: '/matrix/status', method: 'GET' },
  { path: '/matrix/start', method: 'POST' },
  // Operator-only; the /debug/* middleware 404s unless ORACLE_DEBUG_ROUTES=true.
  { path: '/debug/matrix/restart', method: 'POST' },
  { path: '/debug/matrix/stop', method: 'POST' },
];

export function createShell(
  opts: ShellOptions = {},
): Hono<{ Bindings: OracleWorkerEnv; Variables: Variables }> {
  const app = new Hono<{ Bindings: OracleWorkerEnv; Variables: Variables }>();
  const exclusions = [
    ...BUILTIN_EXCLUSIONS,
    ...(opts.authExcludedRoutes ?? []),
  ];

  // --- realtime (socket.io) --------------------------------------------------
  // Registered before every middleware on purpose: a WebSocket upgrade
  // carries no auth headers (browsers cannot set them), so the UCAN material
  // travels in the socket.io CONNECT packet and the user object validates it
  // — the shell only routes on `?userDid`, and the object refuses a token
  // that does not belong to that DID. The 101 response must also reach the
  // client untouched (no CORS header rewriting on an upgraded response).
  app.all('/socket.io/*', async (c) => {
    const userDid = c.req.query('userDid');
    if (!userDid) {
      return c.json(
        { code: 3, message: 'userDid query parameter is required.' },
        400,
      );
    }
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json(
        {
          code: 3,
          message:
            'Expected a WebSocket upgrade: this runtime serves socket.io over the websocket transport only (connect with transports: ["websocket"]).',
        },
        426,
      );
    }
    const target = new URL(c.req.url);
    target.protocol = 'https:';
    target.host = 'user-oracle';
    const forwarded = new Request(target, c.req.raw);
    forwarded.headers.set(ROUTED_USER_HEADER, userDid);
    return userStub(c.env, userDid).fetch(forwarded);
  });

  app.use('*', async (c, next) => {
    const origin = c.env.CORS_ORIGIN ?? '*';
    return cors({
      origin,
      credentials: origin !== '*',
      allowHeaders: [
        'content-type',
        'authorization',
        'x-auth-type',
        'x-ucan-delegation',
        'x-did',
        'x-timezone',
        'x-request-id',
        'x-matrix-access-token',
        'accept',
      ],
      exposeHeaders: ['x-request-id'],
    })(c, next);
  });

  // --- public ----------------------------------------------------------------
  app.get('/', (c) =>
    c.json({
      status: 'ok',
      message: `${opts.banner?.name ?? c.env.ORACLE_NAME ?? 'QiForge oracle'} is running on Cloudflare Workers`,
      ...(opts.banner?.description && { description: opts.banner.description }),
      timestamp: new Date().toISOString(),
    }),
  );
  app.get('/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() }),
  );
  app.get('/health/matrix', async (c) => {
    const status = await gateway(c.env).status();
    return c.json(status, status.running ? 200 : 503);
  });
  app.get('/matrix/status', async (c) => c.json(await gateway(c.env).status()));
  app.post('/matrix/start', async (c) =>
    c.json(await gateway(c.env).ensureStarted()),
  );
  app.get('/models', async (c) =>
    c.json(
      (await opts.listModels?.(c.env)) ?? {
        models: [],
        // Node's `ModelListing` shape (`{ models, default }`); the client SDK
        // reads `default`.
        default: c.env.DEFAULT_MODEL ?? null,
      },
    ),
  );

  // --- auth ------------------------------------------------------------------
  app.use('*', async (c, next) => {
    if (isExcluded(c.req.method, c.req.path, exclusions)) return next();
    const outcome = await authenticate(c.req.raw.headers, {
      oracleDid: c.env.ORACLE_DID,
      blocksyncUri: c.env.BLOCKSYNC_GRAPHQL_URL,
      maxTtlSeconds: c.env.UCAN_AUTH_MAX_TTL_SECONDS
        ? Number(c.env.UCAN_AUTH_MAX_TTL_SECONDS)
        : undefined,
    });
    if (!outcome.ok)
      return c.json(
        { statusCode: outcome.status, message: outcome.error },
        outcome.status as 401,
      );
    c.set('auth', outcome.auth);
    return next();
  });

  // --- rate limit (per authenticated user DID) -------------------------------
  // Cloudflare's native limiter; the limit/period live on the binding in
  // wrangler.jsonc. Keyed by DID rather than IP so co-located users (one
  // NAT/proxy) never share a bucket and a single leaked token can't burn
  // unbounded LLM spend. Auth-excluded routes (health/models/matrix status)
  // ran `next()` above and never reach here. Absent binding = no limiting
  // (local harness / tests).
  app.use('*', async (c, next) => {
    const limiter = c.env.RATE_LIMIT;
    if (!limiter) return next();
    const auth = c.get('auth') as AuthResult | undefined;
    if (!auth) return next();
    const { success } = await limiter.limit({ key: auth.userDid });
    if (!success)
      return c.json(
        {
          statusCode: 429,
          message:
            'Rate limit exceeded — too many requests. Please slow down and try again shortly.',
        },
        429,
      );
    return next();
  });

  // --- sessions ----------------------------------------------------------------
  app.post('/sessions', async (c) => {
    const identity = identityOf(c.get('auth'), c.req.raw.headers);
    const session = await userStub(c.env, identity.userDid).createSession(
      identity,
    );
    return c.json(session, 201);
  });
  app.get('/sessions', async (c) => {
    const identity = identityOf(c.get('auth'), c.req.raw.headers);
    const limit = c.req.query('limit')
      ? Number(c.req.query('limit'))
      : undefined;
    const offset = c.req.query('offset')
      ? Number(c.req.query('offset'))
      : undefined;
    const { sessions, total } = await userStub(
      c.env,
      identity.userDid,
    ).listSessions(identity, { limit, offset });
    // Node's `ListChatSessionsResponseDto`: `{ sessions, total }`.
    return c.json({ sessions, total });
  });
  app.delete('/sessions/:sessionId', async (c) => {
    const identity = identityOf(c.get('auth'), c.req.raw.headers);
    const ok = await userStub(c.env, identity.userDid).deleteSession(
      identity,
      c.req.param('sessionId'),
    );
    return ok
      ? c.json({ message: 'Session deleted successfully' })
      : c.json({ message: 'Session not found' }, 404);
  });

  // --- messages ----------------------------------------------------------------
  app.post('/messages/abort', async (c) => {
    const identity = identityOf(c.get('auth'), c.req.raw.headers);
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string;
    };
    if (!body.sessionId)
      return c.json({ message: 'sessionId is required' }, 400);
    const success = await userStub(c.env, identity.userDid).abortTurn(
      body.sessionId,
    );
    return c.json({ success });
  });
  app.get('/messages/:sessionId', async (c) => {
    const identity = identityOf(c.get('auth'), c.req.raw.headers);
    const messages = await userStub(c.env, identity.userDid).listMessages(
      identity,
      c.req.param('sessionId'),
    );
    return new Response(`{"messages":${messages}}`, {
      headers: { 'content-type': 'application/json' },
    });
  });
  app.post('/messages/:sessionId', async (c) => {
    const identity = identityOf(c.get('auth'), c.req.raw.headers);
    const sessionId = c.req.param('sessionId');
    const body = await c.req.text();
    // Bounds the memory one request can pin (see turn-body-cap.ts); the
    // status and message are the ones Node's body parser uses.
    if (turnBodyTooLarge(body)) {
      return c.json(
        { statusCode: 413, message: 'request entity too large' },
        413,
      );
    }
    // Node accepts a client-supplied `requestId` (correlates the SSE events
    // with the client's own bookkeeping); fall back to a fresh UUID.
    const requestId = clientRequestId(body) ?? crypto.randomUUID();
    // The user object owns the turn; it returns either an SSE stream or JSON.
    // We pass the raw body through so attachments/tools/agActions survive.
    const res = await userStub(c.env, identity.userDid).fetch(
      `https://user-oracle/turn/${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId,
          'x-identity': JSON.stringify(identity),
        },
        body,
      },
    );
    const headers = new Headers(res.headers);
    headers.set('x-request-id', requestId);
    headers.set('access-control-expose-headers', 'x-request-id');
    return new Response(res.body, { status: res.status, headers });
  });

  // --- delegation (room-state persisted, for header-less Matrix turns) -----------
  app.post('/delegation', async (c) => {
    const auth = c.get('auth');
    const body = (await c.req.json().catch(() => ({}))) as {
      raw?: string;
      expiration?: number;
    };
    const raw = body.raw ?? auth.delegation;
    if (!raw) return c.json({ message: 'raw delegation is required' }, 400);
    const room = await gateway(c.env).resolveUserRoom(auth.userDid);
    if (!room) return c.json({ message: 'No oracle room for this user' }, 404);
    const expiration = body.expiration ?? auth.delegationExpiration;
    // The Node runtime's `DelegationStore` record, in its compressed
    // room-state envelope, so a user can move between runtimes without
    // re-authorising (`updatedAt` is required by Node's schema).
    await gateway(c.env).sendStateEvent(
      room.roomId,
      'ixo.room.state',
      JSON.stringify(
        await encodeRoomStateContent({
          raw,
          issuer: auth.userDid,
          audience: c.env.ORACLE_DID,
          ...(expiration && { expiration }),
          updatedAt: new Date().toISOString(),
        }),
      ),
      'ucan_delegation',
    );
    // The user's object caches the delegation for header-less (Matrix)
    // turns; hand it the new one so it takes effect immediately rather
    // than when the cached copy expires (Node's cacheDelegation semantics).
    await userStub(c.env, auth.userDid)
      .setDelegation(auth.userDid, raw, expiration)
      .catch((err: unknown) => {
        console.warn(
          `[shell] could not push the deposited delegation to ${auth.userDid}'s object: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    return c.json({
      ok: true,
      expiration: body.expiration ?? auth.delegationExpiration,
    });
  });
  app.get('/delegation', async (c) => {
    const auth = c.get('auth');
    const room = await gateway(c.env).resolveUserRoom(auth.userDid);
    if (!room) return c.json({ authorized: false });
    const raw = await gateway(c.env).getRoomStateEvent(
      room.roomId,
      'ixo.room.state',
      'ucan_delegation',
    );
    const state = raw
      ? ((await decodeRoomStateContent(JSON.parse(raw) as unknown)) as {
          raw?: string;
          expiration?: number;
        } | null)
      : null;
    const exp =
      typeof state?.expiration === 'number' ? state.expiration : undefined;
    const authorized =
      Boolean(state?.raw) &&
      (exp === undefined || exp > Math.floor(Date.now() / 1000));
    // The stored delegation's capabilities, so a client can tell an older
    // delegation (minted before a capability existed — e.g. the file-storage
    // grant the owner copy needs) from a current one and re-authorize.
    let capabilities: DelegatedCapability[] | undefined;
    if (authorized && state?.raw) {
      try {
        capabilities = await listDelegationCapabilities(state.raw);
      } catch (err) {
        console.warn(
          `[shell] stored delegation for ${auth.userDid} could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return c.json({
      authorized,
      ...(exp !== undefined && { expiration: exp }),
      ...(capabilities !== undefined && { capabilities }),
    });
  });
  app.delete('/delegation', async (c) => {
    const auth = c.get('auth');
    const room = await gateway(c.env).resolveUserRoom(auth.userDid);
    if (room)
      await gateway(c.env).sendStateEvent(
        room.roomId,
        'ixo.room.state',
        JSON.stringify(await encodeRoomStateContent({})),
        'ucan_delegation',
      );
    // Node's revokeDelegationForUser clears the cache so downstream minting
    // stops NOW, not at the cache TTL. Same here: drop the object's copy.
    await userStub(c.env, auth.userDid)
      .clearDelegation(auth.userDid)
      .catch((err: unknown) => {
        console.warn(
          `[shell] could not clear ${auth.userDid}'s cached delegation: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    return c.json({ ok: true });
  });

  // --- byo-llm (bring-your-own-credential LLMs) --------------------------------
  // The user's object owns the credentials (secrets service, refresh state),
  // so every route is proxied there — same pattern as streaming turns. The
  // shell only short-circuits the disabled case so stray requests never boot
  // a Durable Object.
  app.all('/byo-llm/*', async (c) => {
    if (c.env.BYO_LLM_ENABLED !== 'true') {
      return c.req.method === 'GET' && c.req.path === '/byo-llm/status'
        ? c.json({ enabled: false, providers: [] })
        : c.json(
            {
              statusCode: 404,
              message:
                'Bring-your-own-credential LLMs are not enabled on this oracle',
            },
            404,
          );
    }
    const identity = identityOf(c.get('auth'), c.req.raw.headers);
    const url = new URL(c.req.raw.url);
    const method = c.req.method.toUpperCase();
    const init: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        'x-identity': JSON.stringify(identity),
      },
    };
    if (method !== 'GET' && method !== 'HEAD') init.body = await c.req.text();
    const res = await userStub(c.env, identity.userDid).fetch(
      `https://user-oracle${url.pathname}${url.search}`,
      init,
    );
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  // --- debug / operator routes (enabled with ORACLE_DEBUG_ROUTES=true) -------------
  app.use('/debug/*', async (c, next) => {
    if (c.env.ORACLE_DEBUG_ROUTES !== 'true')
      return c.json({ statusCode: 404, message: 'Not found' }, 404);
    return next();
  });
  app.get('/debug/storage', async (c) =>
    c.json(await userStub(c.env, c.get('auth').userDid).storageStatus()),
  );
  app.post('/debug/storage/flush', async (c) =>
    c.json(await userStub(c.env, c.get('auth').userDid).flushToOwnerStore()),
  );
  app.post('/debug/storage/reset', async (c) =>
    c.json(await userStub(c.env, c.get('auth').userDid).resetWorkingCopy()),
  );
  app.post('/debug/object/abort', async (c) => {
    try {
      await userStub(c.env, c.get('auth').userDid).debugAbortObject();
    } catch (err) {
      // The abort tears the object down under the call: that rejection is
      // the expected signal. Anything else (an older build without the
      // method, a transport error) is a real failure.
      if (!isAbortRejection(err))
        return c.json({ aborted: false, error: errorText(err) }, 500);
    }
    return c.json({ aborted: true });
  });
  app.get('/debug/memory-schema', async (c) => {
    const userDid = c.get('auth').userDid;
    return c.json(await userStub(c.env, userDid).debugMemorySchema(userDid));
  });
  app.get('/debug/sessions/:sessionId', async (c) => {
    const userDid = c.get('auth').userDid;
    const row = await userStub(c.env, userDid).debugSession(
      userDid,
      c.req.param('sessionId'),
    );
    return row
      ? c.json(row)
      : c.json({ statusCode: 404, message: 'Session not found' }, 404);
  });
  app.get('/debug/tasks', async (c) =>
    c.json(
      await userStub(c.env, c.get('auth').userDid).tasksStatus(
        c.get('auth').userDid,
      ),
    ),
  );
  app.get('/debug/realtime', async (c) =>
    c.json(await userStub(c.env, c.get('auth').userDid).realtimeStatus()),
  );
  app.post('/debug/reauth-prompt/reset', async (c) => {
    await userStub(c.env, c.get('auth').userDid).debugResetReauthThrottle();
    return c.json({ reset: true });
  });
  app.get('/debug/delegation', async (c) =>
    c.json(
      await userStub(c.env, c.get('auth').userDid).delegationStatus(
        c.get('auth').userDid,
      ),
    ),
  );
  app.post('/debug/matrix/rotate-device', async (c) =>
    c.json(await gateway(c.env).rotateDevice('operator')),
  );
  app.get('/debug/matrix/outbox', async (c) =>
    c.json({ rows: await gateway(c.env).listOutbox() }),
  );
  app.post('/debug/matrix/abort', async (c) => {
    try {
      await gateway(c.env).debugAbortObject();
    } catch (err) {
      if (!isAbortRejection(err))
        return c.json({ aborted: false, error: errorText(err) }, 500);
    }
    return c.json({ aborted: true });
  });
  app.post('/debug/matrix/restart', async (c) =>
    c.json(await gateway(c.env).restart()),
  );
  app.post('/debug/matrix/stop', async (c) => {
    await gateway(c.env).stop();
    return c.json({ stopped: true });
  });

  // --- plugin / host routes ------------------------------------------------------
  for (const route of opts.routes ?? []) {
    const path = route.path.startsWith('/') ? route.path : `/${route.path}`;
    const handler = async (c: {
      req: { raw: Request };
      env: OracleWorkerEnv;
      get: (key: 'auth') => AuthResult | undefined;
    }) => route.handler(c.req.raw, c.env, { auth: c.get('auth') ?? null });
    if (route.method === 'ALL') app.all(path, handler);
    else app.on(route.method, path, handler);
  }

  app.notFound((c) =>
    c.json(
      { statusCode: 404, message: `Cannot ${c.req.method} ${c.req.path}` },
      404,
    ),
  );
  app.onError((err, c) => {
    console.error(`[shell] ${c.req.method} ${c.req.path} failed:`, err);
    // A cold boot that could not read the user's owner copy changed nothing.
    // Say precisely why: 503 + retryable for a transient store/VFS failure
    // (the object already retried with backoff), 403 for a missing
    // `ixo:filesystem` delegation or rejected credentials, where retrying
    // cannot help and the client must act.
    // The user object throws these as an RPC envelope (a plain Error on
    // this side); `parseOwnerCopyFailure` reads the class, the envelope or
    // the raw store errors alike.
    const failure = parseOwnerCopyFailure(err);
    if (failure) {
      return c.json(
        {
          statusCode: failure.httpStatus,
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
        failure.httpStatus,
      );
    }
    return c.json(
      { statusCode: 500, message: err.message || 'Internal error' },
      500,
    );
  });

  return app;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The body's `requestId` when it is a sane opaque token; null otherwise. */
function clientRequestId(rawBody: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') {
      const id = (parsed as { requestId?: unknown }).requestId;
      if (typeof id === 'string' && REQUEST_ID_RE.test(id)) return id;
    }
  } catch {
    // not JSON — the user object reports the malformed body
  }
  return null;
}

function identityOf(auth: AuthResult, headers: Headers): TurnIdentity {
  return {
    userDid: auth.userDid,
    ucanDelegation: auth.delegation,
    ucanDelegationExpiration: auth.delegationExpiration,
    timezone: headers.get('x-timezone') ?? undefined,
  };
}

export function userStub(env: OracleWorkerEnv, userDid: string) {
  const id = env.USER_ORACLE.idFromName(
    userObjectName(userDid, env.ORACLE_DID),
  );
  return env.USER_ORACLE.get(id);
}

export function gateway(env: OracleWorkerEnv) {
  const id = env.MATRIX_GATEWAY.idFromName(env.ORACLE_DID);
  return env.MATRIX_GATEWAY.get(id);
}
