import type {
  DecisionAdapter,
  DecisionAnswer,
  DecisionRequest,
} from './types.js';
import { canonicalizeIxoJson } from './final-subject.js';
import {
  recordedProvenance,
  type DecisionRecordedProvenance,
} from './provenance.js';
import { validateDecisionProviderResult } from './validation.js';

export type DecisionBenchmarkGold = boolean | string;

export interface DecisionBenchmarkCase {
  id: string;
  request: DecisionRequest;
  questionId: string;
  gold: DecisionBenchmarkGold;
}

export interface DecisionBenchmarkMetrics {
  count: number;
  accuracy: number;
  brier?: number;
  ece?: number;
  selectiveRiskAt80?: number;
}

export interface DecisionBenchmarkRun {
  caseId: string;
  correct: boolean;
  confidence: number;
  brier?: number;
  latencyMs: number;
  /**
   * What the response reported about the backend that answered, recorded the
   * way `DecisionRuntime` records an evaluation's judgment.
   */
  provenance: DecisionRecordedProvenance;
}

export type DecisionBenchmarkPrimitive = 'boolean' | 'choice';

export interface DecisionBenchmarkResult {
  provider: string;
  model: string;
  /**
   * The one question kind every case asks. Boolean Brier (0..1) and
   * multiclass Brier (0..2) are on different scales, so a bakeoff never mixes
   * them.
   */
  primitive: DecisionBenchmarkPrimitive;
  /**
   * The provenance every run reported. A bakeoff aggregates only runs that
   * agree on it, so the metrics describe one identified backend.
   */
  provenance: DecisionRecordedProvenance;
  metrics: DecisionBenchmarkMetrics;
  latencyMs: { mean: number; p50: number; p95: number };
  runs: DecisionBenchmarkRun[];
}

export interface DecisionBenchmarkProvenanceCohort {
  provenance: DecisionRecordedProvenance;
  caseIds: string[];
}

/**
 * Raised when the runs of one bakeoff report different provenance (another
 * returned model, function version, dialect, pinning class, artifact or
 * method), since one aggregate over them would describe no single backend.
 * It carries every run and the runs grouped by provenance, so a caller can
 * re-run or report each cohort separately.
 */
export class DecisionBenchmarkProvenanceError extends Error {
  readonly runs: readonly DecisionBenchmarkRun[];
  readonly cohorts: readonly DecisionBenchmarkProvenanceCohort[];

  constructor(
    runs: readonly DecisionBenchmarkRun[],
    cohorts: readonly DecisionBenchmarkProvenanceCohort[],
  ) {
    super(
      `Decision bakeoff runs reported ${cohorts.length} different provenance records; refusing to aggregate them.`,
    );
    this.name = 'DecisionBenchmarkProvenanceError';
    this.runs = runs;
    this.cohorts = cohorts;
  }
}

/**
 * Small provider-neutral bakeoff runner. It intentionally mirrors the core
 * metrics used by the independent 37-dataset Jev harness while operating on
 * IXO DecisionRequest fixtures and live DecisionAdapters.
 *
 * Each run keeps the provenance its response reported. When the runs disagree
 * the bakeoff throws `DecisionBenchmarkProvenanceError` instead of averaging
 * across backends. A mutable backend that reports no returned model cannot be
 * told apart this way; its runs share `modelPinning: 'mutable'` and no
 * `returnedModel`, which the result shows.
 */
