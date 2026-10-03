import type { Callbacks } from '@langchain/core/callbacks/manager';
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
  criteria?: { true?: string; false?: string };
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

export interface DecisionRequest {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
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
  /** Continuous position on the declared ordinal scale (0..N-1). */
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

/** External inference protocol, deliberately separate from provider identity. */
export type DecisionInferenceDialect =
  | 'systemone-v1'
  | 'databricks-ai-decide-v1'
  | 'openai-decisions'
  | 'native-classifier'
  | 'custom';

export type DecisionModelPinning = 'pinned' | 'mutable' | 'unknown';

export interface DecisionProviderCapabilities {
  apiDialect: DecisionInferenceDialect;
  primitives: readonly DecisionQuestion['kind'][];
  answerSemantics: 'distribution' | 'score' | 'winner-only' | 'mixed';
  modelPinning: DecisionModelPinning;
  /** Optional workload/domain specialization asserted by the provider artifact. */
  specializationDomain?: string;
}

export interface DecisionProviderProvenance {
  apiDialect: DecisionInferenceDialect;
  /** Model/service requested by IXO. */
  requestedModel?: string;
  /** Model identifier actually reported by the backend. */
  returnedModel?: string;
  /** API/function version when distinct from the model version. */
  functionVersion?: string;
  modelPinning: DecisionModelPinning;
  /** Immutable or governed provider artifact/service reference. */
  providerArtifactRef?: string;
  /** Versioned IXO calibration profile applied by downstream policy. */
  calibrationProfileRef?: string;
}

export type DecisionCalibrationPrimitive = 'boolean' | 'choice' | 'ordinal';

export interface DecisionCalibrationProfile {
  id: string;
  version: string;
  status: 'provisional' | 'validated' | 'retired';
  providerArtifactRef: string;
  decisionName: string;
  decisionVersion: string;
  primitive: DecisionCalibrationPrimitive;
  questionId: string;
  validationDatasetRef?: string;
  targetPopulation?: string;
  threshold?: number;
  metrics?: {
    brier?: number;
    ece?: number;
    coverage?: number;
    selectiveRisk?: number;
  };
  validFrom: string;
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
  readonly capabilities?: DecisionProviderCapabilities;
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
  callbacks?: Callbacks;
  metadata?: Record<string, unknown>;
}

export type DecisionTraceOptions = Pick<
  DecisionEvaluateOptions,
  'callbacks' | 'metadata'
>;

export interface DecisionEvaluation {
  decision: { name: string; version: string };
  provider: string;
  model: string;
  modelVersion?: string;
  provenance: DecisionProviderProvenance;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  usage?: DecisionUsage;
  evaluatedAt: string;
}
