import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';
import {
  isEvalsApiError,
  labelOutcome,
  type EvalsEngineClient,
  type EvaluationJob,
} from './evals-client.js';
import { captureTrace } from './evals-trace.js';

/**
 * The hosted evaluate endpoint rejects requests with unknown keys at every
 * nesting level, so these schemas mirror the API's key allowlists exactly
 * (zod strips unrecognized keys before the request is built).
 */
const deedSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('Deed identifier the claim is made against. Required.'),
  aud: z
    .string()
    .min(1)
    .describe('Audience the determination is issued for. Required.'),
});

const traceSchema = z.object({
  uri: z.string().min(1).describe('URI of the execution trace.'),
  cid: z.string().min(1).describe('Content identifier (CID) of the trace.'),
});

const claimSchema = z.object({
  id: z.string().min(1).describe('Unique claim identifier. Required.'),
  cap: z
    .string()
    .min(1)
    .describe('Capability the claimant asserts it acted under. Required.'),
  jti: z
    .string()
    .min(1)
    .describe(
      'Replay nonce — must be unique per submission. Reusing a jti is rejected with a 409. Required.',
    ),
  automatedAgent: z
    .boolean()
    .describe(
      'True when the claimant is an automated agent (enables trace requirements). Required.',
    ),
  proposedPatch: z
    .record(z.string(), z.unknown())
    .describe(
      'The state change the claim proposes (object). Keys are checked against the rubric patchAllowlist. Required.',
    ),
  claimType: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Claim-type key on the governance maturity ladder (e.g. "coding.task").',
    ),
  collectionId: z
    .string()
    .min(1)
    .optional()
    .describe('On-chain claim collection binding, when governed.'),
  safetyViolation: z
    .boolean()
    .optional()
    .describe('Flag a known safety violation (forces rejection).'),
  trace: traceSchema
    .optional()
    .describe(
      'Execution trace reference. Required by rubrics with requireTraceForAutomated when automatedAgent is true.',
    ),
  evidencePenaltyCodes: z
    .array(z.string())
    .optional()
    .describe('Pre-assessed evidence penalty codes to apply.'),
});

const rubricSchema = z.object({
  rubricVersionId: z
    .string()
    .min(1)
    .describe('Rubric version identifier. Required.'),
  thresholdBps: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .describe(
      'Pass threshold in basis points (0-10000, e.g. 7000 = 70%). Required.',
    ),
  mode: z
    .enum(['fail_any_dimension', 'fail_average'])
    .describe(
      'Gate mode: fail if ANY dimension is below threshold, or fail on the average. Required.',
    ),
  patchAllowlist: z
    .array(z.string())
    .describe(
      'Top-level keys the proposedPatch may touch. Patches outside this list are rejected. Required.',
    ),
  requireTraceForAutomated: z
    .boolean()
    .describe(
      'Whether automated agents must supply a claim.trace reference. Required.',
    ),
  penaltyTableId: z.string().optional().describe('Penalty table to apply.'),
  hardRejectRules: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Hard-reject rule set (object).'),
  patchSchemaId: z.string().optional().describe('Registered patch schema id.'),
  patchSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Inline JSON-schema-shaped object constraining the patch.'),
  authorizedCaps: z
    .array(z.string())
    .optional()
    .describe('Capabilities authorized to make this kind of claim.'),
  evidence: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Rubric evidence policy (object).'),
});

const evidenceSchema = z.object({
  packet: z
    .record(z.string(), z.unknown())
    .describe('Evidence packet (object). Required when evidence is supplied.'),
  envelope: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Signed evidence envelope.'),
  envelopes: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('Multiple signed evidence envelopes.'),
});

const evaluateSchema = z.object({
  deed: deedSchema.describe('What the claim is about. Required.'),
  claim: claimSchema.describe('The claim under evaluation. Required.'),
  rubric: rubricSchema.describe('The governing rubric config. Required.'),
  evidence: evidenceSchema
    .optional()
    .describe('Supporting evidence for evidence-based verification.'),
  claimCredential: z
    .string()
    .min(1)
    .optional()
    .describe('Compact VC-JWT claim credential.'),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(55)
    .default(15)
    .describe(
      'How long to wait for the evaluation to complete before returning (0-55s, default 15). If it is still running when the wait expires, the tool returns status "pending" — check again later with get_evaluation_status.',
    ),
  attachTrace: z
    .boolean()
    .default(false)
    .describe(
      "Capture this conversation turn's tool-call trace, persist it to the session's Matrix room, and attach it as claim.trace {uri, cid}. Set true when the rubric has requireTraceForAutomated and claim.automatedAgent is true but no trace is supplied. Ignored when claim.trace is already provided.",
    ),
});

