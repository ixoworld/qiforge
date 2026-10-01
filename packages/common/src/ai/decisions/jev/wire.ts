import { z } from 'zod';
import type {
  DecisionAnswer,
  DecisionProviderResult,
  DecisionQuestion,
  DecisionRequest,
  DecisionUsage,
} from '../types.js';

/** Model id accepted by the Cloudflare Workers AI catalog. */
export const JEV_MODEL_CLOUDFLARE = 'typesafe/jev';
/** Model id accepted by the OpenRouter decisions endpoint. */
export const JEV_MODEL_OPENROUTER = 'typesafe/jev-1.13';

export type JevProviderName = 'cloudflare' | 'openrouter';

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion =
  | JevNoulQuestion
  | JevChoiceQuestion
  | JevScoreQuestion;

/**
 * Error raised by every Jev transport. Messages are fixed strings: they never
 * carry the projected state, request bodies, credentials or text echoed by the
 * provider, so they are safe to log and to surface to callers.
 */
export class JevDecisionError extends Error {
  readonly provider: JevProviderName;
  readonly status?: number;
  readonly code?: string | number;

  constructor(
    provider: JevProviderName,
    message: string,
    opts: { status?: number; code?: string | number; cause?: unknown } = {},
  ) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = 'JevDecisionError';
    this.provider = provider;
    this.status = opts.status;
    this.code = opts.code;
  }
}

/**
 * Maps the provider-neutral questions to Jev's wire questions.
 *
 * Jev's noul question takes instructions only, so boolean criteria are folded
 * into the instructions text instead of being sent as a separate field.
 */
export function toJevQuestions(
  request: DecisionRequest,
): Record<string, JevQuestion> {
  return Object.fromEntries(
    Object.entries(request.questions).map(([name, question]) => [
      name,
      toJevQuestion(question),
    ]),
  );
}

function toJevQuestion(question: DecisionQuestion): JevQuestion {
  switch (question.kind) {
    case 'boolean':
      return {
        type: 'noul',
        instructions: foldBooleanCriteria(
          question.instructions,
          question.criteria,
        ),
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

function foldBooleanCriteria(
  instructions: string,
  criteria: { true?: string; false?: string } | undefined,
): string {
  const lines = [instructions];
  if (criteria?.true?.trim()) {
    lines.push(`Answer true when: ${criteria.true.trim()}`);
  }
  if (criteria?.false?.trim()) {
    lines.push(`Answer false when: ${criteria.false.trim()}`);
  }
  return lines.join('\n');
}

const jevNoulAnswerSchema = z.looseObject({
  type: z.literal('noul'),
  noul: z.number(),
});

const jevChoiceAnswerSchema = z.looseObject({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const jevScoreAnswerSchema = z.looseObject({
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

/**
 * Usage reporting differs per transport (Cloudflare uses `input_tokens`,
 * OpenRouter's alpha endpoint may use `prompt_tokens`), so both spellings are
 * accepted and unknown fields are ignored.
 */
const jevUsageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  cost: z.number().optional(),
});

export const jevResultSchema = z.looseObject({
  model: z.string().optional(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: jevUsageSchema.optional(),
  provider: z.string().optional(),
});

export type JevResult = z.infer<typeof jevResultSchema>;

export function normalizeJevResult(parsed: JevResult): DecisionProviderResult {
  const answers = Object.fromEntries(
    Object.entries(parsed.answers).map(([name, answer]) => [
      name,
      normalizeJevAnswer(answer),
    ]),
  );

  return {
    answers,
    ...(parsed.model ? { modelVersion: parsed.model } : {}),
    ...(parsed.usage ? { usage: normalizeJevUsage(parsed.usage) } : {}),
  };
}

function normalizeJevAnswer(
  answer: JevResult['answers'][string],
): DecisionAnswer {
  switch (answer.type) {
    case 'noul':
      return { kind: 'boolean', probabilityTrue: answer.noul };
    case 'choice':
      return {
        kind: 'choice',
        value: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      };
    case 'score':
      return {
        kind: 'ordinal',
        score: answer.score,
        confidence: answer.confidence,
        ...(answer.probabilities
          ? { probabilities: answer.probabilities }
          : {}),
      };
  }
}

function normalizeJevUsage(
  usage: NonNullable<JevResult['usage']>,
): DecisionUsage {
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/**
 * Cloudflare's REST API wraps results in `{ success, errors, result }`; the
 * Workers AI binding may return the result directly. Payloads that do not look
 * like an envelope pass through untouched.
 */
export function unwrapCloudflareEnvelope(
  payload: unknown,
  provider: JevProviderName,
  status?: number,
): unknown {
  if (!isRecord(payload)) return payload;

  const looksLikeEnvelope = 'success' in payload || 'result' in payload;
  if (!looksLikeEnvelope) return payload;

  if (payload.success === false) {
    throw new JevDecisionError(
      provider,
      'Jev request was rejected by the provider.',
      {
        status,
        code: firstCloudflareErrorCode(payload.errors),
      },
    );
  }

  if (!('result' in payload)) {
    throw new JevDecisionError(
      provider,
      'Jev response envelope did not contain a result.',
      { status },
    );
  }

  return payload.result;
}

export function parseJevResult(
  payload: unknown,
  provider: JevProviderName,
  status?: number,
): DecisionProviderResult {
  const resultPayload = unwrapCloudflareEnvelope(payload, provider, status);
  const parsed = jevResultSchema.safeParse(resultPayload);
  if (!parsed.success) {
    throw new JevDecisionError(
      provider,
      'Jev response did not match the expected decision schema.',
      { status },
    );
  }
  return normalizeJevResult(parsed.data);
}

function firstCloudflareErrorCode(
  errors: unknown,
): string | number | undefined {
  if (!Array.isArray(errors)) return undefined;
  const first = errors[0];
  if (!isRecord(first)) return undefined;
  return typeof first.code === 'string' || typeof first.code === 'number'
    ? first.code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
