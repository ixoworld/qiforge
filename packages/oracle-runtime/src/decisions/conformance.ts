import {
  validateDecisionProviderResult,
  validateDecisionRequest,
  type DecisionAdapter,
  type DecisionAnswer,
  type DecisionProviderOptions,
  type DecisionRequest,
} from '@ixo/common';

export interface DecisionQuestionIsolationObservation {
  question: string;
  kind: DecisionAnswer['kind'];
  comparable: boolean;
  selectedChanged?: boolean;
  maxProbabilityDelta?: number;
  scoreDelta?: number;
}

export interface DecisionQuestionIsolationReport {
  observations: DecisionQuestionIsolationObservation[];
  maxProbabilityDelta?: number;
  changedSelections: string[];
}

/**
 * Conformance probe for packed-question interference.
 *
 * Evaluates the complete request once, then evaluates every question against
 * the exact same state in isolation. It does not define a universal pass/fail
 * tolerance; profiles and workloads must set that policy explicitly.
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
    throw new Error(
      'Question isolation cannot evaluate a Decision request declared inapplicable or evidence-incomplete.',
    );
  }

  const packed = await adapter.evaluate(request, options);
  validateDecisionProviderResult(request, packed);

  const observations: DecisionQuestionIsolationObservation[] = [];
  for (const [question, definition] of Object.entries(request.questions)) {
    const isolatedRequest: DecisionRequest = {
      state: request.state,
      questions: { [question]: definition },
      ...(request.applicability
        ? { applicability: request.applicability }
        : {}),
    };
    const isolated = await adapter.evaluate(isolatedRequest, options);
    validateDecisionProviderResult(isolatedRequest, isolated);

    observations.push(
      compareQuestionAnswers(
        question,
        packed.answers[question]!,
        isolated.answers[question]!,
      ),
    );
  }

  const probabilityDeltas = observations
    .map((observation) => observation.maxProbabilityDelta)
    .filter((value): value is number => value !== undefined);

  return {
    observations,
    ...(probabilityDeltas.length
      ? { maxProbabilityDelta: Math.max(...probabilityDeltas) }
      : {}),
    changedSelections: observations
      .filter((observation) => observation.selectedChanged)
      .map((observation) => observation.question),
  };
}

function compareQuestionAnswers(
  question: string,
  packed: DecisionAnswer,
  isolated: DecisionAnswer,
): DecisionQuestionIsolationObservation {
  if (packed.kind !== isolated.kind) {
    return {
      question,
      kind: packed.kind,
      comparable: false,
      selectedChanged: true,
    };
  }

  if (packed.kind === 'boolean' && isolated.kind === 'boolean') {
    return {
      question,
      kind: 'boolean',
      comparable: true,
      selectedChanged:
        (packed.probabilityTrue >= 0.5) !==
        (isolated.probabilityTrue >= 0.5),
      maxProbabilityDelta: Math.abs(
        packed.probabilityTrue - isolated.probabilityTrue,
      ),
    };
  }

  if (packed.kind === 'choice' && isolated.kind === 'choice') {
    return {
      question,
      kind: 'choice',
      comparable: true,
      selectedChanged: packed.value !== isolated.value,
      maxProbabilityDelta: maxMapDelta(
        packed.probabilities,
        isolated.probabilities,
      ),
    };
  }

  if (packed.kind === 'ordinal' && isolated.kind === 'ordinal') {
    const maxProbabilityDelta =
      packed.probabilities && isolated.probabilities
        ? maxMapDelta(packed.probabilities, isolated.probabilities)
        : undefined;
    return {
      question,
      kind: 'ordinal',
      comparable: true,
      scoreDelta: Math.abs(packed.score - isolated.score),
      ...(maxProbabilityDelta === undefined
        ? {}
        : { maxProbabilityDelta }),
    };
  }

  return {
    question,
    kind: packed.kind,
    comparable: false,
  };
}

function maxMapDelta(
  left: Record<string, number>,
  right: Record<string, number>,
): number {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let max = 0;
  for (const key of keys) {
    max = Math.max(max, Math.abs((left[key] ?? 0) - (right[key] ?? 0)));
  }
  return max;
}
