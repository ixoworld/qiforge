/**
 * UCAN authentication for the Workers shell — a port of the Node runtime's
 * `AuthHeaderMiddleware` (`modules/auth/*`), same headers, same semantics:
 *
 *  - Primary:  `Authorization: Bearer <invocation>` + `X-Auth-Type: ucan` — a
 *    user-self-signed root invocation for `{ can: '*', with: 'ixo:oracle' }`
 *    addressed to this oracle's DID. Proves WHO is calling; short TTL.
 *  - `x-ucan-delegation: <base64 CAR>` — authorization material for the
 *    runtime's downstream calls, used when present. It does NOT
 *    authenticate on its own: a delegation is a grant the user hands to
 *    this oracle and it travels on as proof in the invocations the runtime
 *    mints for other services, so anyone who has seen one could otherwise
 *    present it and act as the user. `UCAN_ALLOW_BARE_DELEGATION_AUTH=true`
 *    restores the old fallback for clients that do not send an invocation
 *    yet (the shell logs a deprecation warning per request). A delegation
 *    is only trusted when its issuer equals the authenticated DID and it
 *    expires: a delegation with no expiry anywhere in its chain is refused,
 *    since the runtime stores it and mints on it long after the request,
 *    and nothing else would ever end it.
 *
 * The returned `userDid` is always the cryptographically recovered signer,
 * never a client-claimed value. `did:ixo` keys resolve through Blocksync.
 * Verdicts are cached per isolate keyed by a hash of the token, bounded by
 * the token's own expiry.
 */
import {
  createIxoDIDResolver,
  createUCANValidator,
  createUcanStoreRevocationChecker,
  defineCapability,
  type DIDKeyResolver,
  type InvocationStore,
} from '@ixo/ucan';

/**
 * The shell keeps no replay marks. An auth invocation is a bearer token the
 * client reuses for its whole (short, `UCAN_AUTH_MAX_TTL_SECONDS`-bounded)
 * lifetime, often on several requests at once, so a single-use mark would
 * refuse legitimate repeats. A no-op store also keeps the library from
 * creating its default store, whose hourly `setInterval` would keep a Durable
 * Object resident (this code also runs inside the user object for socket
 * CONNECT auth) and block WebSocket hibernation.
 */
const reusableInvocations: InvocationStore = {
  has: async () => false,
  add: async () => undefined,
  addIfAbsent: async () => true,
};

/**
 * did:ixo key lookups are cached per isolate for this long. A key rotated out
 * of, or removed from, a DID document on-chain is still trusted for up to
 * this long after the change. Failed lookups are never cached.
 */
export const IXO_DID_RESOLUTION_CACHE_TTL_MS = 60_000;
/** Distinct Blocksync URLs that keep a resolver; a deployment uses one. */
const MAX_IXO_RESOLVERS = 8;
const ixoResolvers = new Map<string, DIDKeyResolver>();

/**
 * The isolate's did:ixo resolver for one Blocksync GraphQL URL, built once and
 * reused so its resolution cache and in-flight de-duplication span requests.
 * Each lookup keeps the library's default timeout.
 */
export function sharedIxoDIDResolver(indexerUrl: string): DIDKeyResolver {
  const existing = ixoResolvers.get(indexerUrl);
  if (existing) return existing;
  if (ixoResolvers.size >= MAX_IXO_RESOLVERS) {
    const oldest = ixoResolvers.keys().next().value;
    if (oldest !== undefined) ixoResolvers.delete(oldest);
  }
  const resolver = createIxoDIDResolver({
    indexerUrl,
    cacheTtlMs: IXO_DID_RESOLUTION_CACHE_TTL_MS,
  });
  ixoResolvers.set(indexerUrl, resolver);
  return resolver;
}

export const DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS = 900;
const THREE_MINUTES_MS = 3 * 60 * 1000;
const ORACLE_AUTH_RESOURCE = 'ixo:oracle';
const OracleAuthCapability = defineCapability({ can: '*', protocol: 'ixo:' });

