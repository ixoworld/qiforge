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
 * A negative value is not a semantic answer: the runtime refuses with
 * `DecisionNotApplicableError` before any provider is invoked, and the caller's
 * policy decides whether to pass through, ask for more evidence or escalate.
 */
export interface DecisionApplicability {
  applicable: boolean;
  evidenceComplete: boolean;
  reason?: string;
}

export interface DecisionRequest {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  /** Omitted means applicable with complete evidence. */
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
   * debiased, calibrated, specialized, deterministic or human.
   */
  kind: string;
  /** Provider-specific method or level name. */
  name?: string;
  /** Immutable artifact the method used, such as a fitted head. */
  artifactRef?: string;
}

export interface DecisionCalibrationProvenance {
  method: string;
  artifactRef?: string;
  /** Workload or evaluation domain the calibration was fitted on. */
  workload?: string;
  version?: string;
  /** ISO timestamp of the calibration run. */
  evaluatedAt?: string;
  /** Expected calibration error on the declared workload. */
  ece?: number;
  brier?: number;
}

/**
 * What an adapter can substantiate about how it judged. An adapter that cannot
 * back a calibration claim leaves `calibration` out.
 */
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

/**
 * How the runtime chose the provider for one evaluation, in precedence order:
 * the caller's `providerId`, an exact per-Decision route, the configured
 * default, or the only registered provider.
 */
export type DecisionProviderSelection =
  | 'caller-override'
  | 'decision-route'
  | 'default'
  | 'sole-provider';

export interface DecisionEvaluateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Evaluate with this configured provider instead of the routed one. */
  providerId?: string;
  /**
   * Callbacks for the evaluation's trace span, typically the turn's LangSmith
   * tracer. Only needed outside a LangChain run: inside one (a tool, a node)
   * the span inherits the run's callbacks and nests under it on its own.
   */
  callbacks?: Callbacks;
  /** Extra metadata on the trace span, e.g. the user DID and thread id. */
  metadata?: Record<string, unknown>;
}

/**
 * The tracing half of `DecisionEvaluateOptions`, for callers that forward a
 * turn's tracer to code that evaluates Decisions on its behalf.
 */
export type DecisionTraceOptions = Pick<
  DecisionEvaluateOptions,
  'callbacks' | 'metadata'
>;

export interface DecisionJudgmentProvenance extends DecisionProviderProvenance {
  /** Version of the Decision definition (its question set) evaluated. */
  questionSetVersion: string;
}

/**
 * The provenance fields added for provider routing and the reliability
 * contract (`providerId` … `judgment`) are always set by `DecisionRuntime`.
 * They are optional in the type so evaluations built by hand, such as test
 * doubles written against the earlier shape, still compile.
 */
export interface DecisionEvaluation {
  decision: {
    name: string;
    version: string;
  };
  /** Configured provider instance that answered. */
  providerId?: string;
  /** How the runtime selected `providerId`. */
  providerSelection?: DecisionProviderSelection;
  provider: string;
  model: string;
  modelVersion?: string;
  /** The request's applicability; omitted metadata is recorded as fully applicable. */
  applicability?: DecisionApplicability;
  judgment?: DecisionJudgmentProvenance;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  usage?: DecisionUsage;
  evaluatedAt: string;
}
