/**
 * @fileoverview Zod schemas for the subset of the `domain.md` format the
 * runtime enforces at request time.
 *
 * `domain.md` is the machine-readable operating index for an IXO entity
 * domain: it declares where authority lives, what an agent may propose, and
 * what it must never do without an explicit grant. The full format covers far
 * more than the runtime needs (services, resources, claims contracts, PODs,
 * flows, linked entities, privacy, graph policy). Only the blocks that
 * participate in a per-action authorization decision are modelled here:
 *
 * - `conformance`   — spec version + assurance profile
 * - `domain`        — identity of the subject this document governs
 * - `documents.anchoring` — how the index binds to canonical IID state
 * - `constitution`  — status, subject and type of the governing normative system
 * - `agent_default_mode` — the capability ceiling and human-review triggers
 * - `rights`        — the baseline and the explicit grants
 * - `accounts`      — spending policy for value-bearing actions
 * - `agents`        — declared agents, their output bounds and escalation route
 * - `critical_do_not` — the prohibitions surfaced verbatim to the model
 *
 * Unmodelled blocks are preserved verbatim under `rest` so nothing is lost on
 * a round trip and later phases can widen the subset without a format change.
 *
 * The upstream JSON Schema (`urn:ixo:domain-md:schema:1.0.0-rc.3`) is
 * normative. These schemas mirror it; where upstream is permissive
 * (`type: object` with no properties) they stay permissive too, so a document
 * that validates upstream also parses here.
 */
import { z } from 'zod';

/** The `domain.md` specification version this runtime understands. */
export const SUPPORTED_SPEC_VERSION = '1.0.0-rc.3';

/** The schema URI that must accompany {@link SUPPORTED_SPEC_VERSION}. */
export const SUPPORTED_SCHEMA_URI = `urn:ixo:domain-md:schema:${SUPPORTED_SPEC_VERSION}`;

// ---------------------------------------------------------------------------
// Primitives — mirror the upstream `$defs`
// ---------------------------------------------------------------------------

const didSchema = z
  .string()
  .regex(/^did:ixo:[A-Za-z0-9._:%-]+$/, 'expected a did:ixo identifier');

const draftIdSchema = z
  .string()
  .regex(
    /^(did:ixo:[A-Za-z0-9._:%-]+|urn:uuid:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/,
    'expected a did:ixo identifier or a urn:uuid draft identity',
  );

const cidSchema = z
  .string()
  .regex(/^b[a-z2-7]{10,}$/, 'expected a base32 CIDv1');

const nonEmptyString = z.string().min(1).max(10_000);

/**
 * An unsigned base-10 integer in base units, paired with its denomination.
 * Comparison is only meaningful between identical denominations — conversion
 * requires a governed price policy the runtime deliberately does not have.
 */
export const amountSchema = z.object({
  amount: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, 'expected an unsigned base-10 integer'),
  denom: z.string().regex(/^[A-Za-z0-9/._:-]+$/),
});

export type Amount = z.infer<typeof amountSchema>;

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

/**
 * The action classes the baseline (`rights.agent_baseline`) is expressed in.
 *
 * These are coarser than a right's `type`: many right types collapse onto one
 * class (`pay` covers `pay` and `escrow_release`). A request is classified
 * into exactly one of these before any grant is consulted.
 */
export const RIGHTS_ACTION_TYPES = [
  'read',
  'propose',
  'write',
  'evaluate',
  'execute',
  'pay',
  'issue',
  'mint',
  'transfer',
  'govern',
  'delete',
  'revoke',
] as const;

export type RightsActionType = (typeof RIGHTS_ACTION_TYPES)[number];

export const rightsActionTypeSchema = z.enum(RIGHTS_ACTION_TYPES);

/**
 * Maps a right's declared `type` onto the action class it authorizes.
 *
 * A right type absent from this table is not recognized, and a request that
 * would need it is denied rather than guessed at — an unknown type is an
 * unbounded type.
 */
export const RIGHT_TYPE_TO_ACTION: Readonly<Record<string, RightsActionType>> =
  Object.freeze({
    read: 'read',
    ownership: 'read',
    control: 'govern',
    write: 'write',
    update_iid: 'govern',
    link_entity: 'write',
    submit_claim: 'write',
    evaluate_claim: 'evaluate',
    verify_claim: 'evaluate',
    dispute: 'evaluate',
    issue_credential: 'issue',
    mint: 'mint',
    burn: 'mint',
    transfer: 'transfer',
    pay: 'pay',
    escrow_release: 'pay',
    vote: 'govern',
    delegate: 'govern',
    manage_agent: 'govern',
    manage_account: 'govern',
  });

