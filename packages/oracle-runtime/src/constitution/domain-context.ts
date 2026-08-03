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
  /**
   * What kind of entity this is, verbatim from the document: `oracle`,
   * `organisation`, `project`, `asset`, `deed`, or anything else the format
   * admits. The runtime does not branch on it — it is carried so decision
   * records and diagnostics can say what was being governed.
   */
  readonly entityType: string;
  /**
   * The declared agent this runtime is acting as, when the document declares
   * agents at all. Null when it declares none — a legitimate shape for a
   * simple entity, and distinct from "declares some but we could not tell
   * which", which never reaches here because it refuses the boot.
   */
  readonly agentId: string | null;
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

/**
 * How the runtime came to believe a given agent entry describes it — or why
 * it could not tell.
 *
 * **The entity is the agent for its own agentic functions.** An agentic
 * asset, deed, project, organisation or oracle acts as itself; this harness
 * is that entity's agency, not a separate party operating on its behalf. So
 * the entry whose id is the entity's own is the normal answer, whatever kind
 * of entity it is.
 *
 * A constitution may list further agents — other parties the entity works
 * with, or a second agentic function it runs as its own deployment. Those are
 * addressed by configuration, never inferred, because picking the wrong one
 * applies the wrong output bounds and escalates to a room nobody is watching.
 */
export type AgentResolution =
  | { kind: 'declared'; entry: DomainAgentEntry; via: 'configured' }
  | { kind: 'declared'; entry: DomainAgentEntry; via: 'entity-is-agent' }
  | { kind: 'declared'; entry: DomainAgentEntry; via: 'sole-agent' }
  | { kind: 'none' }
  | { kind: 'not-found'; agentId: string; declared: readonly string[] }
  | { kind: 'ambiguous'; declared: readonly string[] };

/**
 * Works out which declared agent this runtime is acting as.
 *
 * Resolution order:
 *
 * 1. `agentId` — the deployment said so, which is how an entity running more
 *    than one agentic function distinguishes them. Authoritative, and an id
 *    naming no declared agent is an error rather than a fallback: a runtime
 *    told it is an agent the constitution does not recognise must not quietly
 *    become a different one.
 * 2. The entry whose id is the entity's own — the entity acting for its own
 *    agentic functions. The normal case for every entity type.
 * 3. A single declared agent — unambiguous even when it is named separately
 *    from the entity.
 *
 * Anything else is ambiguous, and ambiguity is reported rather than resolved.
 */
export function resolveAgent(
  entries: readonly DomainAgentEntry[] | undefined,
  entityId: string,
  agentId?: string,
): AgentResolution {
  if (!entries || entries.length === 0) return { kind: 'none' };
  const declared = entries.map((entry) => entry.id);

  if (agentId) {
    const entry = entries.find((candidate) => candidate.id === agentId);
    return entry
      ? { kind: 'declared', entry, via: 'configured' }
      : { kind: 'not-found', agentId, declared };
  }

  const selfEntity = entries.find((entry) => entry.id === entityId);
  if (selfEntity) {
    return { kind: 'declared', entry: selfEntity, via: 'entity-is-agent' };
  }

  const sole = entries.length === 1 ? entries[0] : undefined;
  if (sole) return { kind: 'declared', entry: sole, via: 'sole-agent' };

  return { kind: 'ambiguous', declared };
}

/**
 * Freezes a value and everything reachable from it.
 *
 * `Object.freeze` is one level deep, which for a policy is barely a freeze at
 * all: freezing the grants array leaves every grant, and every grant's
 * `conditions` and `capability`, writable by anything holding a reference. The
 * constitution is the one input to a decision that no part of the running
 * system may alter, and a decision record citing `cid@revision` is a claim
 * that these exact rules applied — so the object has to actually be the bytes
 * that were loaded, not a mutable copy of them.
 *
 * Cycles are handled for correctness rather than because a parsed document
 * contains any: this runs once at boot, and a stack overflow there would be a
 * strange way to discover that a constitution referred to itself.
 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<string | symbol, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * Projects a parsed document into the value the runtime holds.
 *
 * Pure: no IO, no clock, no environment. Everything that could fail has
 * already failed in `parseDomainMdSubset`.
 *
 * The result is deeply frozen, including every grant and its nested
 * conditions. It is also a copy: freezing the projection would otherwise
 * freeze the caller's parsed document with it, which is a surprising thing to
 * do to something that was only passed in to be read.
 */
export function buildDomainContext(args: {
  parsed: ParsedDomainMd;
  enforcement: DomainEnforcement;
  source: string;
  anchorVerified?: boolean;
  /**
   * Which declared agent this runtime acts as. Resolved by the caller, which
   * is also where an unresolvable one becomes a boot refusal — this function
   * only projects, so it takes the answer rather than re-deriving it.
   */
  agent?: DomainAgentEntry;
}): DomainContext {
  const { parsed, enforcement, source } = args;
  const fm = parsed.frontmatter;
  const policy = toConstitutionPolicy(parsed);
  const self = args.agent;

  return deepFreeze({
    enforcement,
    subject: fm.constitution.subject,
    entityType: fm.domain.type,
    agentId: self?.id ?? null,
    profile: fm.conformance.profile,
    anchorVerified: args.anchorVerified ?? false,
    anchoring: fm.documents?.anchoring
      ? structuredClone(fm.documents.anchoring)
      : null,
    domainMdCid: parsed.digest.cid,
    domainMdSha256: parsed.digest.sha256,
    documentRevision: fm.document_revision,
    source,
    policy: {
      ...policy,
      disabledOverrides: [...policy.disabledOverrides],
      baseline: [...policy.baseline],
      humanReviewRequiredFor: [...policy.humanReviewRequiredFor],
      // Cloned, not aliased: these objects come straight out of the caller's
      // parsed document, and freezing them in place would freeze the document.
      grants: structuredClone(policy.grants),
    },
    advisory: {
      constitutionStatus: fm.constitution.status,
      constitutionType: fm.constitution.type,
      modeCeiling: fm.agent_default_mode.mode,
      requireExplicitGrantFor: [
        ...fm.rights.agent_baseline.require_explicit_grant_for,
      ],
      humanReviewRequiredFor: [...policy.humanReviewRequiredFor],
      criticalDoNot: [...(fm.critical_do_not ?? [])],
      forbiddenOutputs: [...(self?.forbidden_outputs ?? [])],
      escalationRoom: self?.escalation?.matrix_room ?? null,
      escalationRole: self?.escalation?.human_role ?? null,
    },
  });
}
