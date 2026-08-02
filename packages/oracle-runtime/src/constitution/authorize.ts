/**
 * @fileoverview The per-action authorization evaluator.
 *
 * This is the structural boundary between what a model proposes and what the
 * entity does. A model's output is a claim; this function decides whether that
 * claim becomes an effect, using only the entity's own constitution and the
 * proofs presented with the request. It is pure: no I/O, no ambient state, no
 * clock of its own — every external fact arrives through {@link AuthorizeDeps},
 * so the same request replays to the same decision.
 *
 * The order of checks follows the format's normative resolution:
 *
 *   1. the action class is recognized
 *   2. the mode ceiling permits it, and no override disables it
 *   3. no matching deny grant exists (deny beats allow at equal or broader scope)
 *   4. if the baseline requires an explicit grant, a matching allow grant exists,
 *      its proof verifies, it is unrevoked, in-window, and every condition holds
 *   5. required human review has a verifiable approval
 *
 * Authorization is default deny. A check that cannot be completed — an
 * unverifiable proof, an untrusted clock, an unrecognized action — denies or
 * escalates according to the constitution's failure policy. It never falls
 * through to permitted.
 */
import {
  MODE_RANK,
  ACTION_MIN_MODE,
  OVERRIDE_DISABLES,
  RIGHT_TYPE_TO_ACTION,
  type AgentMode,
  type Amount,
  type ConstitutionStatus,
  type FailurePolicy,
  type ParsedDomainMd,
  type RightsActionType,
  type RightsGrant,
} from './schema.js';
import type { TimeReading, TimeSource } from './time.js';

// ---------------------------------------------------------------------------
// Policy — what the evaluator reads from a parsed document
// ---------------------------------------------------------------------------

/**
 * The decision-relevant projection of a `domain.md`.
 *
 * Deliberately narrower than the document: the evaluator can only consider
 * what appears here, which keeps the authorization surface auditable and lets
 * the parser widen without widening what authority depends on.
 */
export interface ConstitutionPolicy {
  /** The subject this constitution governs — the entity's own identifier. */
  subject: string;
  status: ConstitutionStatus;
  failurePolicy: FailurePolicy;
  modeCeiling: AgentMode;
  /** Override keys switched off, e.g. `move_value`. */
  disabledOverrides: readonly string[];
  /** Action classes that always require an explicit grant. */
  baseline: readonly string[];
  /** Declared triggers that route an action to a human. */
  humanReviewRequiredFor: readonly string[];
  grants: readonly RightsGrant[];
  /** Identity of the exact document these rules came from. */
  domainMdCid: string;
  documentRevision: string;
}

/** Projects a parsed document onto the rules the evaluator applies. */
export function toConstitutionPolicy(
  parsed: ParsedDomainMd,
): ConstitutionPolicy {
  const fm = parsed.frontmatter;
  const disabledOverrides = Object.entries(fm.agent_default_mode.overrides)
    .filter(([, enabled]) => enabled === false)
    .map(([key]) => key);

  return {
    subject: fm.constitution.subject,
    status: fm.constitution.status,
    failurePolicy: fm.constitution.execution?.failure_policy ?? 'deny',
    modeCeiling: fm.agent_default_mode.mode,
    disabledOverrides,
    baseline: fm.rights.agent_baseline.require_explicit_grant_for,
    humanReviewRequiredFor: [
      ...fm.agent_default_mode.human_review_required_for,
      ...(fm.constitution.execution?.human_review_required_for ?? []),
    ],
    grants: fm.rights.entries,
    domainMdCid: parsed.digest.cid,
    documentRevision: fm.document_revision,
  };
}

// ---------------------------------------------------------------------------
// Request and decision
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  /** Who is acting — the entity, via a session and (optionally) a hired model. */
  principal: { did: string; sessionId: string; model?: string };
  /** The coarse class the action falls into; drives the ceiling and baseline. */
  action: RightsActionType;
  /** The specific operation, matched against a grant's `action`. */
  operation: string;
  /** Canonical identifier of what is being acted on. */
  object: string;
  /** Value the action would move, when it moves any. */
  value?: Amount | null;
  /** A capability token presented for this action, when one exists. */
  capabilityProof?: string;
  /** Reference to a signed human approval for this exact request. */
  reviewProofRef?: string;
  /** Digest of the request, bound by an approval proof. */
  requestDigest?: string;
  flowState?: string;
  claimType?: string;
  roles?: readonly string[];
  credentials?: readonly string[];
}

export type AuthorizationOutcome = 'permit' | 'deny' | 'manual_review_required';

