import type {
  ChoiceDecisionQuestion,
  DecisionQuestion,
  DecisionRequest,
} from './types.js';

export type SemanticConformanceVariantKind =
  | 'baseline'
  | 'option-permutation'
  | 'opaque-option-ids'
  | 'rubric-paraphrase'
  | 'no-evidence'
  | 'missing-question';

export interface SemanticConformanceVariant {
  kind: SemanticConformanceVariantKind;
  request: DecisionRequest;
  /**
   * The variant whose answers this one is compared against: `baseline`, or
   * `opaque-option-ids` for an option permutation applied over opaque ids.
   */
  comparesWith: SemanticConformanceVariantKind;
  /** Maps transformed option ids (`question:option`) back to baseline ids. */
  optionIdMap?: Record<string, string>;
}

/** A probe that would have sent the provider the baseline request unchanged. */
export interface SemanticConformanceSkippedVariant {
  kind: SemanticConformanceVariantKind;
  reason: string;
}

export interface SemanticConformanceProbes {
  variants: SemanticConformanceVariant[];
  notApplicable: SemanticConformanceSkippedVariant[];
}

/**
 * Generates deterministic probes for semantic stability. The probes do not
 * declare a provider conformant by themselves; callers must compare outputs
 * against workload-specific tolerances and labelled truth.
 *
 * Choice options travel as a JSON object, and ECMAScript enumerates
 * integer-like keys (`"1"`, `"2"`) in ascending numeric order whatever their
 * insertion order, so reversing such options would serialise exactly like the
 * baseline. When any choice question has options whose order a reversal
 * cannot change, the permutation is applied over the opaque-id rebinding and
 * compared with the `opaque-option-ids` variant, which isolates the order
 * effect. A probe whose request would equal the baseline (no choice
 * questions, state already empty) is listed in `notApplicable` with the
 * reason instead of being emitted.
 */
export function buildSemanticConformanceVariants(
  request: DecisionRequest,
  options: {
    paraphraseInstructions?: (instructions: string) => string;
    noEvidenceState?: DecisionRequest['state'];
  } = {},
): SemanticConformanceProbes {
  const variants: SemanticConformanceVariant[] = [
    { kind: 'baseline', request, comparesWith: 'baseline' },
  ];
  const notApplicable: SemanticConformanceSkippedVariant[] = [];
  const baselineJson = JSON.stringify(request);
  const push = (variant: SemanticConformanceVariant, reason: string) => {
    if (JSON.stringify(variant.request) === baselineJson) {
      notApplicable.push({ kind: variant.kind, reason });
    } else {
      variants.push(variant);
    }
  };

  const opaque = opaqueChoiceQuestions(request.questions);
  const reversed = reverseChoiceOptions(request.questions);
  push(
    reversed.orderChanged
      ? {
          kind: 'option-permutation',
          request: { ...request, questions: reversed.questions },
          comparesWith: 'baseline',
        }
      : {
          kind: 'option-permutation',
          request: {
            ...request,
            questions: reverseChoiceOptions(opaque.questions).questions,
          },
          comparesWith: 'opaque-option-ids',
          optionIdMap: opaque.optionIdMap,
        },
    'The request has no choice question whose options can be reordered.',
  );
  push(
    {
      kind: 'opaque-option-ids',
      request: { ...request, questions: opaque.questions },
      comparesWith: 'baseline',
      optionIdMap: opaque.optionIdMap,
    },
    'The request has no choice question whose option ids can be rebound.',
  );

  if (options.paraphraseInstructions) {
    const paraphrase = options.paraphraseInstructions;
    push(
      {
        kind: 'rubric-paraphrase',
        request: {
          ...request,
          questions: mapQuestions(request.questions, (question) => ({
            ...question,
            instructions: paraphrase(question.instructions),
          })),
        },
        comparesWith: 'baseline',
      },
      'The paraphrase returned every instruction unchanged.',
    );
  }

  push(
    {
      kind: 'no-evidence',
      request: { ...request, state: options.noEvidenceState ?? null },
      comparesWith: 'baseline',
    },
    'The baseline state already equals the no-evidence state.',
  );

  push(
    {
      kind: 'missing-question',
      request: {
        ...request,
        questions: mapQuestions(request.questions, (question) => ({
          ...question,
          instructions: MISSING_QUESTION_INSTRUCTIONS,
        })),
      },
      comparesWith: 'baseline',
    },
    'Every question already carries only the generic instruction.',
  );

  return { variants, notApplicable };
}

const MISSING_QUESTION_INSTRUCTIONS =
  'Choose only from the declared answer space.';

/**
 * Reverses every choice question's options and reports whether the key order
 * a serialiser would emit changed for every choice question. Integer-like
 * keys are enumerated in numeric order, so their reversal is a no-op.
 */
function reverseChoiceOptions(questions: Record<string, DecisionQuestion>): {
  questions: Record<string, DecisionQuestion>;
  orderChanged: boolean;
} {
  let orderChanged = true;
  let anyChoice = false;
  const reversed = mapQuestions(questions, (question) => {
    if (question.kind !== 'choice') return question;
    anyChoice = true;
    const options = Object.fromEntries(
      Object.entries(question.options).reverse(),
    );
    const before = Object.keys(question.options);
    const after = Object.keys(options);
    if (before.every((key, index) => key === after[index])) {
      orderChanged = false;
    }
    return { ...question, options };
  });
  return { questions: reversed, orderChanged: anyChoice && orderChanged };
}

function mapQuestions(
  questions: Record<string, DecisionQuestion>,
  map: (question: DecisionQuestion) => DecisionQuestion,
): Record<string, DecisionQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, map(question)]),
  );
}

function opaqueChoiceQuestions(questions: Record<string, DecisionQuestion>): {
  questions: Record<string, DecisionQuestion>;
  optionIdMap: Record<string, string>;
} {
  const optionIdMap: Record<string, string> = {};
  const transformed = Object.fromEntries(
    Object.entries(questions).map(([questionId, question]) => {
      if (question.kind !== 'choice') return [questionId, question];

      const options = Object.entries(question.options).map(
        ([originalId, description], index) => {
          const opaqueId = `opt_${index + 1}`;
          optionIdMap[`${questionId}:${opaqueId}`] = originalId;
          return [opaqueId, description] as const;
        },
      );
      const next: ChoiceDecisionQuestion = {
        ...question,
        options: Object.fromEntries(options),
      };
      return [questionId, next];
    }),
  );

  return { questions: transformed, optionIdMap };
}
