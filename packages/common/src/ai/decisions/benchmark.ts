import type {
  DecisionAdapter,
  DecisionAnswer,
  DecisionRequest,
} from './types.js';
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

export interface DecisionBenchmarkResult {
  provider: string;
  model: string;
  metrics: DecisionBenchmarkMetrics;
  latencyMs: { mean: number; p50: number; p95: number };
}

/**
 * Small provider-neutral bakeoff runner. It intentionally mirrors the core
 * metrics used by the independent 37-dataset Jev harness while operating on
 * IXO DecisionRequest fixtures and live DecisionAdapters.
 */
export async function runDecisionProviderBakeoff(
  adapter: DecisionAdapter,
  cases: readonly DecisionBenchmarkCase[],
): Promise<DecisionBenchmarkResult> {
  const observations: Array<{
    correct: number;
    confidence: number;
    brier?: number;
    latencyMs: number;
  }> = [];

  for (const testCase of cases) {
    const started = Date.now();
    const raw = await adapter.evaluate(testCase.request);
    const latencyMs = Date.now() - started;
    const result = validateDecisionProviderResult(testCase.request, raw);
    const answer = result.answers[testCase.questionId];
    if (!answer) throw new Error(`Missing answer for ${testCase.questionId}`);
    observations.push(scoreAnswer(answer, testCase.gold, latencyMs));
  }

  const confidences = observations.map((x) => x.confidence);
  const correct = observations.map((x) => x.correct);
  const briers = observations
    .map((x) => x.brier)
    .filter((x): x is number => x !== undefined);
  const latencies = observations.map((x) => x.latencyMs).sort((a, b) => a - b);

  return {
    provider: adapter.provider,
    model: adapter.model,
    metrics: {
      count: observations.length,
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
  };
}

function scoreAnswer(
  answer: DecisionAnswer,
  gold: DecisionBenchmarkGold,
  latencyMs: number,
): { correct: number; confidence: number; brier?: number; latencyMs: number } {
  if (answer.kind === 'boolean') {
    if (typeof gold !== 'boolean') throw new TypeError('Boolean answer requires boolean gold.');
    const p = answer.probabilityTrue;
    const y = gold ? 1 : 0;
    return {
      correct: (p >= 0.5) === gold ? 1 : 0,
      confidence: gold ? p : 1 - p,
      brier: (p - y) ** 2,
      latencyMs,
    };
  }

  if (answer.kind === 'choice') {
    if (typeof gold !== 'string') throw new TypeError('Choice answer requires string gold.');
    const p = answer.probabilities[gold] ?? 0;
    return {
      correct: answer.value === gold ? 1 : 0,
      confidence: Math.max(...Object.values(answer.probabilities)),
      brier: Object.entries(answer.probabilities).reduce(
        (sum, [key, value]) => sum + (value - (key === gold ? 1 : 0)) ** 2,
        0,
      ),
      latencyMs,
    };
  }

  throw new TypeError('Ordinal benchmark cases require a task-specific metric.');
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
        bin === bins - 1 ? value >= lo && value <= hi : value >= lo && value < hi,
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

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
