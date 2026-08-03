import {
  OraclePlugin,
  type PluginContext,
  type PluginManifest,
  type PluginTool,
} from '@ixo/oracle-runtime';
import { seedEvaluatorState, type EvaluatorState } from './evaluator-state.js';
import {
  buildIssueDeterminationTool,
  buildReadClaimTool,
  buildReadRubricTool,
} from './evaluator-tools.js';

const manifest: PluginManifest = {
  title: 'Fleet Diagnostics Evaluator',
  summary:
    'Read a submitted vehicle fault claim and its evidence, read the rubric in force, and issue a determination against it. Upholding a claim releases the claimant to procure work; it does not authorise this oracle to do anything.',
  whenToUse: [
    'A fault claim needs determining against the rubric.',
    'Someone asks what standard a determination was made against, or what the rubric currently says.',
    'Evidence needs reviewing before a verdict is reached.',
  ],
  whenNotToUse: [
    'To book, procure, or pay for anything. This oracle evaluates and does not act.',
    'To submit a claim to the collection it judges — denied outright, because the author and the judge must not be the same principal.',
    'To decide a case the rubric does not cover. That is an inconclusive finding, which is a real outcome.',
  ],
  examples: [
    {
      user: 'There is a new brake claim from DV-114 — take a look.',
      thought:
        'Read the claim and its evidence, then read the rubric so the determination can cite the version applied.',
      tool: 'read_claim',
      args: { claimId: 'claim:dv-114:brakes-2026-08' },
    },
    {
      user: 'Does that meet the threshold?',
      tool: 'issue_determination',
      args: {
        claimId: 'claim:dv-114:brakes-2026-08',
        outcome: 'upheld',
        rubricVersion: 'rubric:dv-fleet-brakes@2.1.0',
        reasoning:
          'Pad wear 82% with corroborating fault code C1234 across 47 consecutive readings meets pad-wear-threshold.',
        faultConfirmed: 'Front axle brake pad wear beyond service limit',
        recommendedWork: 'Replace front axle brake pads',
        estimatedCostMinor: '148500000',
        denom: 'uusdc',
      },
    },
  ],
  tags: ['evaluation', 'diagnostics', 'claims', 'rubric'],
  category: 'core',
  visibility: 'always',
  stability: 'experimental',
};

/**
 * The evaluator's agentic function.
 *
 * Three tools, because the constitution admits three verbs. The absence of a
 * booking or payment tool is not a gap to fill later: acting is above a
 * `bounded_evaluate` ceiling, and an evaluator that could act on its own
 * verdict could pay itself by finding in its own favour.
 */
export class DiagnosticsEvaluatorPlugin extends OraclePlugin {
  readonly name = 'diagnostics-evaluator';
  readonly version = '0.1.0';
  readonly manifest = manifest;

  readonly state: EvaluatorState;

  constructor(state: EvaluatorState = seedEvaluatorState()) {
    super();
    this.state = state;
  }

  override getTools(_ctx: PluginContext): PluginTool[] {
    return [
      buildReadClaimTool(this.state),
      buildReadRubricTool(this.state),
      buildIssueDeterminationTool(this.state),
    ];
  }
}