// ---------------------------------------------------------------------------
// Agent operating modes
// ---------------------------------------------------------------------------

export const AGENT_MODES = [
  'read_only',
  'propose_only',
  'bounded_evaluate',
  'bounded_execute',
] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

export const agentModeSchema = z.enum(AGENT_MODES);

/** Ordering of the mode ceiling — a higher rank subsumes every lower one. */
export const MODE_RANK: Readonly<Record<AgentMode, number>> = Object.freeze({
  read_only: 0,
  propose_only: 1,
  bounded_evaluate: 2,
  bounded_execute: 3,
});

/**
 * The minimum mode that permits an action class.
 *
 * `read` through `execute` are the four rows of the specification's capability
 * table. Every remaining class (value movement, issuance, governance,
 * destruction) is never implied by the mode at all: those require
 * `bounded_execute` *and* an explicit grant. The specification's table marks
 * that row as forbidden at every mode with the footnote "never implied by
 * mode"; requiring the top mode as well as a grant is the reading that fails
 * closed, so a `read_only` agent cannot move value on the strength of a stale
 * grant alone.
 */
export const ACTION_MIN_MODE: Readonly<Record<RightsActionType, AgentMode>> =
  Object.freeze({
    read: 'read_only',
    propose: 'propose_only',
    evaluate: 'bounded_evaluate',
    execute: 'bounded_execute',
    write: 'bounded_execute',
    pay: 'bounded_execute',
    issue: 'bounded_execute',
    mint: 'bounded_execute',
    transfer: 'bounded_execute',
    govern: 'bounded_execute',
    delete: 'bounded_execute',
    revoke: 'bounded_execute',
  });

/**
 * Override keys that disable a capability class outright.
 *
 * Upstream pins these four to `const: false` — they exist only to switch a
 * capability off, never on. An override that tries to enable something is a
 * ceiling raise and fails linting.
 *
 * `change_rubrics` has no action class of its own: rubric protection is
 * expressed as grants scoped to rubric objects, so it is intentionally absent
 * from this table.
 */
export const OVERRIDE_DISABLES: Readonly<
  Record<string, readonly RightsActionType[]>