export async function runDecisionProviderBakeoff(
  adapter: DecisionAdapter,
  cases: readonly DecisionBenchmarkCase[],
): Promise<DecisionBenchmarkResult> {
  const primitive = benchmarkPrimitive(cases);

  const runs: DecisionBenchmarkRun[] = [];
  for (const testCase of cases) {
    // One failing case aborts the bakeoff; the error names the case and
    // keeps the adapter's or validator's error as its cause.
    try {
      const started = Date.now();
      const raw = await adapter.evaluate(testCase.request);
      const latencyMs = Date.now() - started;
      const result = validateDecisionProviderResult(testCase.request, raw);
      const answer = result.answers[testCase.questionId];
      if (!answer) {
        throw new Error(`Missing answer for ${testCase.questionId}.`);
      }
      runs.push({
        caseId: testCase.id,
        ...scoreAnswer(answer, testCase.gold),
        latencyMs,
        provenance: recordedProvenance(adapter, result),
      });
    } catch (cause) {
      throw new Error(`Decision bakeoff case "${testCase.id}" failed.`, {
        cause,
      });
    }
  }

  const cohorts = provenanceCohorts(runs);
  if (cohorts.length > 1) {
    throw new DecisionBenchmarkProvenanceError(runs, cohorts);
  }

  const confidences = runs.map((run) => run.confidence);
  const correct = runs.map((run) => (run.correct ? 1 : 0));
  const briers = runs
    .map((run) => run.brier)
    .filter((x): x is number => x !== undefined);
  const latencies = runs.map((run) => run.latencyMs).sort((a, b) => a - b);

  return {
    provider: adapter.provider,
    model: adapter.model,
    primitive,
    provenance: runs[0]!.provenance,
    metrics: {
      count: runs.length,
      accuracy: mean(correct),
      ...(briers.length ? { brier: mean(briers) } : {}),
      ece: expectedCalibrationError(confidences, correct),
      selectiveRiskAt80: selectiveRisk(confidences, correct, 0.8),
    },
    latencyMs: {
      mean: mean(latencies),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    runs,
  };
}

function provenanceCohorts(
  runs: readonly DecisionBenchmarkRun[],
): DecisionBenchmarkProvenanceCohort[] {
  const cohorts = new Map<string, DecisionBenchmarkProvenanceCohort>();
  for (const run of runs) {
    const key = canonicalizeIxoJson(run.provenance);
    const cohort = cohorts.get(key);
    if (cohort) {
      cohort.caseIds.push(run.caseId);
    } else {
      cohorts.set(key, { provenance: run.provenance, caseIds: [run.caseId] });
    }
  }
  return [...cohorts.values()];
}

/**
 * Checks the case list before any provider call: at least one case, every
 * case's question exists, all cases ask the same primitive (boolean or
 * choice; ordinal needs a task-specific metric), and every gold label is a
 * valid answer to its question.
 */
function benchmarkPrimitive(
  cases: readonly DecisionBenchmarkCase[],
): DecisionBenchmarkPrimitive {
  let primitive: DecisionBenchmarkPrimitive | undefined;
  for (const testCase of cases) {
    const question = testCase.request.questions[testCase.questionId];
    if (!question) {
      throw new TypeError(
        `Decision bakeoff case "${testCase.id}" asks for question "${testCase.questionId}", which its request does not contain.`,
      );
    }
    if (question.kind === 'ordinal') {
      throw new TypeError(
        `Decision bakeoff case "${testCase.id}" is ordinal; ordinal cases require a task-specific metric.`,
      );
    }
    primitive ??= question.kind;
    if (question.kind !== primitive) {
      throw new TypeError(
        `Decision bakeoff cases mix ${primitive} and ${question.kind} questions (case "${testCase.id}"); their Brier scores are on different scales, so run one bakeoff per primitive.`,
      );
    }
    if (question.kind === 'boolean' && typeof testCase.gold !== 'boolean') {
      throw new TypeError(
        `Decision bakeoff case "${testCase.id}" asks a boolean question but its gold label is not a boolean.`,
      );
    }
    if (
      question.kind === 'choice' &&
      (typeof testCase.gold !== 'string' ||
        !Object.hasOwn(question.options, testCase.gold))
    ) {
      throw new TypeError(
        `Decision bakeoff case "${testCase.id}" has a gold label that is not one of its question's options.`,
      );
    }
  }
  if (primitive === undefined) {
    throw new TypeError('A Decision bakeoff needs at least one case.');
  }
  return primitive;
}

function scoreAnswer(
  answer: DecisionAnswer,
  gold: DecisionBenchmarkGold,
): { correct: boolean; confidence: number; brier?: number } {
  if (answer.kind === 'boolean') {
    if (typeof gold !== 'boolean') {
      throw new TypeError('Boolean answer requires boolean gold.');
    }
    const p = answer.probabilityTrue;
    const y = gold ? 1 : 0;
    return {
      correct: p >= 0.5 === gold,
      confidence: Math.max(p, 1 - p),
      brier: (p - y) ** 2,
    };
  }

  if (answer.kind === 'choice') {
    if (typeof gold !== 'string') {
      throw new TypeError('Choice answer requires string gold.');
    }
    // Confidence in the answer actually given, not in whichever option has
    // the largest probability: validation does not require `value` to be
    // the argmax.
    const confidence = answer.probabilities[answer.value];
    if (confidence === undefined) {
      throw new TypeError(
        'Choice answer gives no probability for its own value.',
      );
    }
    return {
      correct: answer.value === gold,
      confidence,
      brier: Object.entries(answer.probabilities).reduce(
        (sum, [key, value]) => sum + (value - (key === gold ? 1 : 0)) ** 2,
        0,
      ),
    };
  }

  throw new TypeError(
    'Ordinal benchmark cases require a task-specific metric.',
  );
}

function expectedCalibrationError(
  confidence: number[],
  correct: number[],
  bins = 15,
): number {
  let total = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const lo = bin / bins;
    const hi = (bin + 1) / bins;
    const indexes = confidence
      .map((value, index) => ({ value, index }))
      .filter(({ value }) =>
        bin === bins - 1
          ? value >= lo && value <= hi
          : value >= lo && value < hi,
      )
      .map(({ index }) => index);
    if (!indexes.length) continue;
    const binConfidence = mean(indexes.map((i) => confidence[i]!));
    const binAccuracy = mean(indexes.map((i) => correct[i]!));
    total += indexes.length * Math.abs(binConfidence - binAccuracy);
  }
  return confidence.length ? total / confidence.length : 0;
}

function selectiveRisk(
  confidence: number[],
  correct: number[],
  coverage: number,
): number {
  if (!confidence.length) return 0;
  const indexes = confidence
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(1, Math.round(confidence.length * coverage)))
    .map(({ index }) => index);
  return 1 - mean(indexes.map((i) => correct[i]!));
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.max(1, Math.ceil(sorted.length * p));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
