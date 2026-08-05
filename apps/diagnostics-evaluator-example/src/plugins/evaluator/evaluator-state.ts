/**
 * @fileoverview What the evaluator can see: claims submitted to the collection,
 * the rubric in force, and the determinations it has issued.
 *
 * In a deployment these are the claims collection on chain and its rubric
 * resource. Here they are in-memory so the loop is runnable without one.
 *
 * `submittedBy` is carried on every claim because recusal needs it. An
 * evaluator that cannot see who authored a claim cannot tell whether judging
 * it would make one principal both author and judge.
 */

export interface Rubric {
  version: string;
  criteria: Array<{ id: string; description: string }>;
}

export interface SubmittedClaim {
  id: string;
  claimType: 'vehicle_fault_observation';
  submittedBy: string;
  observation: string;
  evidence: string[];
  submittedAt: string;
}

export interface IssuedDetermination {
  claimId: string;
  evaluator: string;
  outcome: 'upheld' | 'rejected' | 'inconclusive';
  rubricVersion: string;
  reasoning: string;
  faultConfirmed: string | null;
  recommendedWork: string | null;
  estimatedCostMinor: string | null;
  denom: string | null;
  determinedAt: string;
}

export class EvaluatorState {
  private readonly claims = new Map<string, SubmittedClaim>();
  private readonly determinations = new Map<string, IssuedDetermination>();

  constructor(
    readonly selfDid: string,
    private rubric: Rubric,
  ) {}

  /** Files a claim that arrived from a claimant. Not exposed as a tool. */
  receiveClaim(claim: SubmittedClaim): void {
    this.claims.set(claim.id, claim);
  }

  getClaim(id: string): SubmittedClaim | undefined {
    return this.claims.get(id);
  }

  getRubric(): Rubric {
    return {
      version: this.rubric.version,
      criteria: [...this.rubric.criteria],
    };
  }

  recordDetermination(determination: IssuedDetermination): void {
    this.determinations.set(determination.claimId, determination);
  }

  getDetermination(claimId: string): IssuedDetermination | undefined {
    return this.determinations.get(claimId);
  }
}

/** The rubric this example judges against. */
export function seedEvaluatorState(
  selfDid = 'did:ixo:entity:fleet-diagnostics-evaluator',
): EvaluatorState {
  return new EvaluatorState(selfDid, {
    version: 'rubric:dv-fleet-brakes@2.1.0',
    criteria: [
      {
        id: 'pad-wear-threshold',
        description:
          'Pad wear above 75% with a corroborating fault code on 20 or more consecutive readings indicates replacement is due.',
      },
      {
        id: 'corroboration',
        description:
          'A sensor reading without a corroborating fault code, or vice versa, is inconclusive rather than upheld.',
      },
      {
        id: 'cost-envelope',
        description:
          'Front axle pad replacement is estimated at 120-180 USDC at approved vendors.',
      },
    ],
  });
}
