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
import type { RuntimeContext, UcanDelegation } from '../plugin-api/types';

type MintResult = { invocation: string } | { error: string };
type ServiceDelegationResult =
  | { token: string; with: string }
  | { error: 'no-delegation' | 'store-error'; detail?: string };

export interface UcanServiceOptions {
  oracleDid: string;
  signingMnemonic?: string;
  logger?: { warn(msg: string): void; debug?(msg: string): void };
}

function toSupportedDid(did: string): SupportedDID {
  if (did.startsWith('did:ixo:') || did.startsWith('did:key:'))
    return did as SupportedDID;
  throw new Error(`Unsupported oracle DID method: ${did}`);
}

function abilityCovers(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith('/*')) {
    const ns = granted.slice(0, -2);
    return required === ns || required.startsWith(`${ns}/`);
  }
  return false;
}

/** Upper bound on a delegated invocation's lifetime (mirrors the Node runtime). */
const MAX_INVOCATION_TTL_SECONDS = 60 * 60;

export class WorkersUcanService {
  private readonly serviceDidCache = new Map<
    string,
    { did: string; expiresAt: number }
  >();
  private readonly storeDelegationCache = new Map<
    string,
    { value: { token: string; with: string }; expiresAt: number }
  >();

  constructor(private readonly opts: UcanServiceOptions) {}

  hasSigningKey(): boolean {
    return Boolean(this.opts.signingMnemonic);
  }

  async resolveServiceDid(serviceUrl: string): Promise<string | null> {
    try {
      const origin = new URL(serviceUrl).origin;
      const cached = this.serviceDidCache.get(origin);
      if (cached && cached.expiresAt > Date.now()) return cached.did;
      const res = await fetch(`${origin}/.well-known/did.json`);
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
      const match = (row.capabilities ?? []).find(
        (c) =>
          (c.with === opts.resource || c.with.startsWith(opts.resource)) &&
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
    const caps = delegation?.capabilities ?? [];
    const has = (resource: string, action: string) =>
      caps.some(
        (c) =>
          (c.resource === resource || c.resource.startsWith(resource)) &&
          abilityCovers(c.action, action),
      );
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
