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
  /** Maps transformed option ids back to baseline ids. */
  optionIdMap?: Record<string, string>;
}

/**
 * Generates deterministic probes for semantic stability. The probes do not
 * declare a provider conformant by themselves; callers must compare outputs
 * against workload-specific tolerances and labelled truth.
 */
export function buildSemanticConformanceVariants(
  request: DecisionRequest,
  options: {
    paraphraseInstructions?: (instructions: string) => string;
    noEvidenceState?: DecisionRequest['state'];
  } = {},
): SemanticConformanceVariant[] {
  const variants: SemanticConformanceVariant[] = [
    { kind: 'baseline', request },
    {
      kind: 'option-permutation',
      request: {
        ...request,
        questions: mapQuestions(request.questions, (question) =>
          question.kind === 'choice'
            ? {
                ...question,
                options: Object.fromEntries(
                  Object.entries(question.options).reverse(),
                ),
              }
            : question,
        ),
      },
    },
  ];

  const opaque = opaqueChoiceQuestions(request.questions);
  variants.push({
    kind: 'opaque-option-ids',
    request: { ...request, questions: opaque.questions },
    optionIdMap: opaque.optionIdMap,
  });

  if (options.paraphraseInstructions) {
    variants.push({
      kind: 'rubric-paraphrase',
      request: {
        ...request,
        questions: mapQuestions(request.questions, (question) => ({
          ...question,
          instructions: options.paraphraseInstructions!(
            question.instructions,
          ),
        })),
      },
    });
  }

  variants.push({
    kind: 'no-evidence',
    request: {
      ...request,
      state: options.noEvidenceState ?? null,
    },
  });

  variants.push({
    kind: 'missing-question',
    request: {
      ...request,
      questions: mapQuestions(request.questions, (question) => ({
        ...question,
        instructions: 'Choose only from the declared answer space.',
      })),
    },
  });

  return variants;
}

function mapQuestions(
  questions: Record<string, DecisionQuestion>,
  map: (question: DecisionQuestion) => DecisionQuestion,
): Record<string, DecisionQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, map(question)]),
  );
}

function opaqueChoiceQuestions(
  questions: Record<string, DecisionQuestion>,
): {
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