> = Object.freeze({
  move_value: Object.freeze(['pay', 'transfer', 'mint'] as const),
  issue_credentials: Object.freeze(['issue'] as const),
  change_rights: Object.freeze(['govern', 'revoke', 'delete'] as const),
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export const conformanceSchema = z.object({
  spec_version: z.string(),
  schema: z.string(),
  profile: z.enum([
    'authoring_draft',
    'persisted_draft',
    'anchored',
    'runtime',
  ]),
});

export type ConformanceProfile = z.infer<typeof conformanceSchema>['profile'];

export const domainSchema = z
  .object({
    id: draftIdSchema,
    iid: didSchema.nullable(),
    type: nonEmptyString,
    status: z.enum(['draft', 'active', 'paused', 'deprecated', 'archived']),
    purpose: nonEmptyString,
    operating_boundary: nonEmptyString,
  })
  .loose();

export const anchoringSchema = z.object({
  method: z.enum([
    'none',
    'iid_linked_resource',
    'content_address',
    'resolver',
  ]),
  reference: z.string().nullable(),
  cid: cidSchema.nullable(),
  verified_at: z.string().nullable(),
});

export type Anchoring = z.infer<typeof anchoringSchema>;

export const documentsSchema = z
  .object({
    anchoring: anchoringSchema,
  })
  .loose();

/**
 * How the domain wants an enforcement failure handled: refuse outright, or
 * hold the action and route it to a human. Anything else is not a choice the
 * document may express — a failure never falls through to permitted.
 */
export const failurePolicySchema = z.enum(['deny', 'pause_and_escalate']);

export type FailurePolicy = z.infer<typeof failurePolicySchema>;

export const constitutionExecutionSchema = z
  .object({
    mode: z.string().optional(),
    enforcement_points: z.array(z.string()).optional(),
    failure_policy: failurePolicySchema.optional(),
    human_review_required_for: z.array(z.string()).optional(),
  })
  .loose();

export const constitutionSchema = z
  .object({
    status: z.enum([
      'not_applicable',
      'draft',
      'adopted',
      'in_force',
      'suspended',
      'superseded',
    ]),
    reason: z.string().nullable().optional(),
    subject: draftIdSchema,
    type: nonEmptyString,
    execution: constitutionExecutionSchema.optional(),
  })
  .loose();

export type ConstitutionStatus = z.infer<typeof constitutionSchema>['status'];

export const agentDefaultModeSchema = z.object({
  mode: agentModeSchema,
  /**
   * Capability switches. Upstream pins the four known keys to `false`; any
   * other key is a boolean whose `false` value also reads as "disabled".
   */
  overrides: z.record(z.string(), z.boolean()),
  human_review_required_for: z.array(z.string()),
});

export const rightConditionsSchema = z
  .object({
    flow_state: z.string().nullable(),
    claim_type: z.string().nullable(),
    max_value: amountSchema.nullable(),
    not_before: z.string().nullable(),
    expiry: z.string().nullable(),
    role_required: z.string().nullable(),
    credential_required: z.string().nullable(),
    human_review: z.boolean(),
  })
  .loose();

export type RightConditions = z.infer<typeof rightConditionsSchema>;

export const rightSchema = z
  .object({
    id: nonEmptyString,
    type: nonEmptyString,
    effect: z.enum(['allow', 'deny']),
    subject: didSchema,
    object: nonEmptyString,
    action: nonEmptyString,
    capability: z
      .object({
        format: nonEmptyString,
        reference: z.string().nullable(),
      })
      .loose(),
    conditions: rightConditionsSchema,
    revocation: z.object({}).loose(),
    audit: z.object({}).loose(),
  })
  .loose();

export type RightsGrant = z.infer<typeof rightSchema>;

export const rightsSchema = z.object({
  agent_baseline: z
    .object({
      require_explicit_grant_for: z.array(z.string()),
    })
    .loose(),
  entries: z.array(rightSchema),
});

export const spendingPolicySchema = z
  .object({
    max_single_transaction: amountSchema.nullable(),
    daily_limit: amountSchema.nullable(),
    allowed_recipients: z.array(z.string()),
    requires_claim: z.boolean(),
    requires_udid: z.boolean(),
    requires_human_approval: z.boolean(),
  })
  .loose();

export type SpendingPolicy = z.infer<typeof spendingPolicySchema>;

export const accountSchema = z
  .object({
    name: nonEmptyString,
    address: nonEmptyString,
    chain_id: nonEmptyString,
    owner: didSchema,
    spending_policy: spendingPolicySchema,
  })
  .loose();

export type DomainAccount = z.infer<typeof accountSchema>;

export const accountsSchema = z
  .object({
    entries: z.array(accountSchema),
  })
  .loose();

export const agentEntrySchema = z
  .object({
    id: nonEmptyString,
    name: z.string().optional(),
    type: z.string().optional(),
    permitted_outputs: z.array(z.string()).optional(),
    forbidden_outputs: z.array(z.string()).optional(),
    escalation: z
      .object({
        human_role: z.string().optional(),
        matrix_room: z.string().nullable().optional(),
        timeout: z.string().nullable().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type DomainAgentEntry = z.infer<typeof agentEntrySchema>;

export const agentsSchema = z
  .object({
    entries: z.array(agentEntrySchema),
  })
  .loose();

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The enforced subset of a `domain.md` frontmatter. Blocks the runtime does
 * not evaluate are still accepted (and retained by the parser) — this schema
 * describes what authorization reads, not what the format allows.
 */
export const domainMdFrontmatterSchema = z
  .object({
    version: z.string(),
    kind: z.literal('domain.md'),
    conformance: conformanceSchema,
    document_revision: nonEmptyString,
    name: z.string().optional(),
    domain: domainSchema,
    documents: documentsSchema.optional(),
    constitution: constitutionSchema,
    agent_default_mode: agentDefaultModeSchema,
    rights: rightsSchema,
    accounts: accountsSchema.optional(),
    agents: agentsSchema.optional(),
    critical_do_not: z.array(z.string()).optional(),
  })
  .loose();

export type DomainMdFrontmatter = z.infer<typeof domainMdFrontmatterSchema>;

/** A parsed `domain.md`: validated frontmatter, prose body, and byte identity. */
export interface ParsedDomainMd {
  frontmatter: DomainMdFrontmatter;
  /** Markdown following the frontmatter, verbatim. */
  body: string;
  /** Digest of the exact bytes parsed. */
  digest: DomainMdDigest;
}

/** Content addresses over the exact UTF-8 bytes of a `domain.md`. */
export interface DomainMdDigest {
  sha256: string;
  cid: string;
}
