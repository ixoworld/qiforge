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
   * If not provided, an in-memory store is used
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
        // Return the array of did:key strings (ucanto will parse them)
        return { ok: result.ok };
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
   * resource-scoped `cap.with.includes(issuer)` self-issue path) stops ucanto
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
   * Compute the effective (earliest) expiration across the entire delegation chain.
   * Returns undefined if no expiration is set anywhere in the chain.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function computeEffectiveExpiration(delegation: any): number | undefined {
    const exp =
      typeof delegation?.expiration === 'number' &&
      isFinite(delegation.expiration)
        ? delegation.expiration
        : undefined;

    if (!delegation?.proofs || delegation.proofs.length === 0) {
      return exp;
    }

    const parentExp = computeEffectiveExpiration(delegation.proofs[0]);

    if (exp !== undefined && parentExp !== undefined) {
      return Math.min(exp, parentExp);
    }
    return exp ?? parentExp;
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

      try {
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

        // 5. Check replay protection
        const invocationCid = invocation.cid?.toString();
        if (invocationCid && (await invocationStore.has(invocationCid))) {
          return {
            ok: false,
            error: {
              code: 'REPLAY',
              message: 'Invocation has already been used',
            },
          };
        }

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
            // Resource-scoped self-issue: the resource URI names the issuer.
            if (typeof cap.with === 'string' && cap.with.includes(issuer))
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

        // 7. Verify the resource matches
        const validatedCap = invocation.capabilities?.[0];
        if (validatedCap && validatedCap.with !== resource) {
          // Check if it's a wildcard match
          const capWith = validatedCap.with as string;
          const isWildcardMatch =
            (capWith.endsWith('/*') &&
              resource.startsWith(capWith.slice(0, -1))) ||
            (capWith.endsWith(':*') &&
              resource.startsWith(capWith.slice(0, -1)));

          if (!isWildcardMatch) {
            return {
              ok: false,
              error: {
                code: 'UNAUTHORIZED',
                message: `Resource ${validatedCap.with} does not match ${resource}`,
              },
            };
          }
        }

        // 8. Build proof chain and compute effective expiration.
        // proofChain MUST come from the VERIFIED authorization (see
        // verifiedProofChain) — never from the invocation's raw stapled proofs
        // — so a forged proof can never be reported as the row-owning root.
        const proofChain = verifiedProofChain(accessResult.ok);
        const proofChainCids = verifiedProofChainCids(accessResult.ok);
        const expiration = computeEffectiveExpiration(invocation);

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
        // its proof chain in one batched call. This runs BEFORE the replay
        // marker is written, so a revoked (or unverifiable) token does not burn
        // the invocation's single-use slot.
        const revocation = await checkRevoked(proofChainCids);
        if (revocation) return revocation;

        // 11. Success! Mark invocation as used for replay protection
        if (invocationCid) {
          await invocationStore.add(invocationCid);
        }

        // 12. Extract facts from the invocation
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- invocation type from Delegation.extract() is complex
        const facts = (invocation as any).facts as
          | Record<string, unknown>[]
          | undefined;

        return {
          ok: true,
          invoker: invocation.issuer.did(),
          capability: validatedCap
            ? {
                can: validatedCap.can,
                with: validatedCap.with,
                nb: validatedCap.nb as Record<string, unknown> | undefined,
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

        // 5. Check expiration (effective = earliest across chain)
        const expiration = computeEffectiveExpiration(delegation);
        if (expiration !== undefined) {
          const nowSeconds = Math.floor(Date.now() / 1000);
          if (expiration < nowSeconds) {
            return {
              ok: false,
              error: {
                code: 'EXPIRED',
                message: `Delegation expired at ${new Date(expiration * 1000).toISOString()}`,
              },
            };
          }
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
