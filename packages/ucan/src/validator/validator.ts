/* eslint-disable no-console */
/**
 * @fileoverview Framework-agnostic UCAN validator
 *
 * This module provides a simple validator that can be used in any
 * server framework (Express, Fastify, Hono, raw Node HTTP, etc.)
 * to validate UCAN invocations.
 *
 * Uses ucanto's battle-tested validation under the hood.
 *
 * Supports any DID method (did:key, did:ixo, did:web, etc.) for the server identity.
 * Non-did:key DIDs are resolved at startup using the provided didResolver.
 */

import { ed25519 } from '@ucanto/principal';
import { Delegation, UCAN } from '@ucanto/core';
import { claim } from '@ucanto/validator';
import { type capability } from '@ucanto/validator';
import type { Delegation as UcantoDelegation } from '@ucanto/interface';
import type {
  DIDKeyResolver,
  InvocationStore,
  RevocationChecker,
} from '../types.js';
import { InMemoryInvocationStore } from '../store/memory.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CapabilityParser = ReturnType<typeof capability<any, any, any>>;

type Verifier = ReturnType<typeof ed25519.Verifier.parse>;

/**
 * Extra lifetime of a replay mark beyond the token's own expiry. ucanto
 * refuses an invocation from its expiry second on; the margin covers clock
 * adjustments between the mark and that check.
 */
const REPLAY_MARK_MARGIN_MS = 60_000;

/**
 * Lifetime of the replay mark for an invocation: until the invocation itself
 * expires (it is refused afterwards), or undefined — the store's default —
 * for an invocation without expiry.
 */
function replayMarkTtlMs(expiration: unknown): number | undefined {
  if (typeof expiration !== 'number' || !Number.isFinite(expiration)) {
    return undefined;
  }
  return Math.max(0, expiration * 1000 - Date.now()) + REPLAY_MARK_MARGIN_MS;
}

/**
 * CIDs currently being validated, per store, for stores without an atomic
 * `addIfAbsent()`. The check-and-insert on this set is synchronous, so two
 * validations of one invocation that share a store object (also through two
 * validator instances) cannot both pass the replay check while the first is
 * still verifying.
 */
const pendingReplayMarks = new WeakMap<InvocationStore, Set<string>>();

interface ReplayReservation {
  /** Make the mark permanent (for its TTL) after a successful validation. */
  commit(): Promise<void>;
  /** Drop the mark after a failed validation, so the token stays usable. */
  release(): Promise<void>;
}

/**
 * Reserve an invocation CID before verification. Resolves null when the CID
 * is already used or being validated.
 */
async function reserveInvocation(
  store: InvocationStore,
  cid: string,
  ttlMs: number | undefined,
): Promise<ReplayReservation | null> {
  if (store.addIfAbsent) {
    if (!(await store.addIfAbsent(cid, ttlMs))) return null;
    return {
      commit: async () => {},
      release: async () => {
        await store.delete?.(cid);
      },
    };
  }

  let pending = pendingReplayMarks.get(store);
  if (!pending) {
    pending = new Set();
    pendingReplayMarks.set(store, pending);
  }
  if (pending.has(cid)) return null;
  pending.add(cid);
  const pendingSet = pending;
  try {
    if (await store.has(cid)) {
      pendingSet.delete(cid);
      return null;
    }
  } catch (err) {
    pendingSet.delete(cid);
    throw err;
  }
  return {
    commit: async () => {
      try {
        await store.add(cid, ttlMs);
      } finally {
        pendingSet.delete(cid);
      }
    },
    release: async () => {
      pendingSet.delete(cid);
    },
  };
}

/**
 * True when `resource` names `issuer` exactly or as a whole segment: the DID
 * starts the URI or follows `:` or `/`, and ends it or is followed by `/`.
 * A DID that is only a prefix of the named DID (`did:web:victim.co` inside
 * `…/did:web:victim.com`) does not match.
 */