const claimIdSchema = z.object({
  claimId: z
    .string()
    .min(1)
    .describe(
      'The claim identifier used at submission time (claim.id). Required.',
    ),
});

const auditSchema = claimIdSchema.extend({
  includeStepPayloads: z
    .boolean()
    .default(false)
    .describe(
      'Include full step payloads in the audit trail. Defaults to false (step ids, timestamps, and types only) to keep responses small.',
    ),
});

const maturitySchema = z.object({
  claimType: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Claim type to look up (e.g. "coding.task"). Omit to list the full maturity ladder.',
    ),
});

const listReviewsSchema = z.object({});

const listRubricsSchema = z.object({
  claimType: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Filter to rubrics observed for this claim type (e.g. "coding_task.completed").',
    ),
  rubricVersionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Fetch one rubric's full config instead of the listing. Use the exact rubricVersionId from a previous listing.",
    ),
});

/**
 * Project a job into the compact view the agent reasons over. The raw
 * resultSummary nests the full evaluation report; this keeps the verdict,
 * dimension scores, and follow-up signals and drops the bulky internals.
 */
function summarizeJob(
  job: EvaluationJob,
  claimId: string,
): Record<string, unknown> {
  const summary = asRecord(job.resultSummary);
  const res = asRecord(summary?.res);
  const report = asRecord(summary?.evaluationReport);
  const evidence = asRecord(report?.evidence);
  const verification = asRecord(evidence?.verificationResult);
  const applyResult = asRecord(summary?.applyResult);
  const outcome = typeof res?.outcome === 'number' ? res.outcome : undefined;

  return {
    claimId,
    jobId: job.id,
    status: job.status,
    ...(job.error ? { error: job.error } : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
    ...(outcome === undefined
      ? {}
      : { outcome, outcomeLabel: labelOutcome(outcome) }),
    ...(res?.reason === undefined ? {} : { reason: res.reason }),
    ...(report?.gateReason === undefined
      ? {}
      : { gateReason: report.gateReason }),
    ...(report?.dimensions === undefined
      ? {}
      : { dimensions: report.dimensions }),
    ...(report?.appliedPenaltyCodes === undefined
      ? {}
      : { appliedPenaltyCodes: report.appliedPenaltyCodes }),
    ...(verification
      ? {
          evidenceVerdict: verification.verdict,
          maturityRung: verification.maturityRung,
          permittedActions: verification.permittedActions,
        }
      : {}),
    ...(applyResult ? { applyResult } : {}),
    udidIssued: typeof summary?.compactJws === 'string',
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const EVALUATE_DESCRIPTION = `Submit a claim to the IXO Evals Engine for rubric-based evaluation and wait for the verdict.

WHAT IT DOES:
- Submits { deed, claim, rubric, evidence? } to the engine's evaluation pipeline (rubric compilation → dimension scoring → gate decision → evidence verdict).
- Waits up to waitSeconds (default 15) for the async evaluation job to finish.
- Returns the verdict: outcome code + label (0 pending, 1 approved, 2 rejected, 3 disputed, 4 invalidated, 5 flagged), reason, per-dimension scores in basis points, applied penalty codes, and whether a signed UDID receipt was issued.

REQUIRED STRUCTURE (all four claim fields and five rubric fields are mandatory):
{
  "deed":   { "id": "deed-1", "aud": "did:example:verifier" },
  "claim":  { "id": "claim-1", "cap": "urn:cap:deploy", "jti": "unique-nonce-1",
              "automatedAgent": true, "proposedPatch": { "status": "done" } },
  "rubric": { "rubricVersionId": "rubric-v1", "thresholdBps": 7000,
              "mode": "fail_any_dimension", "patchAllowlist": ["status"],
              "requireTraceForAutomated": false }
}

IMPORTANT:
- claim.jti must be UNIQUE per submission — the engine rejects replays (409 jti conflict). Generate a fresh one every time.
- If status comes back "pending", the evaluation is still running: use get_evaluation_status with the claimId later instead of resubmitting.
- A 4xx response is returned as { "error": "<code>" } — fix the request shape and retry with a fresh jti.
- Optional: evidence ({ packet, envelope?, envelopes? }) for evidence-based verification; claim.trace ({ uri, cid }) when the rubric requires traces for automated agents; claim.claimType to bind to the governance maturity ladder.
- When the rubric has requireTraceForAutomated and you have no trace, set attachTrace: true — this tool captures the current turn's tool-call trace, stores it in the session's Matrix room, and attaches claim.trace automatically.
- If you supply evidence, evidence.packet.claimId MUST equal claim.id (checked before submission).`;

const STATUS_DESCRIPTION = `Check the status and verdict of a previously submitted claim evaluation.

Provide the claimId used at submission time (claim.id). Returns the job status (pending | processing | completed | failed), the verdict once complete (outcome, outcomeLabel, reason, dimension scores, penalty codes), whether a UDID was issued, and whether the claim sits in the manual human-review queue.

Use this after evaluate_claim returned status "pending", or to re-check any earlier claim. Returns { "error": "claim_job_not_found" } for unknown claim ids.`;

const UDID_DESCRIPTION = `Fetch the signed UDID receipt (verifiable determination) for an evaluated claim.

Provide the claimId. Returns { claimId, compactJws, payload } where compactJws is the signed JWS receipt (share this as the verifiable proof of the determination) and payload contains the decoded claims (iss, aud, sub, jti, act, res). Anyone can verify the signature against the engine's public keys at /v1/issuer-keys.

Returns { "error": "udid_not_issued" } while the evaluation is still running or when no UDID was issued — check get_evaluation_status first.`;

const AUDIT_DESCRIPTION = `Fetch the tamper-evident audit bundle for an evaluated claim.

Provide the claimId. Returns the oracle.evaluation-audit.v1 bundle: the machine result summary plus the ordered step trail of the evaluation pipeline. By default step payloads are omitted (id, timestamp, and type only) to keep the response small — set includeStepPayloads to true when you need the full step contents.

Use this when the user asks WHY a claim was approved/rejected or needs an auditable trail. Returns { "error": "claim_job_not_found" } for unknown claim ids.`;

const MATURITY_DESCRIPTION = `Look up the governance maturity ladder of the Evals Engine.

Every claim type sits on a rung: "advisory" (verdicts are recommendations), "assisted" (verdicts execute with human confirmation), or "autonomous" (verdicts execute automatically). Pass claimType (e.g. "coding.task") for one claim type — returns { claimType, rung, registered, gatePolicyId, records }. Omit claimType to list the full ladder.

Use this to explain how much authority the engine's verdicts carry for a claim type. Rung changes (register/promote/demote) are governance actions outside this tool's scope.`;

const RUBRICS_DESCRIPTION = `Discover evaluation rubrics known to the Evals Engine — use this BEFORE evaluate_claim instead of asking the user for rubric parameters.

WHAT IT RETURNS:
- Without arguments: every stored rubric (rubricVersionId, contentCid, thresholdBps, mode, claimTypes, governedCollections) plus all governed collection bindings the engine's resolver can enumerate (collectionId, protocol LinkedResource id, content CID, serviceEndpoint, verified).
- With claimType: only rubrics observed for that claim type.
- With rubricVersionId: that rubric's FULL config — pass it directly as the rubric argument of evaluate_claim.

Governed collections reject rubric content that does not match their on-chain binding, so submitting a discovered rubric verbatim is the reliable path. Returns { "error": "rubric_not_found" } for unknown ids.`;

const REVIEWS_DESCRIPTION = `List claim evaluations waiting for manual human review.

Takes no arguments. Returns { claimIds, cases } — the claims flagged into the human-review queue and their pending review cases (case id, subject, rubric, initial machine outcome and reason).

Use this to report what is stuck awaiting a human decision. Adjudicating a case is a human reviewer action performed against the engine directly — this plugin deliberately does not expose it.`;

/**
 * Build the six Evals Engine tools, closing over the configured client.
 * Handlers thread `ctx.abortSignal` into every HTTP call so a cancelled
 * request also cancels in-flight polling.
 */
export function createEvalsTools(client: EvalsEngineClient): PluginTool[] {
  const evaluateClaim = tool(
    async (rawArgs, ctx) => {
      const { waitSeconds, attachTrace, ...request } =
        evaluateSchema.parse(rawArgs);

      // Catch the claim-binding mismatch locally: the engine only rejects it
      // inside the async evaluation job, as a hard invalid_evidence verdict.
      const packetClaimId = asRecord(request.evidence?.packet)?.claimId;
      if (
        typeof packetClaimId === 'string' &&
        packetClaimId !== request.claim.id
      ) {
        return {
          error: 'evidence_claim_binding_mismatch',
          guidance: `evidence.packet.claimId ("${packetClaimId}") must equal claim.id ("${request.claim.id}") or the engine rejects the evidence as invalid.`,
        };
      }

      if (attachTrace && !request.claim.trace) {
        const trace = await captureTrace(ctx);
        if ('error' in trace) return trace;
        request.claim = { ...request.claim, trace };
      }

      const accepted = await client.evaluateClaim(request, ctx.abortSignal);
      if (isEvalsApiError(accepted)) return accepted;

      if (accepted.status === 'failed') {
        return {
          claimId: accepted.claimId,
          jobId: accepted.jobId,
          status: 'failed',
          error: accepted.error,
        };
      }

      const job = await client.waitForJob(
        accepted.jobId,
        accepted.status === 'completed' ? 0 : waitSeconds,
        ctx.abortSignal,
      );
      if (isEvalsApiError(job)) return job;
      if (job.status === 'pending' || job.status === 'processing') {
        return {
          claimId: accepted.claimId,
          jobId: accepted.jobId,
          status: job.status,
          guidance: `Evaluation still running after ${waitSeconds}s. Check later with get_evaluation_status using claimId "${accepted.claimId}".`,
        };
      }
      return summarizeJob(job, accepted.claimId);
    },
    {
      name: 'evaluate_claim',
      description: EVALUATE_DESCRIPTION,
      schema: evaluateSchema,
    },
  );

  const getStatus = tool(
    async (rawArgs, ctx) => {
      const { claimId } = claimIdSchema.parse(rawArgs);
      const status = await client.getClaimStatus(claimId, ctx.abortSignal);
      if (isEvalsApiError(status)) return status;
      return {
        ...summarizeJob(status.job, claimId),
        manualReviewQueue: status.manualReviewQueue,
      };
    },
    {
      name: 'get_evaluation_status',
      description: STATUS_DESCRIPTION,
      schema: claimIdSchema,
    },
  );

  const getUdid = tool(
    async (rawArgs, ctx) => {
      const { claimId } = claimIdSchema.parse(rawArgs);
      return client.getUdid(claimId, ctx.abortSignal);
    },
    {
      name: 'get_evaluation_udid',
      description: UDID_DESCRIPTION,
      schema: claimIdSchema,
    },
  );

  const getAudit = tool(
    async (rawArgs, ctx) => {
      const { claimId, includeStepPayloads } = auditSchema.parse(rawArgs);
      const bundle = await client.getAudit(claimId, ctx.abortSignal);
      if (isEvalsApiError(bundle) || includeStepPayloads) return bundle;
      const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
      return {
        ...bundle,
        steps: steps.map((step) => {
          const s = asRecord(step);
          return { id: s?.id, tsSec: s?.tsSec, type: s?.type };
        }),
      };
    },
    {
      name: 'get_evaluation_audit',
      description: AUDIT_DESCRIPTION,
      schema: auditSchema,
    },
  );

  const getMaturity = tool(
    async (rawArgs, ctx) => {
      const { claimType } = maturitySchema.parse(rawArgs);
      return client.getMaturity(claimType, ctx.abortSignal);
    },
    {
      name: 'get_evaluation_maturity',
      description: MATURITY_DESCRIPTION,
      schema: maturitySchema,
    },
  );

  const listReviews = tool(
    async (rawArgs, ctx) => {
      listReviewsSchema.parse(rawArgs ?? {});
      return client.listManualReview(ctx.abortSignal);
    },
    {
      name: 'list_evaluation_reviews',
      description: REVIEWS_DESCRIPTION,
      schema: listReviewsSchema,
    },
  );

  const listRubrics = tool(
    async (rawArgs, ctx) => {
      const { claimType, rubricVersionId } = listRubricsSchema.parse(
        rawArgs ?? {},
      );
      if (rubricVersionId !== undefined) {
        return client.getRubric(rubricVersionId, ctx.abortSignal);
      }
      return client.listRubrics(claimType, ctx.abortSignal);
    },
    {
      name: 'list_evaluation_rubrics',
      description: RUBRICS_DESCRIPTION,
      schema: listRubricsSchema,
    },
  );

  return [
    evaluateClaim,
    getStatus,
    getUdid,
    getAudit,
    getMaturity,
    listReviews,
    listRubrics,
  ];
}
