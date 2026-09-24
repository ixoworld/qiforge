import type { z } from 'zod';

export type DecisionState =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

export interface BooleanDecisionQuestion {
  kind: 'boolean';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceDecisionQuestion {
  kind: 'choice';
  instructions: string;
  options: Record<string, string>;
}

export interface OrdinalDecisionQuestion {
  kind: 'ordinal';
  instructions: string;
  levels: string[];
}

export type DecisionQuestion =
  | BooleanDecisionQuestion
  | ChoiceDecisionQuestion
  | OrdinalDecisionQuestion;

/**
 * Declares whether the projected state is fit for semantic judgment.
 *
 * A negative value is not a semantic answer. Runtimes must abstain before
 * provider invocation when either flag is false.
 */
export interface DecisionApplicability {
  applicable: boolean;
  evidenceComplete: boolean;
  reason?: string;
}

export interface DecisionRequest {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  applicability?: DecisionApplicability;
}

export interface BooleanDecisionAnswer {
  kind: 'boolean';
  probabilityTrue: number;
}

export interface ChoiceDecisionAnswer {
  kind: 'choice';
  value: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface OrdinalDecisionAnswer {
  kind: 'ordinal';
  /**
   * Continuous position on the declared ordinal scale. For N levels the
   * valid range is 0..N-1; providers such as Jev may return fractional values.
   */
  score: number;
  confidence: number;
  probabilities?: Record<string, number>;
}

export type DecisionAnswer =
  | BooleanDecisionAnswer
  | ChoiceDecisionAnswer
  | OrdinalDecisionAnswer;

export interface DecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface DecisionJudgmentMethod {
  /**
   * Provider-neutral method category, for example provider-native, raw,
   * debiased, calibrated, specialized, deterministic, or human.
   */
  kind: string;
  /** Provider-specific method/level name, for example L2 or System One. */
  name?: string;
  /** Immutable artifact used by the method, such as a fitted head. */
  artifactRef?: string;
}

export interface DecisionCalibrationProvenance {
  method: string;
  artifactRef?: string;
  workload?: string;
  version?: string;
  evaluatedAt?: string;
  ece?: number;
  brier?: number;
}

export interface DecisionProviderProvenance {
  method: DecisionJudgmentMethod;
  calibration?: DecisionCalibrationProvenance;
}

export interface DecisionProviderResult {
  answers: Record<string, DecisionAnswer>;
  modelVersion?: string;
  provenance?: DecisionProviderProvenance;
  usage?: DecisionUsage;
}

export interface DecisionProviderOptions {
  signal?: AbortSignal;
}

export interface DecisionAdapter {
  readonly provider: string;
  readonly model: string;
  evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult>;
}

export interface DecisionRegistration {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly timeoutMs?: number;
  prepare(input: unknown): DecisionRequest;
}

export interface DecisionDefinition<
  TSchema extends z.ZodType = z.ZodType,
> extends DecisionRegistration {
  readonly inputSchema: TSchema;
  project(input: z.output<TSchema>): DecisionRequest;
}

export interface DecisionEvaluateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DecisionJudgmentProvenance extends DecisionProviderProvenance {
  /** Version of the Decision definition/question set that was evaluated. */
  questionSetVersion: string;
}

export interface DecisionEvaluation {
  decision: {
    name: string;
    version: string;
  };
  provider: string;
  model: string;
  modelVersion?: string;
  applicability: DecisionApplicability;
  judgment: DecisionJudgmentProvenance;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  usage?: DecisionUsage;
  evaluatedAt: string;
}
