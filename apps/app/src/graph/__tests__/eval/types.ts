/**
 * Agent evaluation framework types.
 *
 * An "eval" is the agent equivalent of a unit test: you feed in an input,
 * collect the output, and score it. Scores are 0–1 per evaluator; you then
 * assert thresholds in Vitest the same way you'd assert expect(x).toBe(y).
 *
 * Flow:
 *   dataset (EvalExample[])
 *     → runEval()  (calls target, collects outputs)
 *     → evaluators (score each output)
 *     → EvalSummary (aggregated scores, printed + optionally shipped to LangSmith)
 *     → Vitest asserts on summary.averageScores / passRate
 */

export interface EvalExample {
  /** Unique stable ID — used as the LangSmith example ID when syncing. */
  id: string;
  /** Human-readable description for test output / LangSmith UI. */
  description: string;
  /** The inputs fed to the target function. */
  inputs: { message: string };
  /** Optional gold-standard output used by LLM-as-judge evaluators. */
  referenceOutput?: string;
  /** Arbitrary tags for filtering (e.g. ['smoke', 'safety', 'math']). */
  tags?: string[];
}

export interface EvalScore {
  /** Evaluator identifier — matches Evaluator.key. */
  key: string;
  /** Numeric score in [0, 1]. */
  score: number;
  /** Optional explanation surfaced in the summary and LangSmith UI. */
  comment?: string;
}

export interface EvalResult {
  exampleId: string;
  input: string;
  output: string;
  scores: EvalScore[];
  latencyMs: number;
  /** Set when the target function threw. */
  error?: string;
}

/**
 * A function that wraps the agent under evaluation.
 * Must return the final text output of the agent for a given message.
 * sessionId must be unique per call so each example gets a fresh conversation.
 */
export type EvalTarget = (inputs: {
  message: string;
  sessionId: string;
}) => Promise<string>;

export interface Evaluator {
  /** Short identifier used in summary tables and LangSmith feedback keys. */
  key: string;
  evaluate: (
    output: string,
    example: EvalExample,
  ) => EvalScore | Promise<EvalScore>;
}

export interface EvalRunConfig {
  experimentName: string;
  target: EvalTarget;
  dataset: EvalExample[];
  evaluators: Evaluator[];
  /** Run up to N examples in parallel. Default 1 (sequential). */
  maxConcurrency?: number;
}

export interface EvalSummary {
  experimentName: string;
  timestamp: string;
  totalExamples: number;
  results: EvalResult[];
  /** Average score per evaluator key across all examples. */
  averageScores: Record<string, number>;
  averageLatencyMs: number;
  /** Fraction of examples where every score ≥ 0.5. */
  passRate: number;
}
