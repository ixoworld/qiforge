import {
  type DecisionProviderResult,
  type DecisionQuestion,
  type DecisionRequest,
} from '../types.js';
import {
  validateDecisionProviderResult,
  validateDecisionRequest,
} from '../validation.js';
import { z } from 'zod';
const jevNoulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number(),
});

const jevChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const jevScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number(),
  legend: z.record(z.string(), z.string()).optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

const jevAnswerSchema = z.discriminatedUnion('type', [
  jevNoulAnswerSchema,
  jevChoiceAnswerSchema,
  jevScoreAnswerSchema,
]);

const jevResultSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@~-]{0,199}$/),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

type JevResult = z.infer<typeof jevResultSchema>;

export function toJevInput(request: DecisionRequest): {
  state: DecisionRequest['state'];
  questions: Record<string, unknown>;
} {
  return {
    state: request.state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => [
        name,
        toJevQuestion(question),
      ]),
    ),
  };
}

function toJevQuestion(question: DecisionQuestion): Record<string, unknown> {
  switch (question.kind) {
    case 'boolean':
      return {
        type: 'noul',
        instructions: question.instructions,
        ...(question.criteria ? { criteria: question.criteria } : {}),
      };
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: question.options,
      };
    case 'ordinal':
      return {
        type: 'score',
        instructions: question.instructions,
        criteria: question.levels,
      };
  }
}

function normalizeJevResult(result: JevResult): DecisionProviderResult {
  const answers = Object.fromEntries(
    Object.entries(result.answers).map(([name, answer]) => {
      switch (answer.type) {
        case 'noul':
          return [
            name,
            {
              kind: 'boolean' as const,
              probabilityTrue: answer.noul,
            },
          ];
        case 'choice':
          return [
            name,
            {
              kind: 'choice' as const,
              value: answer.choice,
              confidence: answer.confidence,
              probabilities: answer.probabilities,
            },
          ];
        case 'score':
          return [
            name,
            {
              kind: 'ordinal' as const,
              score: answer.score,
              confidence: answer.confidence,
              ...(answer.probabilities
                ? { probabilities: answer.probabilities }
                : {}),
            },
          ];
      }
    }),
  );

  return {
    answers,
    ...(result.model ? { modelVersion: result.model } : {}),
    ...(result.usage
      ? {
          usage: {
            ...(result.usage.input_tokens === undefined
              ? {}
              : { inputTokens: result.usage.input_tokens }),
            ...(result.usage.output_tokens === undefined
              ? {}
              : { outputTokens: result.usage.output_tokens }),
          },
        }
      : {}),
  };
}

export function parseJevResult(
  payload: unknown,
  request: DecisionRequest,
): DecisionProviderResult {
  const parsed = jevResultSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error('Jev response did not match the expected decision schema.');
  const result = normalizeJevResult(parsed.data);
  validateDecisionProviderResult(request, result);
  return result;
}
export function validateJevRequest(request: DecisionRequest): void {
  validateDecisionRequest(request);
  if (
    request.state === null ||
    !['object', 'string'].includes(typeof request.state)
  ) {
    throw new TypeError('Jev state must be a string, object or array.');
  }
}
