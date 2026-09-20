import type {
  DecisionAdapter,
  DecisionProviderOptions,
  DecisionProviderResult,
  DecisionRequest,
} from '../index.js';
import { parseJevResult, toJevInput, validateJevRequest } from './jev.js';
import {
  requestJson,
  validateEndpoint,
  ProviderHttpError,
} from './transport.js';

export interface OpenRouterJevAdapterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenRouterJevDecisionError extends Error {
  readonly provider = 'openrouter';
  constructor(readonly status?: number) {
    super('OpenRouter Jev request or response validation failed.');
    this.name = 'OpenRouterJevDecisionError';
  }
}

export class OpenRouterJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'openrouter';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenRouterJevAdapterOptions) {
    if (!options.apiKey.trim())
      throw new TypeError('OpenRouter Jev apiKey is required.');
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() ?? 'typesafe/jev-1.13';
    if (!/^typesafe\/jev-\d+\.\d+(?:[.\d-]*)$/.test(this.model)) {
      throw new TypeError(
        'OpenRouter Jev requires a versioned typesafe/jev model.',
      );
    }
    this.baseUrl = (options.baseUrl ?? 'https://openrouter.ai').replace(
      /\/$/,
      '',
    );
    validateEndpoint(this.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    validateJevRequest(request);
    try {
      const payload = await requestJson(
        this.fetchImpl,
        `${this.baseUrl}/api/alpha/decisions`,
        {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        {
          model: this.model,
          ...toJevInput(request),
          provider: { allow_fallbacks: false, data_collection: 'deny' },
        },
        options?.signal,
      );
      return parseJevResult(payload, request);
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw new DOMException('Decision cancelled or timed out.', error.name);
      }
      throw new OpenRouterJevDecisionError(
        error instanceof ProviderHttpError ? error.status : undefined,
      );
    }
  }
}
