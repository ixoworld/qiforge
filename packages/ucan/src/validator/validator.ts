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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `issuer` names the AUTHORITY of `resource`, i.e. the part of the
 * URI that says whose resource it is: the whole resource (`did:key:z6Mk…`),
 * the authority after the scheme (`ixo:did:key:z6Mk…`, `ixo:tenant:did:key:z6Mk…`,
 * optionally followed by `/path`), or the first path segment under a named
 * authority (`ixo:tenant/did:key:z6Mk…`, `ixo:filesystem/did:key:z6Mk…/files`).
 *
 * A DID deeper in the path does NOT count (`ixo:filesystem/alice/did:key:z6Mk…`
 * is Alice's resource that happens to mention the DID, for example a folder
 * shared with it), and neither does a DID that is only a prefix of the named
 * one (`did:web:victim.co` inside `…/did:web:victim.com`) or part of a longer
 * segment. When the authority is itself a DID (`ixo:did:key:alice/…`) the
 * resource is that DID's, and the first path segment is not consulted. Query
 * and fragment are not part of the authority.
 */
export function resourceNamesIssuer(resource: string, issuer: string): boolean {
  if (!issuer) return false;
  if (resource === issuer) return true;
  // A resource that is itself a DID names exactly that DID.
  if (resource.startsWith('did:')) return false;
  const schemeEnd = resource.indexOf(':');
  if (schemeEnd === -1) return false;
  const rest = resource.slice(schemeEnd + 1).split(/[?#]/, 1)[0] ?? '';
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  if (authority === '') return false;
  if (authority === issuer || authority.endsWith(`:${issuer}`)) return true;
  // An authority that is (or ends in) some DID names that DID's resource; a
  // DID in the path below it is somebody else's.
  if (authority.startsWith('did:') || authority.includes(':did:')) return false;
  if (slash === -1) return false;
  const path = rest.slice(slash + 1);
  const nextSlash = path.indexOf('/');
  const firstSegment = nextSlash === -1 ? path : path.slice(0, nextSlash);
  return firstSegment === issuer;
}

// =============================================================================
// Proof-chain shape bounds
// =============================================================================

/**
 * Bounds on the shape of the RAW proof tree of a token, checked before any
 * signature is verified or any DID resolved.
 *
 * ucanto verifies every proof it reaches and backtracks through every path
 * when one fails, without de-duplicating shared nodes, and it branches on
 * every capability of a proof that could match, so a small token whose proofs
 * reference the same blocks several times at every level, or repeat a
 * capability a few times per link, costs exponential CPU and produces an error
 * message that enumerates every path. Counts are over VISITS (a node reached
 * through two parents counts twice), which is what the verification work is
 * proportional to; `maxPaths` bounds the product of those branch factors.
 */
export interface ProofChainLimits {
  /** Delegation links below the token itself (the token is depth 0). */
  maxDepth: number;
  /** Nodes visited over the whole tree, the token included. */
  maxNodes: number;
  /** Proofs attached to any single delegation (or to the token). */
  maxProofsPerLink: number;
  /** Capabilities on any single delegation (or on the token). */
  maxCapabilitiesPerLink: number;
  /**
   * Distinct issuer DIDs over the whole tree. Each is a DID resolution (the
   * resolver is memoised per validation; validateDelegation() also resolves
   * proof audiences, which maxNodes bounds).
   */
  maxIssuers: number;
  /**
   * Upper bound on the authorization paths ucanto may explore for the token:
   * the token's capability count times the sum over its proofs of (that
   * proof's capability count times its own paths), a leaf counting 1. Three
   * capabilities repeated at each of ten links is 3^11 paths from 11 nodes.
   */
  maxPaths: number;
}

/**
 * Defaults, generous for real chains: a user → agent → sub-agent re-share is
 * 2–3 deep with one issuer per link; a client that attaches every grant it
 * holds at one scope attaches a handful, each with its own parent; a bundled
 * grant for several services carries a capability per service.
 */
export const DEFAULT_PROOF_CHAIN_LIMITS: Readonly<ProofChainLimits> = {
  maxDepth: 10,
  maxNodes: 64,
  maxProofsPerLink: 16,
  maxCapabilitiesPerLink: 32,
  maxIssuers: 16,
  maxPaths: 512,
};

/**
 * Longest `error.message` the validator returns by default. ucanto's messages
 * can list every explored path of a proof tree.
 */
export const DEFAULT_MAX_ERROR_MESSAGE_CHARS = 1024;

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `${name} must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}

function resolveProofChainLimits(
  option: Partial<ProofChainLimits> | false | undefined,
): ProofChainLimits | null {
  if (option === false) return null;
  const limits: ProofChainLimits = { ...DEFAULT_PROOF_CHAIN_LIMITS };
  for (const key of Object.keys(
    DEFAULT_PROOF_CHAIN_LIMITS,
  ) as (keyof ProofChainLimits)[]) {
    // An undefined key (the usual env-wiring shape) keeps the default.
    const value = option?.[key];
    if (value !== undefined) {
      limits[key] = positiveInteger(value, `proofChainLimits.${key}`);
    }
  }
  return limits;
}

interface RawChainNode {
  issuer?: { did(): string };
  proofs?: unknown[];
  capabilities?: unknown[];
}

function asChainNode(node: unknown): RawChainNode | null {
  return node && typeof node === 'object' ? node : null;
}

/**
 * Walk the raw proof tree of `root` and return a short reason when its shape
 * exceeds `limits`, else null. A proof that travelled as a bare CID link (its
 * block not embedded) has no issuer, capabilities or proofs; it counts as one
 * node and one path.
 */
function proofChainShapeError(
  root: unknown,
  limits: ProofChainLimits,
): string | null {
  let visits = 0;
  const issuers = new Set<string>();
  let reason: string | null = null;
  const fail = (why: string): number => {
    reason ??= why;
    return Infinity;
  };
  /** Paths through `value` (see ProofChainLimits.maxPaths), or Infinity once a bound failed. */
  const walk = (value: unknown, depth: number): number => {
    const node = asChainNode(value);
    if (!node) return 1;
    if (depth > limits.maxDepth) {
      return fail(`Proof chain is deeper than ${limits.maxDepth} links`);
    }
    if (++visits > limits.maxNodes) {
      return fail(`Proof chain has more than ${limits.maxNodes} nodes`);
    }
    const issuer = node.issuer?.did?.();
    if (typeof issuer === 'string') issuers.add(issuer);
    if (issuers.size > limits.maxIssuers) {
      return fail(
        `Proof chain involves more than ${limits.maxIssuers} issuers`,
      );
    }
    const capabilities = Array.isArray(node.capabilities)
      ? node.capabilities.length
      : 0;
    if (capabilities > limits.maxCapabilitiesPerLink) {
      return fail(
        `A delegation carries more than ${limits.maxCapabilitiesPerLink} capabilities`,
      );
    }
    const proofs = Array.isArray(node.proofs) ? node.proofs : [];
    if (proofs.length > limits.maxProofsPerLink) {
      return fail(
        `A delegation carries more than ${limits.maxProofsPerLink} proofs`,
      );
    }
    let below = 0;
    for (const proof of proofs) {
      below += walk(proof, depth + 1);
      if (below > limits.maxPaths) break;
    }
    const paths = Math.max(1, capabilities) * Math.max(1, below);
    if (paths > limits.maxPaths) {
      return fail(
        `Proof chain allows more than ${limits.maxPaths} authorization paths`,
      );
    }
    return paths;
  };
  walk(root, 0);
  return reason;
}

/** ucanto's universal resource: a capability on it matches any resource. */
const UNIVERSAL_RESOURCE = 'ucan:*';

/**
 * True when the token or any proof in its raw tree carries a capability on
 * `ucan:*`. Each block is visited once (keyed by CID: ucanto materialises a
 * new Delegation object per parent, so object identity would not de-duplicate
 * a shared block), so this stays linear in the token size even with the shape
 * limits disabled.
 */
function chainUsesUniversalResource(root: unknown): boolean {
  const seen = new Set<string>();
  const walk = (value: unknown): boolean => {
    const node = asChainNode(value);
    if (!node) return false;
    const cid = nodeCid(node);
    if (cid !== undefined) {
      if (seen.has(cid)) return false;
      seen.add(cid);
    }
    for (const cap of Array.isArray(node.capabilities)
      ? node.capabilities
      : []) {
      if (isRecord(cap) && cap.with === UNIVERSAL_RESOURCE) return true;
    }
    for (const proof of Array.isArray(node.proofs) ? node.proofs : []) {
      if (walk(proof)) return true;
    }
    return false;
  };
  return walk(root);
}

/** Cut `message` to at most `max` characters, the last one `…` when cut. */
function clipMessage(message: string, max: number): string {
  if (message.length <= max) return message;
  let end = max - 1;
  // Do not split a surrogate pair.
  const last = message.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${message.slice(0, end)}…`;
}

/**
 * The form ucanto reports a resource in: `URI.match` reads it through the URL
 * parser, so `IXO:company/A` is reported as `ixo:company/A`. A value that is
 * not a URL is compared as given.
 */
function canonicalResource(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

/**
 * Remember every DID lookup for the rest of ONE validation: ucanto resolves
 * the issuer of every proof it checks, and the same DID issues several links
 * of most real chains (an owner who attached every grant it holds, an agent
 * that re-shared twice). Failures are remembered too — the answer cannot
 * change within one request. Nothing is kept across validations.
 */
function memoizeResolver<D, R>(
  resolve: (did: D) => Promise<R>,
): (did: D) => Promise<R> {
  const inflight = new Map<D, Promise<R>>();
  return (did) => {
    const hit = inflight.get(did);
    if (hit) return hit;
    const pending = resolve(did);
    inflight.set(did, pending);
    return pending;
  };
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

  /**
   * Bounds on the shape of a token's raw proof tree, checked before any
   * signature is verified or DID resolved (see ProofChainLimits). Defaults to
   * DEFAULT_PROOF_CHAIN_LIMITS; pass some keys to override them, or `false`
   * to disable the check. A token over a bound fails with 'INVALID_FORMAT'.
   */
  proofChainLimits?: Partial<ProofChainLimits> | false;

  /**
   * Longest `error.message` returned; a longer message is cut to this length
   * and ends with `…`. Default DEFAULT_MAX_ERROR_MESSAGE_CHARS (1,024).
   * ucanto's messages can enumerate every explored path of a proof tree.
   */
  maxErrorMessageChars?: number;

  /**
   * Most capabilities an invocation may carry. Unlimited by default. A service
   * that mints one capability per invocation and routes requests by it should
   * set 1: ucanto authorises the first capability it can prove, which may not
   * be the one the service read. An invocation over the limit fails with
   * 'INVALID_FORMAT'. See also `ValidateInvocationOptions.expect`.
   */
  maxCapabilities?: number;

  /**
   * Whether a capability on ucanto's universal resource `ucan:*` (it matches
   * any resource) is accepted anywhere in a token or its proof chain. True by
   * default. A service whose capability definitions reason about resources
   * should set false; such a token then fails with 'UNAUTHORIZED'.
   */
  allowUniversalResource?: boolean;
}

/**
 * Per-call options of `validate()`.
 */
export interface ValidateInvocationOptions {
  /**
   * The capability the caller read from the invocation and will act on. After
   * ucanto authorised the invocation, its authorised `can` and/or `with` must
   * equal these exactly (no wildcard tolerance; `with` in URL-canonical form,
   * as ucanto reports it), else the result is 'UNAUTHORIZED'. Without it,
   * `with` is still checked against `resource` (exact, or a `/*` / `:*`
   * wildcard prefix) as before. `nb` is not pinned: act on `result.capability`
   * and set `maxCapabilities: 1` when the invocation must carry one.
   */
  expect?: { can?: string; with?: string };
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
   * @param options - Per-call options (see ValidateInvocationOptions)
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
    options?: ValidateInvocationOptions,
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
  const proofChainLimits = resolveProofChainLimits(options.proofChainLimits);
  const maxErrorMessageChars = positiveInteger(
    options.maxErrorMessageChars ?? DEFAULT_MAX_ERROR_MESSAGE_CHARS,
    'maxErrorMessageChars',
  );
  const maxCapabilities =
    options.maxCapabilities === undefined
      ? undefined
      : positiveInteger(options.maxCapabilities, 'maxCapabilities');
  const allowUniversalResource = options.allowUniversalResource !== false;

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

  // Create DID resolver for use during validation (for issuers in delegation
  // chain). Each validation wraps it in a per-request memo (see
  // memoizeResolver); nothing is cached across validations here.
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
    resolve: typeof resolveDIDKey,
  ): Promise<ValidateResult> {
    const issuerDid: string = delegation.issuer.did();

    // Resolve issuer DID to did:key
    const resolved = await resolve(issuerDid as `did:${string}:${string}`);
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
          const proofAudResolved = await resolve(
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

        const proofResult = await verifyDelegationChain(proof, resolve);
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
    resolve: typeof resolveDIDKey,
    expect: ValidateInvocationOptions['expect'],
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
      resolveDIDKey: resolve as any,
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

    // 7b. Pin the authorised capability to the one the caller read and will
    // act on: ucanto authorises the first capability it can prove, and a
    // caller that routes by the invocation's first capability must never act
    // on a different one than the one proven here. Exact match, no wildcard
    // tolerance; `with` is compared in the form ucanto reports it (see
    // canonicalResource).
    if (
      (expect?.can !== undefined && validatedCap.can !== expect.can) ||
      (expect?.with !== undefined &&
        validatedCap.with !== canonicalResource(expect.with))
    ) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message:
            `Authorised capability {can: ${validatedCap.can}, with: ${validatedCap.with}} ` +
            `is not the expected {can: ${expect?.can ?? '(any)'}, with: ${expect?.with ?? '(any)'}}`,
        },
      };
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

  /** Cut an over-long error message (see maxErrorMessageChars). */
  function clipped(result: ValidateResult): ValidateResult {
    if (!result.error || result.error.message.length <= maxErrorMessageChars) {
      return result;
    }
    return {
      ...result,
      error: {
        ...result.error,
        message: clipMessage(result.error.message, maxErrorMessageChars),
      },
    };
  }

  /**
   * Structural checks shared by validate() and validateDelegation(), run
   * before any signature is verified or DID resolved: proof-tree shape bounds,
   * then the universal-resource rule. Returns a failing result or null.
   */
  function structuralError(token: unknown): ValidateResult | null {
    if (proofChainLimits) {
      const reason = proofChainShapeError(token, proofChainLimits);
      if (reason) {
        return {
          ok: false,
          error: { code: 'INVALID_FORMAT', message: reason },
        };
      }
    }
    if (!allowUniversalResource && chainUsesUniversalResource(token)) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: `A capability on the universal resource ${UNIVERSAL_RESOURCE} is not accepted by this validator`,
        },
      };
    }
    return null;
  }

  async function validateInvocation(
    invocationBase64: string,
    capabilityDef: CapabilityParser,
    resource: string,
    callOptions: ValidateInvocationOptions | undefined,
  ): Promise<ValidateResult> {
    try {
      // 1. Decode the invocation from base64 CAR
      const carBytes = new Uint8Array(Buffer.from(invocationBase64, 'base64'));

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

      // 4b. Structural rules, cheapest first: capability count, proof-tree
      // shape, universal resource. All before the replay reservation and
      // before any DID is resolved or signature verified.
      const capabilityCount = invocation.capabilities?.length ?? 0;
      if (maxCapabilities !== undefined && capabilityCount > maxCapabilities) {
        return {
          ok: false,
          error: {
            code: 'INVALID_FORMAT',
            message: `Invocation carries ${capabilityCount} capabilities; this validator accepts at most ${maxCapabilities}`,
          },
        };
      }
      const structural = structuralError(invocation);
      if (structural) return structural;

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
          memoizeResolver(resolveDIDKey),
          callOptions?.expect,
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
  }

  async function validateDelegationToken(
    delegationBase64: string,
  ): Promise<ValidateResult> {
    try {
      // 1. Decode the delegation from base64 CAR
      const carBytes = new Uint8Array(Buffer.from(delegationBase64, 'base64'));

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

      // 4b. Structural rules (proof-tree shape, universal resource) before
      // the recursive signature walk below.
      const structural = structuralError(delegation);
      if (structural) return structural;

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

      // 6. Verify signatures across the entire delegation chain, resolving
      // each DID at most once for this call.
      const sigResult = await verifyDelegationChain(
        delegation,
        memoizeResolver(resolveDIDKey),
      );
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
  }

  return {
    serverDid: options.serverDid,

    async validate(invocationBase64, capabilityDef, resource, callOptions) {
      return clipped(
        await validateInvocation(
          invocationBase64,
          capabilityDef,
          resource,
          callOptions,
        ),
      );
    },

    async validateDelegation(delegationBase64) {
      return clipped(await validateDelegationToken(delegationBase64));
    },
  };
}
