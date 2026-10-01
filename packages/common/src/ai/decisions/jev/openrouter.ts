import type {
  DecisionAdapter,
  DecisionProviderOptions,
  DecisionProviderResult,
  DecisionRequest,
} from '../types.js';
import {
  JEV_MODEL_OPENROUTER,
  JevDecisionError,
  parseJevResult,
  toJevQuestions,
} from './wire.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai';

export interface OpenRouterJevAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Extra request headers, e.g. OpenRouter's `HTTP-Referer` / `X-Title`. */
  headers?: Record<string, string>;
}

/** Runs Jev through OpenRouter's decisions endpoint. */
export class OpenRouterJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'openrouter';
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenRouterJevAdapterOptions) {
    if (!options.apiKey.trim()) {
      throw new TypeError('OpenRouterJevDecisionAdapter apiKey is required.');
    }

    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || JEV_MODEL_OPENROUTER;
    this.baseUrl = (options.baseUrl ?? OPENROUTER_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = { ...options.headers };
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/alpha/decisions`, {
        method: 'POST',
        headers: {
          ...this.extraHeaders,
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          state: request.state,
          questions: toJevQuestions(request),
        }),
        signal: options?.signal,
      });
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new JevDecisionError(
        this.provider,
        'OpenRouter Jev request failed before a response was received.',
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new JevDecisionError(
        this.provider,
        'OpenRouter Jev request returned a non-success HTTP status.',
        {
          status: response.status,
          code: await readOpenRouterErrorCode(response),
        },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new JevDecisionError(
        this.provider,
        'OpenRouter Jev response was not valid JSON.',
        { status: response.status, cause: error },
      );
    }

    return parseJevResult(payload, this.provider, response.status);
  }
}

/**
 * Extracts `error.code` from an OpenRouter error body. Only the code is kept;
 * the accompanying message is dropped so provider text is never echoed.
 */
async function readOpenRouterErrorCode(
  response: Response,
): Promise<string | number | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }
  const { error } = body;
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' || typeof code === 'number'
    ? code
    : undefined;
}