function resourceNamesIssuer(resource: string, issuer: string): boolean {
  if (!issuer) return false;
  if (resource === issuer) return true;
  let from = 0;
  for (;;) {
    const at = resource.indexOf(issuer, from);
    if (at === -1) return false;
    const before = at === 0 ? undefined : resource[at - 1];
    const after = resource[at + issuer.length];
    if (
      (before === undefined || before === ':' || before === '/') &&
      (after === undefined || after === '/')
    ) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * True when `key` is a did:key that parses as an Ed25519 verifier — the only
 * key type this validator (and ucanto's `ed25519.Verifier`) can verify with.
 */
function isEd25519DidKey(key: string): boolean {
  try {
    ed25519.Verifier.parse(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Earliest finite expiration and latest not-before over a delegation tree,
 * visiting EVERY proof (not just the first). `delegationOf` maps a tree node
 * to the delegation that carries the timestamps: the node itself for a raw
 * delegation, `node.delegation` for a ucanto Authorization.
 */
function chainTimeBounds(
  root: unknown,
  delegationOf: (node: object) => unknown,
): { expiration?: number; notBefore?: number } {
  let expiration: number | undefined;
  let notBefore: number | undefined;
  const seen = new Set<object>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const delegation = delegationOf(node);
    if (delegation && typeof delegation === 'object') {
      if (
        'expiration' in delegation &&
        typeof delegation.expiration === 'number' &&
        Number.isFinite(delegation.expiration)
      ) {
        expiration =
          expiration === undefined
            ? delegation.expiration
            : Math.min(expiration, delegation.expiration);
      }
      if (
        'notBefore' in delegation &&
        typeof delegation.notBefore === 'number' &&
        Number.isFinite(delegation.notBefore)
      ) {
        notBefore =
          notBefore === undefined
            ? delegation.notBefore
            : Math.max(notBefore, delegation.notBefore);
      }
    }
    if ('proofs' in node && Array.isArray(node.proofs)) {
      for (const proof of node.proofs) visit(proof);
    }
  };

  visit(root);
  return { expiration, notBefore };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical CID string of a proof-chain node.
 *
 * A node is normally a materialized Delegation (its block travelled inside the
 * CAR), which carries `.cid`. It may instead be a bare CID Link when the block
 * was not embedded — a Link is self-describing (it carries a multihash) and
 * stringifies to the same canonical CID. Both identify a revocable delegation,
 * so both are collected.
 */
function nodeCid(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  if ('cid' in node && node.cid) return String(node.cid);
  if ('multihash' in node) return String(node);
  return undefined;
}

/**
 * Options for creating a UCAN validator
 */
export interface CreateValidatorOptions {
  /**
   * The server's DID (audience for invocations)
   * Invocations must be addressed to this DID.
   *
   * Supports any DID method:
   * - did:key:z6Mk... (parsed directly)
   * - did:ixo:ixo1... (resolved using didResolver at startup)
   * - did:web:example.com (resolved using didResolver at startup)
   */
  serverDid: string;

  /**
   * DIDs that are allowed to be root issuers
   * These DIDs can self-issue capabilities without needing a delegation chain
   */
  rootIssuers: string[];

  /**
   * DID resolver for non-did:key DIDs.
   * Required if serverDid or any issuer uses a non-did:key method.
   *
   * The resolver should return the did:key(s) associated with the DID.
   */
  didResolver?: DIDKeyResolver;

  /**
   * Optional invocation store for replay protection
   * If not provided, an in-memory store is used. A store that implements
   * `addIfAbsent()` (and `delete()`) gets race-free marks, also across
   * instances that share it; see InvocationStore.
   */
  invocationStore?: InvocationStore;

  /**
   * Optional revocation checker. When provided, the canonical CIDs of the
   * invocation and of every delegation in the cryptographically verified
   * proof chain are checked in ONE batched call after chain verification;
   * any revoked CID fails validation with code 'REVOKED'.
   *
   * If not provided, no revocation checking is performed (previous behavior).
   */
  revocationChecker?: RevocationChecker;

  /**
   * What to do when the revocation checker itself fails (network error,
   * timeout, malformed response):
   * - 'closed' (default): reject with code 'REVOCATION_CHECK_FAILED' —
   *   an unverifiable revocation status is treated as unsafe.
   * - 'open': allow the request through (availability over strictness).
   */
  revocationFailure?: 'open' | 'closed';

  /**
   * When true, reject tokens whose effective expiration is unbounded (no
   * expiration anywhere in the chain). Off by default for backward
   * compatibility, but recommended in production: a never-expiring token can
   * only ever be neutralized by a revocation record that must then be kept
   * forever.
   */
  requireExpiration?: boolean;
}

/**
 * Result of validating an invocation
 */
export interface ValidateResult {
  /** Whether validation succeeded */
  ok: boolean;

  /** The invoker's DID (if valid) */
  invoker?: string;

  /** The validated capability (if valid) */
  capability?: {
    can: string;
    with: string;
    nb?: Record<string, unknown>;
  };

  /**
   * Effective expiration as Unix timestamp (seconds).
   * This is the earliest expiration across the entire delegation chain,
   * i.e. when the authorization effectively expires.
   * Undefined if no expiration is set (never expires).
   */
  expiration?: number;

  /**
   * The delegation chain from root issuer to invoker.
   * e.g. ["did:key:root", "did:key:alice", "did:key:bob"]
   * For a direct root invocation (no delegation), this is just ["did:key:root"].
   */
  proofChain?: string[];

  /**
   * Canonical CIDs of the verified chain, parents first. For validate() the
   * last entry is the invocation's own CID; for validateDelegation() it is
   * the delegation's. These are the identifiers a revocation targets.
   */
  proofChainCids?: string[];

  /**
   * Facts attached to the invocation (UCAN spec §3.2.4).
   * Verifiable claims and proofs of knowledge supporting the invocation.
   * Empty array if no facts were attached.
   */
  facts?: Record<string, unknown>[];

  /** Error details (if invalid) */
  error?: {
    code:
      | 'INVALID_FORMAT'
      | 'INVALID_SIGNATURE'
      | 'UNAUTHORIZED'
      | 'REPLAY'
      | 'EXPIRED'
      | 'CAVEAT_VIOLATION'
      | 'REVOKED'
      | 'REVOCATION_CHECK_FAILED';
    message: string;
  };
}

/**
 * A framework-agnostic UCAN validator
 */
export interface UCANValidator {
  /**
   * Validate an invocation against a capability definition
   *
   * @param invocationBase64 - Base64-encoded CAR containing the invocation
   * @param capabilityDef - Capability definition from defineCapability()
   * @param resource - The specific resource URI to validate against
   * @returns Validation result
   *
   * @example
   * ```typescript
   * const result = await validator.validate(
   *   invocationBase64,
   *   EmployeesRead,
   *   'myapp:company/acme'
   * );
   * ```
   */
  validate(
    invocationBase64: string,
    capabilityDef: CapabilityParser,
    resource: string,
  ): Promise<ValidateResult>;

  /**
   * Validate a delegation (verify signatures, audience, expiration, and proof chain)
   *
   * Unlike `validate()` which validates invocations against a capability definition,
   * this method validates a standalone delegation token — verifying the cryptographic
   * signature chain, checking audience matches this server, and validating expiration.
   *
   * @param delegationBase64 - Base64-encoded CAR containing the delegation
   * @returns Validation result
   *
   * @example
   * ```typescript
   * const result = await validator.validateDelegation(delegationBase64);
   * if (result.ok) {
   *   console.log('Delegation from:', result.invoker);
   *   console.log('Capabilities:', result.capability);
   * }
   * ```
   */
  validateDelegation(delegationBase64: string): Promise<ValidateResult>;

  /**
   * The server's public DID (as provided in options)
   */
  readonly serverDid: string;
}

/**
 * Create a UCAN validator (async to support DID resolution at startup)
 *
 * @param options - Validator configuration
 * @returns A validator instance
 *
 * @example
 * ```typescript
 * import { createUCANValidator, defineCapability, Schema, createIxoDIDResolver } from '@ixo/ucan';
 *
 * // Define capability
 * const EmployeesRead = defineCapability({
 *   can: 'employees/read',
 *   protocol: 'myapp:',
 *   nb: { limit: Schema.integer().optional() },
 *   derives: (claimed, delegated) => {
 *     const claimedLimit = claimed.nb?.limit ?? Infinity;
 *     const delegatedLimit = delegated.nb?.limit ?? Infinity;
 *     if (claimedLimit > delegatedLimit) {
 *       return { error: new Error(`Limit exceeds delegated`) };
 *     }
 *     return { ok: {} };
 *   }
 * });
 *
 * // Create validator with did:ixo server identity
 * const validator = await createUCANValidator({
 *   serverDid: 'did:ixo:ixo1abc...',  // Any DID method supported
 *   rootIssuers: ['did:ixo:ixo1admin...'],
 *   didResolver: createIxoDIDResolver({ indexerUrl: '...' }),
 * });
 *
 * // Validate invocations
 * const result = await validator.validate(invocationBase64, EmployeesRead, 'myapp:server');
 * ```
 */
export async function createUCANValidator(
  options: CreateValidatorOptions,
): Promise<UCANValidator> {
  const invocationStore =
    options.invocationStore ?? new InMemoryInvocationStore();

  // Lazily resolve server DID to a Verifier.
  // Only needed for validate() (invocations), NOT for validateDelegation().
  // This avoids requiring Ed25519 keys on the server DID doc when only
  // delegation validation is needed.
  let serverVerifier: Verifier | undefined;

  async function getServerVerifier(): Promise<Verifier> {
    if (serverVerifier) return serverVerifier;

    if (options.serverDid.startsWith('did:key:')) {
      serverVerifier = ed25519.Verifier.parse(options.serverDid);
      return serverVerifier;
    }

    if (!options.didResolver) {
      throw new Error(
        `Cannot use ${options.serverDid} as server DID without a didResolver. ` +
          `Provide a didResolver to resolve non-did:key DIDs, or use a did:key directly.`,
      );
    }

    const resolved = await options.didResolver(
      options.serverDid as `did:${string}:${string}`,
    );

    if ('error' in resolved) {
      throw new Error(
        `Failed to resolve server DID ${options.serverDid}: ${resolved.error.message}`,
      );
    }

    if (!resolved.ok || resolved.ok.length === 0) {
      throw new Error(
        `No keys found for server DID ${options.serverDid}. ` +
          `The DID document must have at least one verification method.`,
      );
    }

    // DID docs may publish multiple Ed25519 verification methods; pick the
    // first one that parses as a valid Ed25519 verifier.
    let parseError: unknown;
    for (const keyDid of resolved.ok) {
      try {
        serverVerifier = ed25519.Verifier.parse(keyDid);
        return serverVerifier;
      } catch (err) {
        parseError = err;
      }
    }

    throw new Error(
      `No valid Ed25519 key found for server DID ${options.serverDid}` +
        (parseError instanceof Error ? `: ${parseError.message}` : ''),
    );
  }

  // Create DID resolver for use during validation (for issuers in delegation chain)
  const resolveDIDKey = async (did: `did:${string}:${string}`) => {
    // Defensive: ensure did is a string
    if (typeof did !== 'string') {
      console.error('[resolveDIDKey] ERROR: did is not a string!', did);
      return {
        error: {
          name: 'DIDKeyResolutionError' as const,
          did: String(did),
          message: `Expected DID string, got ${typeof did}`,
        },
      };
    }

    // did:key resolves to itself - return as array of DID strings (ucanto iterates over result.ok)
    if (did.startsWith('did:key:')) {
      return { ok: [did] };
    }

    // Try custom resolver for other DID methods (e.g., did:ixo)
    if (options.didResolver) {
      const result = await options.didResolver(did);
      if ('ok' in result && result.ok.length > 0) {
        // Keep only keys ed25519.Verifier can parse. ucanto parses every
        // returned key outside a try, so one non-Ed25519 or malformed key
        // listed before the real one would otherwise fail the whole
        // validation instead of being skipped.
        const usable = result.ok.filter(isEd25519DidKey);
        if (usable.length > 0) return { ok: usable };
        return {
          error: {
            name: 'DIDKeyResolutionError' as const,
            did,
            message: `No usable Ed25519 key found for ${did}`,
          },
        };
      }
      if ('error' in result) {
        return {
          error: {
            name: 'DIDKeyResolutionError' as const,
            did,
            message: result.error.message,
          },
        };
      }
    }

    return {
      error: {
        name: 'DIDKeyResolutionError' as const,
        did,
        message: `Cannot resolve DID: ${did}`,
      },
    };
  };

  /**
   * Build the delegation chain as an array of DIDs from root to invoker.
   * Recursively traverses the first proof of each delegation.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- delegation type from Delegation.extract() is complex
  function buildProofChain(delegation: any): string[] {
    if (!delegation?.proofs || delegation.proofs.length === 0) {
      return [delegation.issuer.did()];
    }
    const parentChain = buildProofChain(delegation.proofs[0]);
    return [...parentChain, delegation.issuer.did()];
  }

  /**
   * Build the delegation chain (root first) from ucanto's VERIFIED authorization
   * result rather than from the invocation's raw attached proofs.
   *
   * SECURITY — this is what buildProofChain() must NOT be used for on the
   * validate() success path. buildProofChain() walks whatever proofs are
   * stapled to the invocation, verified or not. The Authorization returned by
   * ucanto's claim() instead exposes only the proof path ucanto actually walked
   * and cryptographically verified (each `.proofs` entry is itself a verified
   * Authorization; the array is empty at a self-issued/canIssue root). Deriving
   * the reported chain from it guarantees a forged or unverified proof can never
   * appear in proofChain — even when a canIssue short-circuit (e.g. the
   * resource-scoped self-issue path, see resourceNamesIssuer) stops ucanto
   * from walking the stapled proofs at all. ucanto only ever attaches a single
   * parent per level, so following proofs[0] captures the whole verified chain.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ucanto's Authorization type is internal/union-heavy; we treat it structurally
  function verifiedProofChain(authorization: any): string[] {
    const chain: string[] = [];
    let node: unknown = authorization;
    while (node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural walk over ucanto Authorization nodes
      const auth = node as any;
      chain.unshift(auth.issuer.did());
      node = auth.proofs?.[0];
    }
    return chain;
  }

  /**
   * Collect the canonical CIDs of every delegation in ucanto's VERIFIED
   * authorization tree, parents first (so the last entry is the invocation's
   * own CID).
   *
   * These are the identifiers a UCAN revocation targets, so — like
   * verifiedProofChain — this MUST be derived from the Authorization ucanto
   * returned, never from the invocation's raw stapled proofs: only the
   * delegations ucanto actually walked and verified carry authority, and only
   * those are worth checking. Unlike verifiedProofChain (which reports the
   * linear issuer chain via proofs[0]) this visits EVERY branch, because a
   * revocation anywhere in the authorizing set must be honoured.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ucanto's Authorization type is internal/union-heavy; we treat it structurally
  function verifiedProofChainCids(authorization: any): string[] {
    const cids: string[] = [];
    const seen = new Set<string>();

    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const cid = nodeCid('delegation' in node ? node.delegation : node);
      if (cid !== undefined) {
        if (seen.has(cid)) return;
        seen.add(cid);
      }
      if ('proofs' in node && Array.isArray(node.proofs)) {
        for (const proof of node.proofs) visit(proof);
      }
      if (cid !== undefined) cids.push(cid);
    };

    visit(authorization);
    return cids;
  }

  /**
   * Collect the canonical CIDs of a delegation and its whole proof chain,
   * parents first. Used by validateDelegation(), which verifies the chain
   * itself rather than going through ucanto's claim().
   */
  function delegationChainCids(delegation: unknown): string[] {
    const cids: string[] = [];
    const seen = new Set<string>();

    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const cid = nodeCid(node);
      if (cid !== undefined) {
        if (seen.has(cid)) return;
        seen.add(cid);
      }
      if ('proofs' in node && Array.isArray(node.proofs)) {
        for (const proof of node.proofs) visit(proof);
      }
      if (cid !== undefined) cids.push(cid);
    };

    visit(delegation);
    return cids;
  }

  /**
   * Run the configured revocation checker over `cids` in ONE batched call.
   * Returns a failing ValidateResult when any CID is revoked (or when the
   * check itself failed and the policy is fail-closed), else null.
   */
  async function checkRevoked(cids: string[]): Promise<ValidateResult | null> {
    const checker = options.revocationChecker;
    if (!checker || cids.length === 0) return null;

    let revoked: string[];
    try {
      revoked = await checker.check(cids);
    } catch (err) {
      // Revocation status is unknown. Fail closed by default: an unverifiable
      // revocation status must not silently authorize a possibly-revoked token.
      if (options.revocationFailure === 'open') return null;
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        ok: false,
        error: {
          code: 'REVOCATION_CHECK_FAILED',
          message: `Could not determine revocation status: ${message}`,
        },
      };
    }

    // Only trust verdicts about CIDs we actually asked about.
    const hit = revoked.find((cid) => cids.includes(cid));
    if (hit !== undefined) {
      return {
        ok: false,
        error: {
          code: 'REVOKED',
          message: `Delegation ${hit} has been revoked`,
        },
      };
    }
    return null;
  }

  /**
   * Recursively verify signatures across a delegation chain.
   * For each delegation: resolve issuer DID → did:key, verify signature,
   * then check proof chain consistency and recurse into proofs.
   */

  async function verifyDelegationChain(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ucanto's parsed-delegation type is internal/union-heavy; we treat it structurally
    delegation: any,
  ): Promise<ValidateResult> {
    const issuerDid: string = delegation.issuer.did();

    // Resolve issuer DID to did:key
    const resolved = await resolveDIDKey(
      issuerDid as `did:${string}:${string}`,
    );
    if ('error' in resolved) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SIGNATURE',
          message: `Cannot resolve issuer DID ${issuerDid}: ${resolved.error?.message ?? 'unknown'}`,
        },
      };
    }

    if (!resolved.ok || resolved.ok.length === 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SIGNATURE',
          message: `No keys found for issuer DID ${issuerDid}`,
        },
      };
    }

    // A did:ixo DID document may publish multiple Ed25519 verification methods.
    // Try each resolved key until one verifies the signature; only report failure
    // when none of them match.
    const ucanView = delegation.data;
    let didKey: string | undefined;
    let sigValid = false;

    for (const candidateKey of resolved.ok) {
      try {
        const realVerifier = ed25519.Verifier.parse(candidateKey);
        const wrappedVerifier = {
          did: () => issuerDid,
          verify: (payload: Uint8Array, signature: unknown) =>
            realVerifier.verify(
              payload,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SigAlg type mismatch between @ipld/dag-ucan and @ucanto/principal
              signature as any,
            ),
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ucanto's Verifier type expects a verifier object whose structural shape varies by SignatureAlgorithm; the wrappedVerifier we build above satisfies it at runtime
        if (await UCAN.verifySignature(ucanView, wrappedVerifier as any)) {
          sigValid = true;
          didKey = candidateKey;
          break;
        }
      } catch {
        // Try the next key
      }
    }

    if (!sigValid || !didKey) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SIGNATURE',
          message: `Signature verification failed for issuer ${issuerDid}`,
        },
      };
    }

    // Recursively verify proofs
    if (delegation.proofs && delegation.proofs.length > 0) {
      for (const proof of delegation.proofs) {
        // Chain consistency: proof's audience should match this delegation's issuer
        const proofAudience: string = proof.audience.did();
        if (proofAudience !== issuerDid) {
          // Allow DID equivalence: proof audience (did:key) may resolve to same key as issuer (did:ixo)
          const proofAudResolved = await resolveDIDKey(
            proofAudience as `did:${string}:${string}`,
          );
          const proofAudKeys =
            'ok' in proofAudResolved && proofAudResolved.ok
              ? proofAudResolved.ok
              : [];

          // Match if the issuer key we just verified appears anywhere in the
          // proof audience's resolved key set (DIDs may publish multiple keys).
          if (!proofAudKeys.some((k) => k === didKey)) {
            return {
              ok: false,
              error: {
                code: 'UNAUTHORIZED',
                message: `Proof chain broken: proof audience ${proofAudience} does not match delegation issuer ${issuerDid}`,
              },
            };
          }
        }

        const proofResult = await verifyDelegationChain(proof);
        if (!proofResult.ok) {
          return proofResult;
        }
      }
    }

    return { ok: true };
  }

  /**
   * Steps 6–11 of validate(): authorise the decoded invocation with ucanto's
   * claim() and derive the result from what ucanto verified. Runs while the
   * invocation's replay reservation is held.
   */
  async function authorizeInvocation(
    invocation: UcantoDelegation,
    capabilityDef: CapabilityParser,
    resource: string,
  ): Promise<ValidateResult> {
    // 6. Determine the authorization policy for ucanto's claim().
    //
    // SECURITY — the wildcard policy (`rootIssuers: ['*']`, "accept any
    // root") must NOT be expressed as `canIssue = () => true`. That makes
    // ucanto treat the INVOKER as a self-issuing root, so it authorizes on
    // the invocation's own signature alone and NEVER walks or verifies the
    // attached delegation proofs — while buildProofChain() still reads
    // proofs[0] blindly and callers trust proofChain[0] as the root (the
    // row owner). An attacker could then forge a delegation naming any
    // victim as root and have the request attributed to that victim.
    //
    // Instead, in wildcard mode we accept ONLY the structural root of THIS
    // invocation's proof chain as a root. canIssue returns false for the
    // invoker and every intermediate, so ucanto is forced to walk the
    // entire chain and cryptographically verify it (signatures + caveat
    // attenuation) up to that root. A forged or over-broad proof fails that
    // verification. Self-issued invocations (no proofs) are unaffected:
    // their structural root IS the invoker, so canIssue accepts them.
    const wildcard = options.rootIssuers.includes('*');
    const structuralRoot = wildcard
      ? buildProofChain(invocation)[0]
      : undefined;

    // Server verifier is resolved lazily (first call resolves, subsequent calls use cache)
    const resolvedVerifier = await getServerVerifier();
    const claimResult = claim(capabilityDef, [invocation], {
      authority: resolvedVerifier,
      principal: ed25519.Verifier,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ucanto claim() expects a specific DID resolver signature incompatible with our async resolver
      resolveDIDKey: resolveDIDKey as any,
      canIssue: (cap: { with: string }, issuer: string) => {
        // Explicitly allowlisted roots (non-wildcard config). ucanto still
        // verifies the chain up to one of these because canIssue is false
        // for everyone else.
        if (options.rootIssuers.includes(issuer)) return true;
        // Resource-scoped self-issue: the resource URI names the issuer
        // exactly or as a whole segment (see resourceNamesIssuer).
        if (
          typeof cap.with === 'string' &&
          resourceNamesIssuer(cap.with, issuer)
        )
          return true;
        // Wildcard: accept ONLY the structural root of this invocation's
        // proof chain — never the invoker or an intermediate link (see the
        // SECURITY note above). ucanto always calls canIssue with the
        // delegation's DECLARED issuer DID (never a resolved did:key), and
        // structuralRoot is read from that same declared DID, so a string
        // match is correct for every DID method (did:key, did:ixo, did:web).
        if (wildcard && issuer === structuralRoot) return true;
        return false;
      },
      // ucanto's native per-proof-path revocation hook. Left permissive:
      // revocation is checked ONCE against the whole verified chain after
      // claim() (see checkRevoked), which batches all CIDs into a single
      // checker call instead of one network round trip per candidate path.
      validateAuthorization: () => ({ ok: {} }),
    });

    const accessResult = await claimResult;

    if (accessResult.error) {
      // Check if it's a caveat/derives error
      const errorMsg = accessResult.error.message ?? 'Authorization failed';
      const isCaveatError =
        errorMsg.includes('limit') ||
        errorMsg.includes('caveat') ||
        errorMsg.includes('exceeds') ||
        errorMsg.includes('violates');

      return {
        ok: false,
        error: {
          code: isCaveatError ? 'CAVEAT_VIOLATION' : 'UNAUTHORIZED',
          message: errorMsg,
        },
      };
    }

    // 7. Verify the resource matches. `can`, `with` and `nb` all come from
    // the capability ucanto actually authorised: claim() tries every
    // capability of the invocation and returns the first it can prove, so
    // the invocation's capabilities[0] may be a different, unproven one.
    // `nb` is the value read through the capability's nb schema (the value
    // its `derives` checked); fields the schema does not declare are not
    // part of it.
    const authorized = accessResult.ok.capability;
    const authorizedWith = String(authorized.with);
    const authorizedNb: unknown = authorized.nb;
    const validatedCap = {
      can: String(authorized.can),
      with: authorizedWith,
      nb:
        isRecord(authorizedNb) && Object.keys(authorizedNb).length > 0
          ? authorizedNb
          : undefined,
    };
    if (authorizedWith !== resource) {
      // Check if it's a wildcard match
      const isWildcardMatch =
        (authorizedWith.endsWith('/*') &&
          resource.startsWith(authorizedWith.slice(0, -1))) ||
        (authorizedWith.endsWith(':*') &&
          resource.startsWith(authorizedWith.slice(0, -1)));

      if (!isWildcardMatch) {
        return {
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: `Resource ${authorizedWith} does not match ${resource}`,
          },
        };
      }
    }

    // 8. Build proof chain and compute effective expiration.
    // proofChain and the expiry MUST come from the VERIFIED authorization
    // (see verifiedProofChain) — never from the invocation's raw stapled
    // proofs — so a forged proof can never be reported as the row-owning
    // root, and the expiry is the earliest over every delegation ucanto
    // actually used (the invocation included).
    const proofChain = verifiedProofChain(accessResult.ok);
    const proofChainCids = verifiedProofChainCids(accessResult.ok);
    const { expiration } = chainTimeBounds(accessResult.ok, (node) =>
      'delegation' in node ? node.delegation : undefined,
    );

    // 9. Optional policy: refuse tokens that never expire. Such a token can
    // only ever be neutralized by a revocation record kept forever.
    if (options.requireExpiration === true && expiration === undefined) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message:
            'Invocation has no expiration; this validator requires a bounded expiry',
        },
      };
    }

    // 10. Revocation: check the invocation and every VERIFIED delegation in
    // its proof chain in one batched call. A revoked (or unverifiable)
    // token fails here, which releases its replay reservation.
    const revocation = await checkRevoked(proofChainCids);
    if (revocation) return revocation;

    // 11. Extract facts from the invocation
    const facts = invocation.facts;

    return {
      ok: true,
      invoker: invocation.issuer.did(),
      capability: validatedCap,
      expiration,
      proofChain,
      proofChainCids,
      facts: facts && facts.length > 0 ? facts : undefined,
    };
  }

  return {
    serverDid: options.serverDid,

    async validate(
      invocationBase64,
      capabilityDef,
      resource,
    ): Promise<ValidateResult> {
      try {
        // 1. Decode the invocation from base64 CAR
        const carBytes = new Uint8Array(
          Buffer.from(invocationBase64, 'base64'),
        );

        // 2. Extract the invocation from CAR
        const extracted = await Delegation.extract(carBytes);
        if (extracted.error) {
          return {
            ok: false,
            error: {
              code: 'INVALID_FORMAT',
              message: `Failed to decode: ${extracted.error?.message ?? 'unknown'}`,
            },
          };
        }

        const invocation = 'ok' in extracted ? extracted.ok : extracted;

        // 3. Basic validation - check we have required fields
        if (!invocation?.issuer?.did || !invocation?.audience?.did) {
          return {
            ok: false,
            error: {
              code: 'INVALID_FORMAT',
              message: 'Invocation missing issuer or audience',
            },
          };
        }

        // 4. Check audience matches this server's public DID
        const audienceDid = invocation.audience.did();
        if (audienceDid !== options.serverDid) {
          return {
            ok: false,
            error: {
              code: 'UNAUTHORIZED',
              message: `Invocation addressed to ${audienceDid}, not ${options.serverDid}`,
            },
          };
        }

        // 5. Replay protection. The CID is reserved BEFORE any verification
        // (DID resolution, claim(), revocation are all asynchronous), so two
        // concurrent presentations of one invocation cannot both pass. The
        // reservation is released when validation fails afterwards, so a
        // rejected attempt does not use up the token, and kept for the
        // invocation's own lifetime when it succeeds.
        const invocationCid = invocation.cid?.toString();
        const reservation = invocationCid
          ? await reserveInvocation(
              invocationStore,
              invocationCid,
              replayMarkTtlMs(invocation.expiration),
            )
          : undefined;
        if (reservation === null) {
          return {
            ok: false,
            error: {
              code: 'REPLAY',
              message: 'Invocation has already been used',
            },
          };
        }

        let accepted = false;
        try {
          const result = await authorizeInvocation(
            invocation,
            capabilityDef,
            resource,
          );
          if (result.ok) {
            await reservation?.commit();
            accepted = true;
          }
          return result;
        } finally {
          if (!accepted) {
            // A store that cannot drop the mark leaves the token used; the
            // validation result stands either way.
            await reservation?.release().catch(() => undefined);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return { ok: false, error: { code: 'INVALID_FORMAT', message } };
      }
    },

    async validateDelegation(
      delegationBase64: string,
    ): Promise<ValidateResult> {
      try {
        // 1. Decode the delegation from base64 CAR
        const carBytes = new Uint8Array(
          Buffer.from(delegationBase64, 'base64'),
        );

        // 2. Extract the delegation from CAR
        const extracted = await Delegation.extract(carBytes);
        if (extracted.error) {
          return {
            ok: false,
            error: {
              code: 'INVALID_FORMAT',
              message: `Failed to decode: ${extracted.error?.message ?? 'unknown'}`,
            },
          };
        }

        const delegation = 'ok' in extracted ? extracted.ok : extracted;

        // 3. Basic validation
        if (!delegation?.issuer?.did || !delegation?.audience?.did) {
          return {
            ok: false,
            error: {
              code: 'INVALID_FORMAT',
              message: 'Delegation missing issuer or audience',
            },
          };
        }

        // 4. Check audience matches this server's public DID
        const audienceDid = delegation.audience.did();
        if (audienceDid !== options.serverDid) {
          return {
            ok: false,
            error: {
              code: 'UNAUTHORIZED',
              message: `Delegation addressed to ${audienceDid}, not ${options.serverDid}`,
            },
          };
        }

        // 5. Check the validity window: the effective expiration is the
        // earliest and the effective not-before the latest over the
        // delegation and EVERY proof in its chain (all of which step 6
        // verifies).
        const { expiration, notBefore } = chainTimeBounds(
          delegation,
          (node) => node,
        );
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (expiration !== undefined && expiration < nowSeconds) {
          return {
            ok: false,
            error: {
              code: 'EXPIRED',
              message: `Delegation expired at ${new Date(expiration * 1000).toISOString()}`,
            },
          };
        }
        if (notBefore !== undefined && notBefore > nowSeconds) {
          return {
            ok: false,
            error: {
              code: 'UNAUTHORIZED',
              message: `Delegation is not valid before ${new Date(notBefore * 1000).toISOString()}`,
            },
          };
        }

        if (options.requireExpiration === true && expiration === undefined) {
          return {
            ok: false,
            error: {
              code: 'UNAUTHORIZED',
              message:
                'Delegation has no expiration; this validator requires a bounded expiry',
            },
          };
        }

        // 6. Verify signatures across the entire delegation chain
        const sigResult = await verifyDelegationChain(delegation);
        if (!sigResult.ok) {
          return sigResult;
        }

        // 7. Revocation: check this delegation and its whole (now verified)
        // proof chain in one batched call.
        const proofChainCids = delegationChainCids(delegation);
        const revocation = await checkRevoked(proofChainCids);
        if (revocation) return revocation;

        // 8. Success — return delegation details
        const proofChain = buildProofChain(delegation);
        const cap = delegation.capabilities?.[0];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- delegation type from Delegation.extract() is complex
        const facts = (delegation as any).facts as
          | Record<string, unknown>[]
          | undefined;

        return {
          ok: true,
          invoker: delegation.issuer.did(),
          capability: cap
            ? {
                can: cap.can,
                with: cap.with,
                nb: cap.nb as Record<string, unknown> | undefined,
              }
            : undefined,
          expiration,
          proofChain,
          proofChainCids,
          facts: facts && facts.length > 0 ? facts : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return { ok: false, error: { code: 'INVALID_FORMAT', message } };
      }
    },
  };
}
