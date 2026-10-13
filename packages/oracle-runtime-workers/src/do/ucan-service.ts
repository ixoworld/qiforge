/**
 * Oracle-side UCAN helpers — a port of the Node runtime's `UcanService`
 * minting paths (`createInvocationFromDelegation`, `mintSelfSignedInvocation`,
 * `resolveServiceDid`, `getServiceDelegation`) with no NestJS and no
 * process-wide singletons. One instance per user object; caches are
 * per-instance and short-lived.
 *
 * The oracle signs with an Ed25519 mnemonic (`ORACLE_SIGNING_MNEMONIC`, the
 * same material the Node runtime loads from its Matrix account room). Without
 * it every mint returns `{ error }` and `hasSigningKey()` is false — plugins
 * gate their mint-capable tools on that, exactly as on Node.
 */
import {
  createInvocation,
  parseDelegation,
  serializeInvocation,
  signerFromMnemonic,
  type SupportedDID,
} from '@ixo/ucan';
import {
  abilityCovers,
  delegationHasCapability,
  resourceCovers,
} from '../core/runtime-context';
import type { RuntimeContext, UcanDelegation } from '../plugin-api/types';

type MintResult = { invocation: string } | { error: string };
type ServiceDelegationResult =
  | { token: string; with: string }
  | { error: 'no-delegation' | 'store-error'; detail?: string };

