import { DecisionNotApplicableError } from './errors.js';
import type {
  DecisionAdapter,
  DecisionAnswer,
  DecisionProviderOptions,
  DecisionRequest,
} from './types.js';
import {
  validateDecisionProviderResult,
  validateDecisionRequest,
} from './validation.js';

export interface DecisionQuestionIsolationObservation {
  question: string;
  kind: DecisionAnswer['kind'];
  /**
   * Boolean: the side of 0.5 changed. Choice: the selected option changed.
   * Absent for ordinal questions, whose movement is `scoreDelta`.
   */
  selectedChanged?: boolean;
  /** Largest absolute difference across the question's probability map. */
  maxProbabilityDelta?: number;
  /** Ordinal only: absolute difference between the packed and isolated score. */
  scoreDelta?: number;
}

export interface DecisionQuestionIsolationReport {
  observations: DecisionQuestionIsolationObservation[];
  /** Largest `maxProbabilityDelta` across all questions, when any has one. */
  maxProbabilityDelta?: number;
  /** Questions whose selection flipped between packed and isolated runs. */
  changedSelections: string[];
}

/**
 * Conformance probe for packed-question interference.
 *
 * Evaluates the whole request once, then every question alone against the
 * same state, and reports how far each answer moved. It sets no pass/fail
 * tolerance: that is a workload or profile policy. It calls the adapter
 * `1 + questions` times, so run it against test or staging providers, not on
 * a live request path. Provider output is validated exactly as the runtime
 * validates it, and a request declared inapplicable or evidence-incomplete is
 * refused before any provider call.
 */
export async function measureDecisionQuestionIsolation(
  adapter: DecisionAdapter,
  request: DecisionRequest,
  options?: DecisionProviderOptions,
): Promise<DecisionQuestionIsolationReport> {
  validateDecisionRequest(request);
  if (
    request.applicability &&
    (!request.applicability.applicable ||
      !request.applicability.evidenceComplete)
  ) {
    throw new DecisionNotApplicableError(request.applicability);
  }

  const packed = validateDecisionProviderResult(
    request,
    await adapter.evaluate(request, options),
  );

  const observations: DecisionQuestionIsolationObservation[] = [];
  for (const [question, definition] of Object.entries(request.questions)) {
    const isolatedRequest: DecisionRequest = {
      ...request,
      questions: { [question]: definition },
    };
    const isolated = validateDecisionProviderResult(
      isolatedRequest,
      await adapter.evaluate(isolatedRequest, options),
    );
    observations.push(
      compareAnswers(
        question,
        packed.answers[question],
        isolated.answers[question],
      ),
    );
  }

  const probabilityDeltas = observations.flatMap((observation) =>
    observation.maxProbabilityDelta === undefined
      ? []
      : [observation.maxProbabilityDelta],
  );

  return {
    observations,
    ...(probabilityDeltas.length > 0
      ? { maxProbabilityDelta: Math.max(...probabilityDeltas) }
      : {}),
    changedSelections: observations
      .filter((observation) => observation.selectedChanged === true)
      .map((observation) => observation.question),
  };
}

/**
 * Both answers were validated against the same question, so they share its
 * kind; the mismatch branch only satisfies the type checker.
 */
function compareAnswers(
  question: string,
  packed: DecisionAnswer | undefined,
  isolated: DecisionAnswer | undefined,
): DecisionQuestionIsolationObservation {
  if (packed?.kind === 'boolean' && isolated?.kind === 'boolean') {
    return {
      question,
      kind: 'boolean',
      selectedChanged:
        packed.probabilityTrue >= 0.5 !== isolated.probabilityTrue >= 0.5,
      maxProbabilityDelta: Math.abs(
        packed.probabilityTrue - isolated.probabilityTrue,
      ),
    };
  }

  if (packed?.kind === 'choice' && isolated?.kind === 'choice') {
    return {
      question,
      kind: 'choice',
      selectedChanged: packed.value !== isolated.value,
      maxProbabilityDelta: maxMapDelta(
        packed.probabilities,
        isolated.probabilities,
      ),
    };
  }

  if (packed?.kind === 'ordinal' && isolated?.kind === 'ordinal') {
    return {
      question,
      kind: 'ordinal',
      scoreDelta: Math.abs(packed.score - isolated.score),
      ...(packed.probabilities && isolated.probabilities
        ? {
            maxProbabilityDelta: maxMapDelta(
              packed.probabilities,
              isolated.probabilities,
            ),
          }
        : {}),
    };
  }

  throw new Error(
    `Decision question "${question}" was answered with different kinds in the packed and isolated runs.`,
  );
}

function maxMapDelta(
  left: Record<string, number>,
  right: Record<string, number>,
): number {
  let max = 0;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    max = Math.max(max, Math.abs((left[key] ?? 0) - (right[key] ?? 0)));
  }
  return max;
}
