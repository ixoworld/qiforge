/**
 * @fileoverview Verifies a UCAN presented as the proof behind a grant.
 *
 * A rights entry says how the authority it carries is evidenced. `format:
 * 'policy'` means the constitution is itself the authority and there is no
 * separate token to check. Any other format names a proof, and a proof nobody
 * verifies is a decoration — so until this adapter existed, every non-`policy`
 * grant was refused with `capability_verifier_unavailable`. Failing closed was
 * right; it also meant the whole capability-proof path was unusable.
 *
 * What is checked, all of it by the UCAN package rather than re-implemented
 * here: the signature chain from root issuer to invoker, the effective
 * expiration across that chain, and that the token is addressed to this
 * runtime. Then, here: that the capability actually covers the action being
 * authorized — a valid token for something else is not a proof of this.
 *
 * ## Scope matching
 *
 * `can` is compared to the operation and `with` to the object, using the same
 * wildcard rules grants use, because a proof that covers a namespace should
 * cover the same set a grant over that namespace would. A token bearing
 * `can: '*'` is honoured, since delegating everything is a thing a principal
 * may deliberately do; a token bearing a `with` the object falls outside is
 * not, whatever its `can` says.
 *
 * ## Revocation, stated plainly
 *
 * There is no revocation source in this codebase — no revocation store, no
 * status list, nothing the UCAN package exposes. So `isRevoked` is an option,
 * and when it is absent the verdict reports `revoked: null`, which the record
 * writes as **not checked** rather than as clean. That distinction is the
 * whole point: an entity whose audit trail says a proof was unrevoked when
 * nothing ever asked is worse than one that says it did not know.
 *
 * Permitting on an unchecked revocation is a deliberate choice and the weakest
 * link here. It is the same posture as an unverified anchor: record the gap
 * rather than pretend it away, and close it when a source exists.
 *
 * ## What this does not yet distinguish
 *
 * The proof the runtime has to hand is the inbound delegation — what the user
 * delegated to this oracle. A grant's principal is the *entity*, so a grant
 * evidenced by a capability the entity itself holds (a token issued to it,
 * rather than through it) is a different object. Phase 1 verifies the token
 * presented; issuing and holding the entity's own capabilities comes with
 * per-permit minting.
 */
import { createHash } from 'node:crypto';
import type { AuthorizeDeps, CapabilityVerdict } from './authorize.js';

/** The slice of the UCAN validator this adapter needs. */
export interface DelegationValidator {
  validateDelegation(delegationBase64: string): Promise<{
    ok: boolean;
    invoker?: string;
    capability?: { can: string; with: string; nb?: Record<string, unknown> };
    expiration?: number;
    proofChain?: string[];
    error?: { code: string; message: string };
  }>;
}

export interface CapabilityVerifierOptions {
  validator: DelegationValidator;
  /**
   * Whether this proof has been revoked. Absent means nothing can answer, and
   * the verdict records `revoked: null` — unchecked, not clean.
   */
  isRevoked?: (proofDigest: string, invoker: string) => Promise<boolean>;
}

/** Content address of the presented token, for the decision record. */
function digestOf(proof: string): string {
  return `sha256:${createHash('sha256').update(proof, 'utf8').digest('hex')}`;
}

/**
 * Whether a delegated resource covers a claimed one.
 *
 * The same rules grant objects use: exact, a bare `*`, or a `/*` / `:*`
 * prefix. Deliberately not substring or prefix-without-separator matching —
 * `ixo:vendor:approved` must not cover `ixo:vendor:approved-not-really`.
 */
function resourceCovers(granted: string, claimed: string): boolean {
  if (granted === claimed || granted === '*') return true;
  for (const suffix of ['/*', ':*']) {
    if (granted.endsWith(suffix)) {
      const prefix = granted.slice(0, -1);
      if (claimed.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Whether a delegated ability covers the operation being authorized. */
function abilityCovers(can: string, operation: string): boolean {
  if (can === operation || can === '*') return true;
  // `memory/*` covers `memory/read`. The separator is required, so `memory/*`
  // does not cover `memoryleak`.
  if (can.endsWith('/*')) return operation.startsWith(can.slice(0, -1));
  return false;
}

/**
 * Builds the capability verifier the evaluator calls for non-`policy` grants.
 *
 * Every failure path returns a verdict rather than throwing: an unverifiable
 * proof is a decision the runtime has to be able to record, not an exception.
 */
export function createCapabilityVerifier(
  options: CapabilityVerifierOptions,
): NonNullable<AuthorizeDeps['verifyCapabilityProof']> {
  return async (proof, expectation): Promise<CapabilityVerdict> => {
    const proofDigest = digestOf(proof);

    let result: Awaited<ReturnType<DelegationValidator['validateDelegation']>>;
    try {
      result = await options.validator.validateDelegation(proof);
    } catch (error) {
      return {
        valid: false,
        proofDigest,
        revoked: null,
        reason: `validation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!result.ok) {
      return {
        valid: false,
        proofDigest,
        revoked: null,
        reason: result.error
          ? `${result.error.code}: ${result.error.message}`
          : 'delegation did not validate',
      };
    }

    const capability = result.capability;
    if (!capability) {
      return {
        valid: false,
        proofDigest,
        revoked: null,
        reason: 'delegation carries no capability to check',
      };
    }

    // A validly-signed token for a different action is not a proof of this
    // one, and this is the check that makes the difference.
    if (!resourceCovers(capability.with, expectation.object)) {
      return {
        valid: false,
        proofDigest,
        revoked: null,
        reason: `delegation covers '${capability.with}', not '${expectation.object}'`,
      };
    }
    if (!abilityCovers(capability.can, expectation.action)) {
      return {
        valid: false,
        proofDigest,
        revoked: null,
        reason: `delegation permits '${capability.can}', not '${expectation.action}'`,
      };
    }

    if (!options.isRevoked) {
      // Unchecked, and recorded as such. See the note in the file overview.
      return { valid: true, proofDigest, revoked: null };
    }

    try {
      const revoked = await options.isRevoked(
        proofDigest,
        result.invoker ?? '',
      );
      return revoked
        ? { valid: false, proofDigest, revoked: true, reason: 'revoked' }
        : { valid: true, proofDigest, revoked: false };
    } catch (error) {
      // A revocation check that failed has not established anything. Unlike
      // the absent-source case, something was supposed to answer and did not,
      // which is a reason to stop rather than to proceed noting the gap.
      return {
        valid: false,
        proofDigest,
        revoked: null,
        reason: `revocation check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
