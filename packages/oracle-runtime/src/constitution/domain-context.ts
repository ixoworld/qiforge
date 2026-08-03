/**
 * @fileoverview The entity's constitution as the runtime holds it: one frozen
 * value, built once at boot, read by the gate on every tool call and by the
 * prompt composer once per turn.
 *
 * Two consumers with different needs, so the shape carries both:
 *
 * - The **policy** projection is what `authorize()` evaluates. It is the
 *   decision surface, and nothing outside it can affect a verdict.
 * - The **advisory** fields are what the model is told. They shape what it
 *   proposes; they decide nothing. Keeping them in one value — rather than
 *   letting the prompt read the document separately — is what stops the two
 *   layers from drifting into disagreement about what the constitution says.
 *
 * The document is never reloaded. `domain.md` change control puts amendment
 * under governance, and a runtime that re-reads its own constitution mid-flight
 * would let a file write do what governance is meant to do. New revisions
 * arrive through a restart.
 */
import { toConstitutionPolicy, type ConstitutionPolicy } from './authorize.js';
import type {
  AgentMode,
  Anchoring,
  ConformanceProfile,
  ConstitutionStatus,
  DomainAgentEntry,
  ParsedDomainMd,
} from './schema.js';

/**
 * How the runtime treats a constitution it cannot fully vouch for.
 *
 * `strict` is the deployed posture: the document must be anchored, and an
 * action the runtime cannot classify is refused. `permissive` is for
 * development against an unanchored draft — the gate still evaluates every
 * call, it just tolerates an unproven document and an unclassified tool.
 *
 * Note what neither mode does: turn the gate off. Enforcement is not a
 * feature flag.
 */
export type DomainEnforcement = 'strict' | 'permissive';

/** Profiles that assert the document is bound to canonical state. */
const ANCHORED_PROFILES: ReadonlySet<ConformanceProfile> = new Set([
  'anchored',
  'runtime',
]);

/** True when the profile claims the document is anchored to canonical state. */
export function isAnchoredProfile(profile: ConformanceProfile): boolean {
  return ANCHORED_PROFILES.has(profile);
}

/**
 * What the runtime knows about its own constitution.
 *
 * Deeply frozen. A gate that could be reconfigured by anything holding a
 * reference to it would not be a gate.
 */
export interface DomainContext {
  /** Enforcement posture this runtime booted under. */
  readonly enforcement: DomainEnforcement;
  /** The subject the constitution governs — the entity's own identifier. */
  readonly subject: string;
  /** Assurance profile the document declares. */
  readonly profile: ConformanceProfile;
  /**
   * Whether the declared anchor was actually checked against canonical state,
   * rather than accepted on the document's own say-so. Recorded rather than
   * assumed: a decision record that cites an unverified anchor should say so.
   */
  readonly anchorVerified: boolean;
  /** The anchoring block, when the document declares one. */
  readonly anchoring: Anchoring | null;
  /** Content address and revision of the exact bytes in force. */
  readonly domainMdCid: string;
  readonly domainMdSha256: string;
  readonly documentRevision: string;
  /** Where the bytes were read from — for boot diagnostics, not authority. */
  readonly source: string;

  /** The decision surface. Everything `authorize()` is allowed to consider. */
  readonly policy: ConstitutionPolicy;

  /**
   * Advisory only — composed into the prompt so the model proposes within the
   * constitution rather than against it. None of this gates anything.
   */
  readonly advisory: {
    readonly constitutionStatus: ConstitutionStatus;
    readonly constitutionType: string;
    readonly modeCeiling: AgentMode;
    readonly requireExplicitGrantFor: readonly string[];
    readonly humanReviewRequiredFor: readonly string[];
    readonly criticalDoNot: readonly string[];
    readonly forbiddenOutputs: readonly string[];
    readonly escalationRoom: string | null;
    readonly escalationRole: string | null;
  };
}

/** The runtime's own agent entry, when the document declares one. */
function selfAgentEntry(
  entries: readonly DomainAgentEntry[] | undefined,
  subject: string,
): DomainAgentEntry | undefined {
  if (!entries || entries.length === 0) return undefined;
  // Prefer an entry that names the subject; otherwise a single declared agent
  // is unambiguously this runtime. More than one and no match is ambiguous, so
  // nothing is assumed — the advisory block simply carries less.
  return (
    entries.find((entry) => entry.id === subject) ??
    (entries.length === 1 ? entries[0] : undefined)
  );
}

/**
 * Projects a parsed document into the value the runtime holds.
 *
 * Pure: no IO, no clock, no environment. Everything that could fail has
 * already failed in `parseDomainMdSubset`.
 */
export function buildDomainContext(args: {
  parsed: ParsedDomainMd;
  enforcement: DomainEnforcement;
  source: string;
  anchorVerified?: boolean;
}): DomainContext {
  const { parsed, enforcement, source } = args;
  const fm = parsed.frontmatter;
  const policy = toConstitutionPolicy(parsed);
  const self = selfAgentEntry(fm.agents?.entries, fm.domain.id);

  return Object.freeze({
    enforcement,
    subject: fm.constitution.subject,
    profile: fm.conformance.profile,
    anchorVerified: args.anchorVerified ?? false,
    anchoring: fm.documents?.anchoring
      ? Object.freeze({ ...fm.documents.anchoring })
      : null,
    domainMdCid: parsed.digest.cid,
    domainMdSha256: parsed.digest.sha256,
    documentRevision: fm.document_revision,
    source,
    policy: Object.freeze({
      ...policy,
      disabledOverrides: Object.freeze([...policy.disabledOverrides]),
      baseline: Object.freeze([...policy.baseline]),
      humanReviewRequiredFor: Object.freeze([...policy.humanReviewRequiredFor]),
      grants: Object.freeze([...policy.grants]),
    }),
    advisory: Object.freeze({
      constitutionStatus: fm.constitution.status,
      constitutionType: fm.constitution.type,
      modeCeiling: fm.agent_default_mode.mode,
      requireExplicitGrantFor: Object.freeze([
        ...fm.rights.agent_baseline.require_explicit_grant_for,
      ]),
      humanReviewRequiredFor: Object.freeze([...policy.humanReviewRequiredFor]),
      criticalDoNot: Object.freeze([...(fm.critical_do_not ?? [])]),
      forbiddenOutputs: Object.freeze([...(self?.forbidden_outputs ?? [])]),
      escalationRoom: self?.escalation?.matrix_room ?? null,
      escalationRole: self?.escalation?.human_role ?? null,
    }),
  });
}
