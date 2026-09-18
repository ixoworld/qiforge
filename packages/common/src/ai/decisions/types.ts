import type { z } from 'zod';

export type DecisionState = Record<string, unknown>;

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
  level: number;
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

export interface DecisionProviderResult {
  answers: Record<string, DecisionAnswer>;
  modelVersion?: string;
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

export interface DecisionEvaluation {
  decision: {
    name: string;
    version: string;
  };
  provider: string;
  model: string;
  modelVersion?: string;
  answers: Record<string, DecisionAnswer>;
  latencyMs: number;
  usage?: DecisionUsage;
  evaluatedAt: string;
}