export interface UcanServiceOptions {
  oracleDid: string;
  signingMnemonic?: string;
  logger?: { warn(msg: string): void; debug?(msg: string): void };
  /** Longest a did.json or UCAN store request may take (default 10 s). */
  fetchTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function toSupportedDid(did: string): SupportedDID {
  if (did.startsWith('did:ixo:') || did.startsWith('did:key:'))
    return did as SupportedDID;
  throw new Error(`Unsupported oracle DID method: ${did}`);
}

/** One capability of a delegation, as the wire carries it. */
export interface DelegatedCapability {
  can: string;
  with: string;
  nb?: Record<string, unknown>;
}

/**
 * The capabilities a serialized delegation grants, without validating it
 * (the shell validated it when it was deposited; callers that mint from it
 * are checked again by the service that receives the invocation).
 */
export async function listDelegationCapabilities(
  delegationCar: string,
): Promise<DelegatedCapability[]> {
  return (await readDelegation(delegationCar)).capabilities;
}

/** What a serialized delegation grants and the window in which it grants it. */
export interface DelegationGrant {
  capabilities: DelegatedCapability[];
  /** Unix seconds: the earliest expiry along the proof chain; absent = none declared. */
  expiration?: number;
  /** Unix seconds: the latest `nbf` along the proof chain; absent = none declared. */
  notBefore?: number;
}

/** A finite number read off a parsed UCAN field, else undefined. */
function finiteField(node: object, field: 'expiration' | 'notBefore') {
  const value: unknown = Reflect.get(node, field);
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The validity window of a delegation and the proofs it carries, along the
 * first proof at each level — the chain the UCAN validator's effective expiry
 * follows. A proof carried only as a link (not embedded) has no fields to read.
 */
function chainWindow(node: unknown): {
  expiration?: number;
  notBefore?: number;
} {
  if (typeof node !== 'object' || node === null) return {};
  const own = {
    expiration: finiteField(node, 'expiration'),
    notBefore: finiteField(node, 'notBefore'),
  };
  const proofs: unknown = Reflect.get(node, 'proofs');
  const parent = Array.isArray(proofs) ? chainWindow(proofs[0]) : {};
  const pick = (
    a: number | undefined,
    b: number | undefined,
    f: (x: number, y: number) => number,
  ) => (a === undefined ? b : b === undefined ? a : f(a, b));
  const expiration = pick(own.expiration, parent.expiration, Math.min);
  const notBefore = pick(own.notBefore, parent.notBefore, Math.max);
  return {
    ...(expiration !== undefined ? { expiration } : {}),
    ...(notBefore !== undefined ? { notBefore } : {}),
  };
}

/** Parse a serialized delegation into its grant (no signature checks). */
export async function readDelegation(
  delegationCar: string,
): Promise<DelegationGrant> {
  const delegation = await parseDelegation(delegationCar);
  return {
    capabilities: delegation.capabilities.map((c) => ({
      can: c.can,
      with: c.with,
      ...(c.nb !== undefined && c.nb !== null
        ? { nb: c.nb as Record<string, unknown> }
        : {}),
    })),
    ...chainWindow(delegation),
  };
}

/**
 * The delegation a turn runs under: the one the request carried, else the
 * user's stored one (a Matrix turn carries none), with the capabilities it
 * grants (`withCapabilities`). Every capability check of the turn reads it:
 * `requires`, admin-plane tools, the plugins' own mints. Without a UCAN
 * service it carries no capabilities and grants nothing.
 */
export async function resolveTurnDelegation(
  requestDelegation: string | undefined,
  storedDelegation: string | undefined,
  ucan: Pick<WorkersUcanService, 'withCapabilities'> | null,
): Promise<UcanDelegation> {
  const raw = requestDelegation ?? storedDelegation ?? '';
  return ucan ? ucan.withCapabilities(raw) : { raw };
}

/** Upper bound on a delegated invocation's lifetime (mirrors the Node runtime). */
const MAX_INVOCATION_TTL_SECONDS = 60 * 60;
/** Parsed capability lists kept per raw delegation (the owner store asks per request). */
const DELEGATION_CAPABILITIES_CACHE_SIZE = 8;

export class WorkersUcanService {
  private readonly serviceDidCache = new Map<
    string,
    { did: string; expiresAt: number }
  >();
  private readonly storeDelegationCache = new Map<
    string,
    { value: { token: string; with: string }; expiresAt: number }
  >();
  /**
   * Store look-ups in progress, keyed like `storeDelegationCache`: callers
   * that miss the cache at the same moment share one fetch. Dropped when it
   * settles, so a failed look-up is retried by the next call.
   */
  private readonly storeDelegationInFlight = new Map<
    string,
    Promise<ServiceDelegationResult>
  >();
  /** Parsed grants per raw delegation; the validity window is checked at use, never cached away. */
  private readonly grantCache = new Map<string, DelegationGrant>();

  constructor(private readonly opts: UcanServiceOptions) {}

  /**
   * A raw delegation with the capabilities it grants, the shape
   * `ctx.ucan.hasCapability` and plugin `requires` read. A token that cannot
   * be parsed grants nothing, and neither does one outside its validity
   * window right now: expired, or not yet valid (`nbf`). The window is
   * compared with the clock on every call — the parse is cached, the
   * verdict is not — and the result carries `expiration`, so a delegation
   * that lapses during the turn stops granting at that moment too. The
   * stored delegation a Matrix turn runs under was validated only when it
   * was deposited; this is what ends it.
   */
  async withCapabilities(raw: string): Promise<UcanDelegation> {
    if (!raw) return { raw };
    let grant: DelegationGrant;
    try {
      grant = await this.delegationGrant(raw);
    } catch (err) {
      this.opts.logger?.warn(
        `[UCAN] cannot read a delegation's capabilities: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { raw, capabilities: [] };
    }
    const nowSeconds = Date.now() / 1000;
    const lapsed =
      grant.expiration !== undefined && grant.expiration <= nowSeconds;
    const early = grant.notBefore !== undefined && grant.notBefore > nowSeconds;
    if (lapsed || early) {
      this.opts.logger?.warn(
        lapsed
          ? `[UCAN] the delegation expired at ${new Date((grant.expiration ?? 0) * 1000).toISOString()}; it grants nothing`
          : `[UCAN] the delegation is not valid before ${new Date((grant.notBefore ?? 0) * 1000).toISOString()}; it grants nothing yet`,
      );
      return {
        raw,
        capabilities: [],
        ...(grant.expiration !== undefined
          ? { expiration: grant.expiration }
          : {}),
      };
    }
    return {
      raw,
      capabilities: grant.capabilities.map((c) => ({
        resource: c.with,
        action: c.can,
      })),
      ...(grant.expiration !== undefined
        ? { expiration: grant.expiration }
        : {}),
    };
  }

  hasSigningKey(): boolean {
    return Boolean(this.opts.signingMnemonic);
  }

  /**
   * `listDelegationCapabilities`, memoised on the raw token. No validity
   * window: the owner store picks the grant to mint from with it, and the
   * mint refuses an expired delegation itself.
   */
  async delegationCapabilities(
    delegationCar: string,
  ): Promise<DelegatedCapability[]> {
    return (await this.delegationGrant(delegationCar)).capabilities;
  }

  /** `readDelegation`, memoised on the raw token. */
  private async delegationGrant(
    delegationCar: string,
  ): Promise<DelegationGrant> {
    const cached = this.grantCache.get(delegationCar);
    if (cached) return cached;
    const grant = await readDelegation(delegationCar);
    if (this.grantCache.size >= DELEGATION_CAPABILITIES_CACHE_SIZE) {
      const oldest = this.grantCache.keys().next().value;
      if (oldest !== undefined) this.grantCache.delete(oldest);
    }
    this.grantCache.set(delegationCar, grant);
    return grant;
  }

  /** Bounds one outbound request (headers and body). */
  private fetchSignal(): AbortSignal {
    return AbortSignal.timeout(
      this.opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );
  }

  async resolveServiceDid(serviceUrl: string): Promise<string | null> {
    try {
      const origin = new URL(serviceUrl).origin;
      const cached = this.serviceDidCache.get(origin);
      if (cached && cached.expiresAt > Date.now()) return cached.did;
      const res = await fetch(`${origin}/.well-known/did.json`, {
        signal: this.fetchSignal(),
      });
      if (!res.ok) {
        this.opts.logger?.warn(`[UCAN] did.json ${origin}: HTTP ${res.status}`);
        return null;
      }
      const doc: { id?: string } = await res.json<{ id?: string }>();
      if (!doc.id) return null;
      this.serviceDidCache.set(origin, {
        did: doc.id,
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      return doc.id;
    } catch (error) {
      this.opts.logger?.warn(
        `[UCAN] resolveServiceDid ${serviceUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async createInvocationFromDelegation(
    delegationCar: string,
    serviceUrlOrDid: string,
    capability: { can: string; with: string; nb?: Record<string, unknown> },
    options: { maxTtlSeconds?: number } = {},
  ): Promise<MintResult> {
    if (!this.opts.signingMnemonic)
      return {
        error:
          'Oracle has no signing key configured — set ORACLE_SIGNING_MNEMONIC',
      };
    if (!delegationCar)
      return { error: 'delegationCar (base64 CAR) is required' };
    // Plugins that already resolved the service DID (memory, composio) pass
    // the DID itself — mint straight to it, as the Node runtime's
    // `mintInvocationForServiceDid` does. A DID is not a fetchable URL:
    // `new URL('did:web:x').origin` is "null", so routing it through
    // `resolveServiceDid` can never succeed.
    const serviceDid = serviceUrlOrDid.startsWith('did:')
      ? serviceUrlOrDid
      : await this.resolveServiceDid(serviceUrlOrDid);
    if (!serviceDid)
      return {
        error: `Could not resolve worker DID via ${serviceUrlOrDid}/.well-known/did.json`,
      };
    try {
      const { signer } = await signerFromMnemonic(
        this.opts.signingMnemonic,
        toSupportedDid(this.opts.oracleDid),
      );
      let delegation: Awaited<ReturnType<typeof parseDelegation>>;
      try {
        delegation = await parseDelegation(delegationCar);
      } catch (err) {
        return {
          error: `Could not parse delegation CAR: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const audience = delegation.audience?.did?.();
      if (audience && audience !== this.opts.oracleDid) {
        return {
          error: `Delegation audience (${audience}) does not match this oracle DID (${this.opts.oracleDid})`,
        };
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Same lifetime rule as the Node runtime (`MAX_INVOCATION_TTL_SECONDS`):
      // an invocation lives up to an hour, capped by the delegation. An MCP
      // session minted at turn start keeps re-using its bearer for the whole
      // turn, so a 60 s token expired under long tool calls.
      let expiration =
        nowSeconds + (options.maxTtlSeconds ?? MAX_INVOCATION_TTL_SECONDS);
      const delegationExp =
        typeof delegation.expiration === 'number' &&
        isFinite(delegation.expiration)
          ? delegation.expiration
          : null;
      if (delegationExp !== null) {
        if (delegationExp <= nowSeconds)
          return {
            error: `Delegation expired at ${new Date(delegationExp * 1000).toISOString()}`,
          };
        expiration = Math.min(expiration, delegationExp);
      }
      const invocation = await createInvocation({
        issuer: signer,
        audience: serviceDid,
        capability: {
          can: capability.can as `${string}/${string}`,
          with: capability.with as `${string}:${string}`,
          // Caveats (e.g. the VFS `nb.hidden` reveal set) pass through
          // verbatim; services intersect them across the proof chain.
          ...(capability.nb !== undefined ? { nb: capability.nb } : {}),
        },
        proofs: [delegation],
        expiration,
        facts: [{ nonce: crypto.randomUUID() }],
      });
      return { invocation: await serializeInvocation(invocation) };
    } catch (error) {
      return {
        error: `Failed to mint invocation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async mintSelfSignedInvocation(
    serviceUrl: string,
    capability: { can: string; with: string },
    options: { maxTtlSeconds?: number } = {},
  ): Promise<MintResult> {
    if (!this.opts.signingMnemonic)
      return {
        error:
          'Oracle has no signing key configured — set ORACLE_SIGNING_MNEMONIC',
      };
    const serviceDid = await this.resolveServiceDid(serviceUrl);
    if (!serviceDid)
      return {
        error: `Could not resolve worker DID via ${serviceUrl}/.well-known/did.json`,
      };
    try {
      const { signer } = await signerFromMnemonic(
        this.opts.signingMnemonic,
        toSupportedDid(this.opts.oracleDid),
      );
      const nowSeconds = Math.floor(Date.now() / 1000);
      const invocation = await createInvocation({
        issuer: signer,
        audience: serviceDid,
        capability: {
          can: capability.can as `${string}/${string}`,
          with: capability.with as `${string}:${string}`,
        },
        proofs: [],
        expiration: nowSeconds + (options.maxTtlSeconds ?? 120),
        facts: [{ nonce: crypto.randomUUID() }],
      });
      return { invocation: await serializeInvocation(invocation) };
    } catch (error) {
      return {
        error: `Failed to mint invocation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async getServiceDelegation(
    userDid: string,
    opts: { storeUrl: string; resource: string; requiredAbility: string },
  ): Promise<ServiceDelegationResult> {
    const cacheKey = `${userDid}:${opts.resource}:${opts.requiredAbility}`;
    const cached = this.storeDelegationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.storeDelegationInFlight.get(cacheKey);
    if (pending) return pending;
    const lookup = this.fetchServiceDelegation(userDid, opts, cacheKey).finally(
      () => {
        if (this.storeDelegationInFlight.get(cacheKey) === lookup)
          this.storeDelegationInFlight.delete(cacheKey);
      },
    );
    this.storeDelegationInFlight.set(cacheKey, lookup);
    return lookup;
  }

  private async fetchServiceDelegation(
    userDid: string,
    opts: { storeUrl: string; resource: string; requiredAbility: string },
    cacheKey: string,
  ): Promise<ServiceDelegationResult> {
    const inv = await this.mintSelfSignedInvocation(
      opts.storeUrl,
      { can: 'store/get', with: 'ixo:ucan-store' },
      { maxTtlSeconds: 120 },
    );
    if ('error' in inv) return { error: 'store-error', detail: inv.error };

    interface StoreDelegation {
      token: string;
      capabilities: Array<{ can: string; with: string }>;
      expiresAt: number | null;
      lifecycleState: string;
    }
    let res: Response;
    try {
      res = await fetch(
        `${opts.storeUrl}/api/delegations?rootIssuer=${encodeURIComponent(userDid)}`,
        {
          headers: {
            authorization: `Bearer ${inv.invocation}`,
            'x-auth-type': 'ucan',
          },
          // Every caller waiting on this look-up waits on this request.
          signal: this.fetchSignal(),
        },
      );
    } catch (error) {
      return {
        error: 'store-error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!res.ok)
      return res.status === 404
        ? { error: 'no-delegation' }
        : { error: 'store-error', detail: `store ${res.status}` };
    let body: { delegations?: StoreDelegation[] };
    try {
      body = await res.json();
    } catch (error) {
      return {
        error: 'store-error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const row of body.delegations ?? []) {
      if (row.lifecycleState !== 'active') continue;
      if (row.expiresAt != null && row.expiresAt <= nowSeconds) continue;
      // The stored grant must cover what was asked for: the same resource
      // or a parent of it (never a sibling sharing a prefix, never a
      // narrower grant standing in for the broader resource), with an
      // ability that covers the required one.
      const match = (row.capabilities ?? []).find(
        (c) =>
          resourceCovers(c.with, opts.resource) &&
          abilityCovers(c.can, opts.requiredAbility),
      );
      if (!match) continue;
      const value = { token: row.token, with: match.with };
      const ttl =
        row.expiresAt != null ? Math.min(row.expiresAt - nowSeconds, 600) : 600;
      if (ttl > 0)
        this.storeDelegationCache.set(cacheKey, {
          value,
          expiresAt: Date.now() + ttl * 1000,
        });
      return value;
    }
    return { error: 'no-delegation' };
  }

  /**
   * Build the `ctx.ucan` surface for one turn. `delegation` is the user's
   * delegation for this oracle (from the request header or the room state) —
   * `mintInvocation` proves through it; capability checks read it.
   */
  forTurn(
    userDid: string,
    delegation: UcanDelegation | undefined,
  ): RuntimeContext['ucan'] {
    const has = (resource: string, action: string) =>
      delegationHasCapability(delegation, resource, action);
    return {
      hasCapability: has,
      requireCapability: (resource, action) => {
        if (!has(resource, action))
          throw new Error(`Missing UCAN capability ${action} on ${resource}`);
      },
      hasSigningKey: () => this.hasSigningKey(),
      resolveServiceDid: (url) => this.resolveServiceDid(url),
      mintInvocation: async (target, opts) => {
        if (!delegation?.raw)
          throw new Error(
            `No delegation from ${userDid} available to mint an invocation from`,
          );
        const [can] = [opts?.can ?? '*'];
        const minted = await this.createInvocationFromDelegation(
          delegation.raw,
          target.did,
          {
            can,
            with: target.capability,
          },
        );
        if ('error' in minted) throw new Error(minted.error);
        return minted.invocation;
      },
      createInvocationFromDelegation: (car, url, cap, o) =>
        this.createInvocationFromDelegation(car, url, cap, o),
      mintSelfSignedInvocation: (url, cap, o) =>
        this.mintSelfSignedInvocation(url, cap, o),
      getServiceDelegation: (did, o) => this.getServiceDelegation(did, o),
    };
  }
}