export interface AuthConfig {
  oracleDid: string;
  blocksyncUri: string;
  maxTtlSeconds?: number;
  /**
   * Accept a bare `x-ucan-delegation` (no invocation) as authentication, the
   * legacy fallback. Off unless `UCAN_ALLOW_BARE_DELEGATION_AUTH=true`.
   */
  allowBareDelegation?: boolean;
  revocationStoreUrl?: string;
}

/** The auth config of a deployment, from its raw Worker env (shell and user object alike). */
export function authConfigFromEnv(env: {
  ORACLE_DID: string;
  BLOCKSYNC_GRAPHQL_URL: string;
  UCAN_AUTH_MAX_TTL_SECONDS?: string;
  UCAN_ALLOW_BARE_DELEGATION_AUTH?: string;
  UCAN_STORE_URL?: string;
}): AuthConfig {
  return {
    oracleDid: env.ORACLE_DID,
    blocksyncUri: env.BLOCKSYNC_GRAPHQL_URL,
    ...(env.UCAN_AUTH_MAX_TTL_SECONDS
      ? { maxTtlSeconds: Number(env.UCAN_AUTH_MAX_TTL_SECONDS) }
      : {}),
    allowBareDelegation: env.UCAN_ALLOW_BARE_DELEGATION_AUTH === 'true',
    revocationStoreUrl: env.UCAN_STORE_URL,
  };
}

/** The 401 a bare delegation gets while the fallback is off. */
export const INVOCATION_REQUIRED_ERROR =
  'UCAN invocation required: send Authorization: Bearer <invocation> with X-Auth-Type: ucan. An x-ucan-delegation alone no longer authenticates; send it beside the invocation.';

export interface AuthResult {
  userDid: string;
  /** Raw delegation CAR when the client supplied a valid one for this user. */
  delegation?: string;
  delegationExpiration?: number;
  /** Which artifact authenticated the request. */
  via: 'invocation' | 'delegation';
}

export type AuthOutcome =
  | { ok: true; auth: AuthResult }
  | { ok: false; status: number; error: string };

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Tiny bounded TTL cache — per isolate, lost on eviction (that's fine). */
class TtlCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  constructor(private readonly max = 5000) {}
  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T, ttlMs: number): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

const invocationCache = new TtlCache<{ userDid: string; expiration: number }>();
const delegationCache = new TtlCache<{ userDid: string; expiration: number }>();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type InvocationVerdict =
  | { ok: true; userDid: string; expiration: number }
  | { ok: false; error: string };

/**
 * Verifications in progress, by token hash. Concurrent requests carrying one
 * invocation (a page load firing several queries with the same token) share
 * one verification; the entry is dropped as soon as it settles, so a failure
 * reaches only the callers that were already waiting on it.
 */
const pendingInvocations = new Map<string, Promise<InvocationVerdict>>();

async function validateInvocation(
  invocation: string,
  cfg: AuthConfig,
): Promise<InvocationVerdict> {
  const key = await sha256(
    JSON.stringify({
      token: invocation,
      oracleDid: cfg.oracleDid,
      blocksyncUri: cfg.blocksyncUri,
      maxTtlSeconds: cfg.maxTtlSeconds,
      revocationStoreUrl: cfg.revocationStoreUrl,
    }),
  );
  const cached = invocationCache.get(key);
  if (cached && !cfg.revocationStoreUrl) return { ok: true, ...cached };

  const pending = pendingInvocations.get(key);
  if (pending) return pending;
  const verification = verifyInvocation(invocation, key, cfg).finally(() => {
    pendingInvocations.delete(key);
  });
  pendingInvocations.set(key, verification);
  return verification;
}

