/**
 * UCAN authentication for the Workers shell — a port of the Node runtime's
 * `AuthHeaderMiddleware` (`modules/auth/*`), same headers, same semantics:
 *
 *  - Primary:  `Authorization: Bearer <invocation>` + `X-Auth-Type: ucan` — a
 *    user-self-signed root invocation for `{ can: '*', with: 'ixo:oracle' }`
 *    addressed to this oracle's DID. Proves WHO is calling; short TTL.
 *  - Fallback: `x-ucan-delegation: <base64 CAR>` — accepted alone for legacy
 *    clients and always used for downstream authorization when present. A
 *    delegation is only trusted when its issuer equals the authenticated DID.
 *
 * The returned `userDid` is always the cryptographically recovered signer,
 * never a client-claimed value. `did:ixo` keys resolve through Blocksync.
 * Verdicts are cached per isolate keyed by a hash of the token, bounded by
 * the token's own expiry.
 */
import {
  createIxoDIDResolver,
  createUCANValidator,
  defineCapability,
  InMemoryInvocationStore,
} from '@ixo/ucan';

/**
 * One replay-protection store per isolate, WITHOUT the library's hourly
 * `setInterval` sweep: a pending timer keeps a Durable Object resident, and
 * this code also runs inside the user object (socket CONNECT auth), where a
 * leaked interval per CONNECT blocked WebSocket hibernation entirely. Expired
 * entries are dropped lazily on lookup and swept every N validations instead.
 */
const invocationStore = new InMemoryInvocationStore({
  enableAutoCleanup: false,
});
const SWEEP_EVERY = 500;
let validations = 0;

function sweepInvocationStore(): void {
  validations += 1;
  if (validations % SWEEP_EVERY === 0) void invocationStore.cleanup();
}

export const DEFAULT_UCAN_AUTH_MAX_TTL_SECONDS = 900;
const THREE_MINUTES_MS = 3 * 60 * 1000;
const ORACLE_AUTH_RESOURCE = 'ixo:oracle';
const OracleAuthCapability = defineCapability({ can: '*', protocol: 'ixo:' });

export interface AuthConfig {
  oracleDid: string;
  blocksyncUri: string;
  maxTtlSeconds?: number;
}

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
const delegationCache = new TtlCache<{
  userDid: string;
  expiration?: number;
}>();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function validateInvocation(
  invocation: string,
  cfg: AuthConfig,
): Promise<
  | { ok: true; userDid: string; expiration: number }
  | { ok: false; error: string }
> {
  const key = await sha256(invocation);
  const cached = invocationCache.get(key);
  if (cached) return { ok: true, ...cached };

  sweepInvocationStore();
  const validator = await createUCANValidator({
    serverDid: cfg.oracleDid,
    rootIssuers: ['*'],
    didResolver: createIxoDIDResolver({ indexerUrl: cfg.blocksyncUri }),
    invocationStore,
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

async function validateDelegation(
  header: string,
  cfg: AuthConfig,
): Promise<
  | { ok: true; userDid: string; expiration?: number }
  | { ok: false; error: string }
> {
  const key = await sha256(header);
  const cached = delegationCache.get(key);
  if (cached) return { ok: true, ...cached };

  sweepInvocationStore();
  const validator = await createUCANValidator({
    serverDid: cfg.oracleDid,
    rootIssuers: [],
    didResolver: createIxoDIDResolver({ indexerUrl: cfg.blocksyncUri }),
    invocationStore,
  });
  const result = await validator.validateDelegation(header);
  if (!result.ok)
    return {
      ok: false,
      error: `[${result.error?.code}] ${result.error?.message}`,
    };
  if (!result.invoker)
    return { ok: false, error: 'Delegation validated without an invoker DID' };
  const verdict = { userDid: result.invoker, expiration: result.expiration };
  const ttlMs =
    typeof result.expiration === 'number'
      ? Math.max(1000, result.expiration * 1000 - Date.now())
      : THREE_MINUTES_MS;
  delegationCache.set(key, verdict, Math.min(ttlMs, THREE_MINUTES_MS));
  return { ok: true, ...verdict };
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