export interface AuthorizationDecision {
  outcome: AuthorizationOutcome;
  /** Stable machine-readable reasons. Always at least one for a non-permit. */
  reasonCodes: string[];
  /** Rule and grant identifiers the decision rests on. */
  ruleRefs: string[];
  /** Conditions the caller must satisfy while acting on a permit. */
  obligations: Obligation[];
  time: TimeReading;
  matchedGrantId?: string;
  capability?: { proofDigest: string; revoked: boolean } | null;
}

export interface Obligation {
  kind: 'human_review' | 'value_ceiling' | 'audit';
  detail: string;
}

export interface CapabilityVerdict {
  valid: boolean;
  /** Digest identifying the proof in the decision record. */
  proofDigest: string;
  revoked: boolean;
  reason?: string;
}

export interface AuthorizeDeps {
  time: TimeSource;
  /**
   * Verifies a capability token against the grant it is claimed to satisfy.
   * Absent means no verifier is wired: a grant that requires a proof then
   * cannot be satisfied, and the request is denied rather than waved through.
   */
  verifyCapabilityProof?: (
    proof: string,
    expectation: {
      subject: string;
      object: string;
      action: string;
      value?: Amount | null;
    },
  ) => Promise<CapabilityVerdict>;
  /** Confirms a signed approval covers this exact request. */
  verifyReviewProof?: (ref: string, requestDigest?: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const REASON = {
  unrecognizedAction: 'unrecognized_action',
  constitutionNotInForce: 'constitution_not_in_force',
  clockUntrusted: 'clock_untrusted',
  modeCeiling: 'mode_ceiling_exceeded',
  overrideDisabled: 'override_disabled',
  denyGrant: 'deny_grant_matched',
  noMatchingGrant: 'no_matching_grant',
  grantNotYetValid: 'grant_not_yet_valid',
  grantExpired: 'grant_expired',
  proofMissing: 'capability_proof_missing',
  proofInvalid: 'capability_proof_invalid',
  proofRevoked: 'capability_revoked',
  verifierUnavailable: 'capability_verifier_unavailable',
  valueDenomMismatch: 'value_denomination_mismatch',
  valueExceedsGrant: 'value_exceeds_grant',
  flowStateMismatch: 'flow_state_mismatch',
  claimTypeMismatch: 'claim_type_mismatch',
  roleMissing: 'role_missing',
  credentialMissing: 'credential_missing',
  humanReviewRequired: 'human_review_required',
  reviewProofInvalid: 'review_proof_invalid',
} as const;

/**
 * Review triggers implied by an action class.
 *
 * A trigger only bites when the constitution also declares it, so a domain
 * that does not list `payment_release` is not silently given one.
 */
const ACTION_REVIEW_TRIGGERS: Readonly<
  Record<RightsActionType, readonly string[]>
> = Object.freeze({
  read: [],
  propose: [],
  write: [],
  evaluate: [],
  execute: ['irreversible_state_change'],
  pay: ['payment_release', 'high_value_action'],
  issue: ['credential_issuance'],
  mint: ['high_value_action'],
  transfer: ['payment_release', 'high_value_action'],
  govern: ['rights_change', 'controller_change'],
  delete: ['irreversible_state_change'],
  revoke: ['rights_change', 'irreversible_state_change'],
});

/** Constitution states under which effectful action may proceed at all. */
const OPERATIVE_STATUSES = new Set<ConstitutionStatus>([
  'draft',
  'adopted',
  'in_force',
]);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Decides whether a proposed action may execute.
 *
 * Never throws for a policy outcome — an unauthorized action is a decision,
 * not an exception, because every outcome has to be recordable.
 */
export async function authorize(
  request: AuthorizationRequest,
  policy: ConstitutionPolicy,
  deps: AuthorizeDeps,
): Promise<AuthorizationDecision> {
  const time = deps.time.now();
  const refuse = (
    reasonCodes: string[],
    ruleRefs: string[] = [],
  ): AuthorizationDecision => ({
    outcome: failureOutcome(policy.failurePolicy),
    reasonCodes,
    ruleRefs,
    obligations: [],
    time,
  });

  // 1. The action class must be one the format defines.
  if (!(request.action in ACTION_MIN_MODE)) {
    return refuse([REASON.unrecognizedAction], ['domain-md#8']);
  }

  const effectful = request.action !== 'read' && request.action !== 'propose';

  // A suspended or superseded constitution cannot authorize effects; a
  // not-applicable one never could.
  if (effectful && !OPERATIVE_STATUSES.has(policy.status)) {
    return refuse([REASON.constitutionNotInForce], ['constitution.status']);
  }

  // Expiry and revocation are meaningless against a clock nobody vouches for.
  if (effectful && !time.trusted) {
    return refuse([REASON.clockUntrusted], ['domain-md#8']);
  }

  // 2. Ceiling and overrides.
  const required = ACTION_MIN_MODE[request.action];
  if (MODE_RANK[policy.modeCeiling] < MODE_RANK[required]) {
    return refuse([REASON.modeCeiling], ['agent_default_mode.mode']);
  }
  const disabling = policy.disabledOverrides.find((key) =>
    (OVERRIDE_DISABLES[key] ?? []).includes(request.action),
  );
  if (disabling) {
    return refuse(
      [REASON.overrideDisabled],
      [`agent_default_mode.overrides.${disabling}`],
    );
  }

  // 3. Deny grants win outright, before any allow is considered.
  const candidates = policy.grants.filter((grant) =>
    matchesScope(grant, request),
  );
  const denyGrant = candidates.find((grant) => grant.effect === 'deny');
  if (denyGrant) {
    return {
      outcome: 'deny',
      reasonCodes: [REASON.denyGrant],
      ruleRefs: [denyGrant.id],
      obligations: [],
      time,
    };
  }

  // 4. Baseline actions need an allow grant that survives every condition.
  const obligations: Obligation[] = [];
  let matched: RightsGrant | undefined;
  let capability: AuthorizationDecision['capability'] = null;

  if (policy.baseline.includes(request.action)) {
    const allows = candidates.filter((grant) => grant.effect === 'allow');
    if (allows.length === 0) {
      return refuse(
        [REASON.noMatchingGrant],
        ['rights.agent_baseline.require_explicit_grant_for'],
      );
    }

    const failures: string[] = [];
    for (const grant of allows) {
      const verdict = await evaluateGrant(grant, request, time, deps);
      if (verdict.ok) {
        matched = grant;
        capability = verdict.capability;
        obligations.push(...verdict.obligations);
        break;
      }
      failures.push(...verdict.reasonCodes);
    }

    if (!matched) {
      return refuse(
        dedupe(failures),
        allows.map((grant) => grant.id),
      );
    }
  }

  const ruleRefs = matched ? [matched.id] : ['agent_default_mode.mode'];

  // 5. Human review — declared triggers and per-grant conditions alike.
  const reviewReasons = requiredReviewTriggers(request.action, policy);
  const grantRequiresReview = matched?.conditions.human_review === true;
  if (reviewReasons.length > 0 || grantRequiresReview) {
    const approved = request.reviewProofRef
      ? await verifyReview(request, deps)
      : { ok: false, reason: REASON.humanReviewRequired };
    if (!approved.ok) {
      return {
        outcome: 'manual_review_required',
        reasonCodes: dedupe([approved.reason, ...reviewReasons]),
        ruleRefs,
        obligations: [
          {
            kind: 'human_review',
            detail: grantRequiresReview
              ? `Grant '${matched?.id}' requires human review before this action.`
              : `Constitution requires human review for: ${reviewReasons.join(', ')}.`,
          },
        ],
        time,
        matchedGrantId: matched?.id,
        capability,
      };
    }
    obligations.push({
      kind: 'audit',
      detail: `Human review satisfied by proof '${request.reviewProofRef ?? ''}'.`,
    });
  }

  return {
    outcome: 'permit',
    reasonCodes: [],
    ruleRefs,
    obligations,
    time,
    matchedGrantId: matched?.id,
    capability,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failureOutcome(policy: FailurePolicy): AuthorizationOutcome {
  return policy === 'pause_and_escalate' ? 'manual_review_required' : 'deny';
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Whether a grant is about this request at all: same principal, same action
 * class, same operation, same object. Comparison is over canonical
 * identifiers — never display strings — with the format's wildcard forms.
 */
function matchesScope(
  grant: RightsGrant,
  request: AuthorizationRequest,
): boolean {
  if (grant.subject !== request.principal.did) return false;
  if (RIGHT_TYPE_TO_ACTION[grant.type] !== request.action) return false;
  if (grant.action !== '*' && grant.action !== request.operation) return false;
  return objectCovers(grant.object, request.object);
}

/** Exact match, a whole-namespace `*`, or a `/*` / `:*` prefix. */
function objectCovers(granted: string, claimed: string): boolean {
  if (granted === claimed || granted === '*') return true;
  for (const suffix of ['/*', ':*']) {
    if (granted.endsWith(suffix)) {
      const prefix = granted.slice(0, -1);
      if (claimed.startsWith(prefix)) return true;
    }
  }
  return false;
}

interface GrantVerdict {
  ok: boolean;
  reasonCodes: string[];
  obligations: Obligation[];
  capability: AuthorizationDecision['capability'];
}

async function evaluateGrant(
  grant: RightsGrant,
  request: AuthorizationRequest,
  time: TimeReading,
  deps: AuthorizeDeps,
): Promise<GrantVerdict> {
  const fail = (...reasonCodes: string[]): GrantVerdict => ({
    ok: false,
    reasonCodes,
    obligations: [],
    capability: null,
  });
  const { conditions } = grant;

  if (conditions.not_before) {
    const from = Date.parse(conditions.not_before);
    if (Number.isNaN(from) || time.epochMs < from)
      return fail(REASON.grantNotYetValid);
  }
  if (conditions.expiry) {
    const until = Date.parse(conditions.expiry);
    if (Number.isNaN(until) || time.epochMs >= until)
      return fail(REASON.grantExpired);
  }

  if (conditions.flow_state && conditions.flow_state !== request.flowState) {
    return fail(REASON.flowStateMismatch);
  }
  if (conditions.claim_type && conditions.claim_type !== request.claimType) {
    return fail(REASON.claimTypeMismatch);
  }
  if (
    conditions.role_required &&
    !(request.roles ?? []).includes(conditions.role_required)
  ) {
    return fail(REASON.roleMissing);
  }
  if (
    conditions.credential_required &&
    !(request.credentials ?? []).includes(conditions.credential_required)
  ) {
    return fail(REASON.credentialMissing);
  }

  const obligations: Obligation[] = [];
  if (conditions.max_value) {
    const value = request.value;
    if (!value) {
      // A ceiling with no declared value cannot be checked; carry it as an
      // obligation so the executor stays bound by it.
      obligations.push({
        kind: 'value_ceiling',
        detail: `At most ${conditions.max_value.amount} ${conditions.max_value.denom}.`,
      });
    } else {
      // Only identical denominations are comparable — conversion needs a
      // governed price policy this runtime deliberately does not have.
      if (value.denom !== conditions.max_value.denom)
        return fail(REASON.valueDenomMismatch);
      if (BigInt(value.amount) > BigInt(conditions.max_value.amount)) {
        return fail(REASON.valueExceedsGrant);
      }
    }
  }

  // A grant that names a capability format other than the document itself
  // must present a verifiable proof.
  const capability = await verifyCapability(grant, request, deps);
  if (!capability.ok) return fail(...capability.reasonCodes);

  return {
    ok: true,
    reasonCodes: [],
    obligations,
    capability: capability.capability,
  };
}

async function verifyCapability(
  grant: RightsGrant,
  request: AuthorizationRequest,
  deps: AuthorizeDeps,
): Promise<{
  ok: boolean;
  reasonCodes: string[];
  capability: AuthorizationDecision['capability'];
}> {
  // `policy` grants are satisfied by the constitution itself: the document is
  // the authority, so there is no separate token to check.
  if (grant.capability.format === 'policy') {
    return { ok: true, reasonCodes: [], capability: null };
  }

  const proof = request.capabilityProof ?? grant.capability.reference;
  if (!proof) {
    return { ok: false, reasonCodes: [REASON.proofMissing], capability: null };
  }
  if (!deps.verifyCapabilityProof) {
    return {
      ok: false,
      reasonCodes: [REASON.verifierUnavailable],
      capability: null,
    };
  }

  let verdict: CapabilityVerdict;
  try {
    verdict = await deps.verifyCapabilityProof(proof, {
      subject: grant.subject,
      object: request.object,
      action: request.operation,
      value: request.value ?? null,
    });
  } catch {
    return { ok: false, reasonCodes: [REASON.proofInvalid], capability: null };
  }

  if (verdict.revoked) {
    return {
      ok: false,
      reasonCodes: [REASON.proofRevoked],
      capability: { proofDigest: verdict.proofDigest, revoked: true },
    };
  }
  if (!verdict.valid) {
    return {
      ok: false,
      reasonCodes: [REASON.proofInvalid],
      capability: { proofDigest: verdict.proofDigest, revoked: false },
    };
  }
  return {
    ok: true,
    reasonCodes: [],
    capability: { proofDigest: verdict.proofDigest, revoked: false },
  };
}

function requiredReviewTriggers(
  action: RightsActionType,
  policy: ConstitutionPolicy,
): string[] {
  const declared = new Set(policy.humanReviewRequiredFor);
  return ACTION_REVIEW_TRIGGERS[action].filter((trigger) =>
    declared.has(trigger),
  );
}

async function verifyReview(
  request: AuthorizationRequest,
  deps: AuthorizeDeps,
): Promise<{ ok: boolean; reason: string }> {
  if (!deps.verifyReviewProof) {
    return { ok: false, reason: REASON.humanReviewRequired };
  }
  try {
    const ok = await deps.verifyReviewProof(
      request.reviewProofRef ?? '',
      request.requestDigest,
    );
    return ok
      ? { ok: true, reason: '' }
      : { ok: false, reason: REASON.reviewProofInvalid };
  } catch {
    return { ok: false, reason: REASON.reviewProofInvalid };
  }
}