async function verifyInvocation(
  invocation: string,
  key: string,
  cfg: AuthConfig,
): Promise<InvocationVerdict> {
  const validator = await createUCANValidator({
    serverDid: cfg.oracleDid,
    rootIssuers: ['*'],
    didResolver: sharedIxoDIDResolver(cfg.blocksyncUri),
    invocationStore: reusableInvocations,
    ...(cfg.revocationStoreUrl
      ? {
          revocationChecker: createUcanStoreRevocationChecker({
            url: cfg.revocationStoreUrl,
            negativeCacheTtlMs: 0,
          }),
        }
      : {}),
  });
  const result = await validator.validate(
    invocation,
    OracleAuthCapability,
    ORACLE_AUTH_RESOURCE,
  );
  if (!result.ok)
    return {
      ok: false,
      error: `[${result.error?.code}] ${result.error?.message}`,
    };
  if (!result.invoker)
    return { ok: false, error: 'Invocation validated without an invoker DID' };
  if (typeof result.expiration !== 'number' || !isFinite(result.expiration)) {
    return { ok: false, error: 'Auth invocation must declare an expiration' };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxTtl = cfg.maxTtlSeconds ?? DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS;
  if (result.expiration > nowSeconds + maxTtl) {
    return {
      ok: false,
      error: `Auth invocation TTL exceeds maximum of ${maxTtl}s`,
    };
  }
  const verdict = { userDid: result.invoker, expiration: result.expiration };
  invocationCache.set(
    key,
    verdict,
    Math.max(1000, (result.expiration - nowSeconds) * 1000),
  );
  return { ok: true, ...verdict };
}

/**
 * Validate a delegation for this oracle: signatures, audience, proof chain,
 * not expired, and a bounded expiry (the earliest across the chain).
 * `userDid` is the delegation's issuer.
 */
export async function validateDelegation(
  header: string,
  cfg: AuthConfig,
): Promise<
  | { ok: true; userDid: string; expiration: number }
  | { ok: false; error: string }
> {
  const key = await sha256(
    JSON.stringify({
      token: header,
      oracleDid: cfg.oracleDid,
      blocksyncUri: cfg.blocksyncUri,
      revocationStoreUrl: cfg.revocationStoreUrl,
    }),
  );
  const cached = delegationCache.get(key);
  if (cached && !cfg.revocationStoreUrl) return { ok: true, ...cached };

  const validator = await createUCANValidator({
    serverDid: cfg.oracleDid,
    rootIssuers: [],
    didResolver: sharedIxoDIDResolver(cfg.blocksyncUri),
    invocationStore: reusableInvocations,
    requireExpiration: true,
    ...(cfg.revocationStoreUrl
      ? {
          revocationChecker: createUcanStoreRevocationChecker({
            url: cfg.revocationStoreUrl,
            negativeCacheTtlMs: 0,
          }),
        }
      : {}),
  });
  const result = await validator.validateDelegation(header);
  if (!result.ok)
    return {
      ok: false,
      error: `[${result.error?.code}] ${result.error?.message}`,
    };
  if (!result.invoker)
    return { ok: false, error: 'Delegation validated without an invoker DID' };
  // The validator refuses an unbounded chain; this also covers a validator
  // that reported success without the effective expiry.
  if (typeof result.expiration !== 'number' || !isFinite(result.expiration)) {
    return { ok: false, error: 'Delegation must declare an expiration' };
  }
  const verdict = { userDid: result.invoker, expiration: result.expiration };
  const ttlMs = Math.max(1000, result.expiration * 1000 - Date.now());
  delegationCache.set(key, verdict, Math.min(ttlMs, THREE_MINUTES_MS));
  return { ok: true, ...verdict };
}

export async function validateCurrentDelegation(
  raw: string,
  principalDid: string,
  cfg: AuthConfig,
): Promise<void> {
  if (!cfg.revocationStoreUrl)
    throw new Error('Current authority requires UCAN_STORE_URL');
  const validator = await createUCANValidator({
    serverDid: cfg.oracleDid,
    rootIssuers: [],
    didResolver: sharedIxoDIDResolver(cfg.blocksyncUri),
    requireExpiration: true,
    revocationChecker: createUcanStoreRevocationChecker({
      url: cfg.revocationStoreUrl,
      negativeCacheTtlMs: 0,
    }),
    revocationFailure: 'closed',
  });
  const result = await validator.validateDelegation(raw);
  if (!result.ok || result.invoker !== principalDid)
    throw new Error(
      'Current delegation is absent, expired, revoked, invalid or belongs to another principal',
    );
}

function extractInvocation(headers: Headers): string | null {
  const authType = headers.get('x-auth-type');
  const authorization = headers.get('authorization');
  if (!authorization || authType?.toLowerCase() !== 'ucan') return null;
  const [scheme, token] = authorization.split(' ', 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/** Authenticate one request. Never throws. */
export async function authenticate(
  headers: Headers,
  cfg: AuthConfig,
): Promise<AuthOutcome> {
  const invocation = extractInvocation(headers);
  const delegationHeader = headers.get('x-ucan-delegation')?.trim() || null;

  if (!invocation && !delegationHeader) {
    return {
      ok: false,
      status: 401,
      error:
        'Missing Authorization (UCAN invocation) or x-ucan-delegation header',
    };
  }
  // A delegation proves what the user granted this oracle, not who is
  // calling; it authenticates only through the opt-in legacy fallback.
  if (!invocation && !cfg.allowBareDelegation) {
    return { ok: false, status: 401, error: INVOCATION_REQUIRED_ERROR };
  }

  let userDid: string | null = null;
  let via: AuthResult['via'] = 'delegation';

  if (invocation) {
    const inv = await validateInvocation(invocation, cfg);
    if (!inv.ok)
      return {
        ok: false,
        status: 401,
        error: `Invalid UCAN invocation: ${inv.error}`,
      };
    userDid = inv.userDid;
    via = 'invocation';
  }

  let delegation: string | undefined;
  let delegationExpiration: number | undefined;
  if (delegationHeader) {
    const del = await validateDelegation(delegationHeader, cfg);
    if (!del.ok) {
      // With a valid invocation the delegation is only authorization material;
      // a bad one is ignored so the caller can still chat. Alone, it's fatal.
      if (!userDid)
        return {
          ok: false,
          status: 401,
          error: `Invalid UCAN delegation: ${del.error}`,
        };
    } else if (userDid && del.userDid !== userDid) {
      // Never pair one user's invocation with another user's delegation.
      if (!invocation) userDid = del.userDid;
    } else {
      userDid ??= del.userDid;
      delegation = delegationHeader;
      delegationExpiration = del.expiration;
    }
  }

  if (!userDid)
    return { ok: false, status: 401, error: 'Unable to authenticate request' };
  return { ok: true, auth: { userDid, delegation, delegationExpiration, via } };
}

/** Normalise a route exclusion into a matcher over (method, path). */
export interface RouteExclusion {
  path: string;
  method?: string;
}

export function isExcluded(
  method: string,
  path: string,
  exclusions: readonly RouteExclusion[],
): boolean {
  const norm = (p: string) => '/' + p.replace(/^\/+/, '').replace(/\/+$/, '');
  const target = norm(path);
  return exclusions.some((ex) => {
    const m = (ex.method ?? 'ALL').toUpperCase();
    if (m !== 'ALL' && m !== method.toUpperCase()) return false;
    const pattern = norm(ex.path);
    if (pattern.endsWith('/*') || pattern.endsWith('/{*path}')) {
      const base = pattern.replace(/\/(\*|\{\*path\})$/, '');
      return target === base || target.startsWith(base + '/');
    }
    // `:param` segments match one path segment.
    const pSeg = pattern.split('/');
    const tSeg = target.split('/');
    if (pSeg.length !== tSeg.length) return false;
    return pSeg.every((s, i) => s.startsWith(':') || s === tSeg[i]);
  });
}
