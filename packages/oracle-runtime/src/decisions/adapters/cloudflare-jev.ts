import type {
  DecisionAdapter,
  DecisionProviderOptions,
  DecisionProviderResult,
  DecisionQuestion,
  DecisionRequest,
} from '@ixo/common';
import { z } from 'zod';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com';
const JEV_MODEL = 'typesafe/jev';

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
  model: z.string().optional(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

type JevResult = z.infer<typeof jevResultSchema>;

export interface CloudflareJevAdapterOptions {
  accountId: string;
  apiToken: string;
  gatewayId?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class CloudflareJevDecisionError extends Error {
  readonly provider = 'cloudflare';
  readonly status?: number;
  readonly code?: string | number;

  constructor(
    message: string,
    opts: { status?: number; code?: string | number; cause?: unknown } = {},
  ) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = 'CloudflareJevDecisionError';
    this.status = opts.status;
    this.code = opts.code;
  }
}

export class CloudflareJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'cloudflare';
  readonly model = JEV_MODEL;

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly gatewayId?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CloudflareJevAdapterOptions) {
    if (!options.accountId.trim()) {
      throw new TypeError(
        'CloudflareJevDecisionAdapter accountId is required.',
      );
    }
    if (!options.apiToken.trim()) {
      throw new TypeError(
        'CloudflareJevDecisionAdapter apiToken is required.',
      );
    }

    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.gatewayId = options.gatewayId?.trim() || undefined;
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };
    if (this.gatewayId) {
      headers['cf-aig-gateway-id'] = this.gatewayId;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/client/v4/accounts/${encodeURIComponent(\n          this.accountId,\n        )}/ai/run`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: JEV_MODEL,
            input: toJevInput(request),
          }),
          signal: options?.signal,
        },
      );
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new CloudflareJevDecisionError(
        'Cloudflare Jev request failed before a response was received.',
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new CloudflareJevDecisionError(
        'Cloudflare Jev request returned a non-success HTTP status.',
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new CloudflareJevDecisionError(
        'Cloudflare Jev response was not valid JSON.',
        { status: response.status, cause: error },
      );
    }

    const resultPayload = unwrapCloudflareEnvelope(payload, response.status);
    const parsed = jevResultSchema.safeParse(resultPayload);
    if (!parsed.success) {
      throw new CloudflareJevDecisionError(
        'Cloudflare Jev response did not match the expected decision schema.',
        { status: response.status },
      );
    }

    return normalizeJevResult(parsed.data);
  }
}

function toJevInput(request: DecisionRequest): {
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

function unwrapCloudflareEnvelope(payload: unknown, status: number): unknown {
  if (!isRecord(payload)) return payload;

  const looksLikeEnvelope = 'success' in payload || 'result' in payload;
  if (!looksLikeEnvelope) return payload;

  if (payload.success === false) {
    throw new CloudflareJevDecisionError(
      'Cloudflare Jev request was rejected by the provider.',
      {
        status,
        code: firstCloudflareErrorCode(payload.errors),
      },
    );
  }

  if (!('result' in payload)) {
    throw new CloudflareJevDecisionError(
      'Cloudflare Jev response envelope did not contain a result.',
      { status },
    );
  }

  return payload.result;
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
