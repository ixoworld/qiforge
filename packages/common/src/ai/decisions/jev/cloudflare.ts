import type {
  DecisionAdapter,
  DecisionProviderOptions,
  DecisionProviderResult,
  DecisionRequest,
} from '../types.js';
import {
  JEV_MODEL_CLOUDFLARE,
  JevDecisionError,
  parseJevResult,
  toJevQuestions,
} from './wire.js';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com';

export interface CloudflareJevAdapterOptions {
  accountId: string;
  apiToken: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Runs Jev through the Cloudflare Workers AI REST API. Suitable for any
 * runtime with `fetch`; inside a Worker prefer `WorkersAiJevDecisionAdapter`
 * so no API token is needed.
 */
export class CloudflareJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'cloudflare';
  readonly model: string;

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CloudflareJevAdapterOptions) {
    if (!options.accountId.trim()) {
      throw new TypeError(
        'CloudflareJevDecisionAdapter accountId is required.',
      );
    }
    if (!options.apiToken.trim()) {
      throw new TypeError('CloudflareJevDecisionAdapter apiToken is required.');
    }

    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.model = options.model?.trim() || JEV_MODEL_CLOUDFLARE;
    this.baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/client/v4/accounts/${encodeURIComponent(
          this.accountId,
        )}/ai/run`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            input: {
              state: request.state,
              questions: toJevQuestions(request),
            },
          }),
          signal: options?.signal,
        },
      );
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new JevDecisionError(
        this.provider,
        'Cloudflare Jev request failed before a response was received.',
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new JevDecisionError(
        this.provider,
        'Cloudflare Jev request returned a non-success HTTP status.',
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new JevDecisionError(
        this.provider,
        'Cloudflare Jev response was not valid JSON.',
        { status: response.status, cause: error },
      );
    }

    return parseJevResult(payload, this.provider, response.status);
  }
}
