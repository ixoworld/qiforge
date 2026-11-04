import type {
  DecisionAdapter,
  DecisionProviderCapabilities,
  DecisionProviderOptions,
  DecisionProviderResult,
  DecisionRequest,
} from '../types.js';
import {
  JEV_MODEL_OPENROUTER,
  JevDecisionError,
  parseJevResult,
  systemOneInferenceProvenance,
  toJevQuestions,
} from './wire.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai';

/** Asked when the main model's request fails; a different vendor and host from Jev. */
export const OPENROUTER_FALLBACK_DECISION_MODEL =
  'microsoft/microsoft-decision-1';

export interface OpenRouterJevAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Extra request headers, e.g. OpenRouter's `HTTP-Referer` / `X-Title`. */
  headers?: Record<string, string>;
  /**
   * Model asked once more with the same request when the first model's
   * request fails (no answer, a non-2xx status, or an unreadable answer).
   * Defaults to {@link OPENROUTER_FALLBACK_DECISION_MODEL}; `null` turns it off.
   */
  fallbackModel?: string | null;
}

/** Runs Jev through OpenRouter's decisions endpoint. */
export class OpenRouterJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'openrouter';
  readonly model: string;
  readonly capabilities: DecisionProviderCapabilities;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly fallbackModel: string | null;

  constructor(options: OpenRouterJevAdapterOptions) {
    if (!options.apiKey.trim()) {
      throw new TypeError('OpenRouterJevDecisionAdapter apiKey is required.');
    }

    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || JEV_MODEL_OPENROUTER;
    // The default model id names a release (`typesafe/jev-1.13`); an override
    // may be an alias that moves, so only the default is recorded as pinned.
    this.capabilities = {
      apiDialect: 'systemone-v1',
      primitives: ['boolean', 'choice', 'ordinal'],
      answerSemantics: 'distribution',
      modelPinning: this.model === JEV_MODEL_OPENROUTER ? 'pinned' : 'unknown',
    };
    this.baseUrl = (options.baseUrl ?? OPENROUTER_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = { ...options.headers };
    const fallback =
      options.fallbackModel === undefined
        ? OPENROUTER_FALLBACK_DECISION_MODEL
        : options.fallbackModel?.trim() || null;
    this.fallbackModel = fallback === this.model ? null : fallback;
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    try {
      return await this.evaluateWith(
        this.model,
        this.capabilities.modelPinning,
        request,
        options,
      );
    } catch (error) {
      // An abort is rethrown as is, never retried.
      if (this.fallbackModel === null || !(error instanceof JevDecisionError)) {
        throw error;
      }
      return this.evaluateWith(this.fallbackModel, 'unknown', request, options);
    }
  }

  private async evaluateWith(
    model: string,
    modelPinning: DecisionProviderCapabilities['modelPinning'],
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
          model,
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

    const result = parseJevResult(payload, this.provider, response.status);
    return {
      ...result,
      provenance: {
        method: { kind: 'provider-native' },
        ...systemOneInferenceProvenance(
          model,
          result.modelVersion,
          modelPinning,
        ),
      },
    };
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
