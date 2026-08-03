/**
 * @fileoverview The evaluator's capabilities: read the claim and its evidence,
 * read the rubric in force, and issue a determination against it.
 *
 * The tool set is three verbs long because the constitution is. There is no
 * tool to book, pay, or procure anything — those are above a
 * `bounded_evaluate` ceiling and would be refused before any grant was
 * consulted. And there is no tool to submit a claim, because the evaluator is
 * denied claims in the collection it judges.
 */
import { type PluginTool, tool, z } from '@ixo/oracle-runtime';
import type { EvaluatorState } from './evaluator-state.js';

const COLLECTION = 'ixo:collection:dv-fleet-diagnostics';

const claimIdSchema = z.object({
  claimId: z.string().min(1).describe('Identifier of the claim under review.'),
});

/** Reading the claim and its evidence — the input to a determination. */
export function buildReadClaimTool(state: EvaluatorState): PluginTool {
  return tool(
    async (rawArgs) => {
      const { claimId } = claimIdSchema.parse(rawArgs);
      const claim = state.getClaim(claimId);
      return claim
        ? JSON.stringify(claim)
        : JSON.stringify({ claimId, status: 'not_found' });
    },
    {
      name: 'read_claim',
      description:
        'Read a submitted fault claim: what was observed, by whom, and the evidence attached to it.',
      schema: claimIdSchema,
      effect: {
        type: 'read',
        action: 'read_claim',
        object: () => `${COLLECTION}/claims`,
      },
    },
  );
}

/**
 * Reading the rubric. A separate tool rather than a constant baked into the
 * prompt, because the rubric is versioned and the version applied has to
 * appear in the determination.
 */
export function buildReadRubricTool(state: EvaluatorState): PluginTool {
  return tool(async () => JSON.stringify(state.getRubric()), {
    name: 'read_rubric',
    description:
      'Read the fault-assessment rubric currently in force: its version, and the criteria a claim is judged against.',
    schema: z.object({}),
    effect: {
      type: 'read',
      action: 'read_rubric',
      object: () => `${COLLECTION}/rubric`,
    },
  });
}

const determinationSchema = z.object({
  claimId: z.string().min(1).describe('The claim being determined.'),
  outcome: z
    .enum(['upheld', 'rejected', 'inconclusive'])
    .describe(
      'Upheld releases the claimant to act. Inconclusive is a legitimate outcome when the rubric does not cover the case — prefer it to a guess.',
    ),
  rubricVersion: z
    .string()
    .min(1)
    .describe(
      'Version of the rubric applied. A determination without one cannot be audited.',
    ),
  reasoning: z
    .string()
    .min(1)
    .describe(
      'The decision-relevant facts and how the rubric applies to them. Not a transcript of deliberation.',
    ),
  faultConfirmed: z
    .string()
    .nullable()
    .describe('The confirmed fault, when upheld.'),
  recommendedWork: z
    .string()
    .nullable()
    .describe('The work indicated, when upheld.'),
  estimatedCostMinor: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .nullable()
    .describe('Estimated cost in the smallest denomination, when upheld.'),
  denom: z.string().nullable().describe('Denomination of the estimate.'),
});

/**
 * Issue the determination.
 *
 * This is the act that releases someone else to spend, which is why it is an
 * `evaluate` and why the grant behind it requires a credential the collection
 * issues and can revoke.
 */
export function buildIssueDeterminationTool(state: EvaluatorState): PluginTool {
  return tool(
    async (rawArgs) => {
      const args = determinationSchema.parse(rawArgs);
      const claim = state.getClaim(args.claimId);
      if (!claim) {
        return JSON.stringify({
          status: 'refused',
          reason: `No claim ${args.claimId} to determine.`,
        });
      }
      // Recusal, behind the gate's own separation rules. The gate refuses an
      // evaluator judging a claim it submitted; this refuses one judging a
      // claim submitted by the same principal it acts as, which is the same
      // rule stated where the claim's author is actually visible.
      if (claim.submittedBy === state.selfDid) {
        return JSON.stringify({
          status: 'recused',
          reason:
            'This claim traces back to this evaluator. Determining it would make the same principal both author and judge.',
        });
      }
      const rubric = state.getRubric();
      if (args.rubricVersion !== rubric.version) {
        return JSON.stringify({
          status: 'refused',
          reason: `Rubric ${args.rubricVersion} is not the version in force (${rubric.version}).`,
        });
      }
      state.recordDetermination({
        claimId: args.claimId,
        evaluator: state.selfDid,
        outcome: args.outcome,
        rubricVersion: args.rubricVersion,
        reasoning: args.reasoning,
        faultConfirmed: args.faultConfirmed,
        recommendedWork: args.recommendedWork,
        estimatedCostMinor: args.estimatedCostMinor,
        denom: args.denom,
        determinedAt: new Date().toISOString(),
      });
      return JSON.stringify({ status: 'determined', claimId: args.claimId });
    },
    {
      name: 'issue_determination',
      description:
        'Issue a determination on a fault claim against the rubric in force. Upholding releases the claimant to procure the work — it is not permission for this oracle to do anything.',
      schema: determinationSchema,
      effect: {
        type: 'evaluate',
        action: 'evaluate_claim',
        object: () => `${COLLECTION}/claims`,
      },
    },
  );
}
