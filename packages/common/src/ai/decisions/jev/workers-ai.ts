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

/**
 * Structural view of the Cloudflare Workers AI binding (`env.AI`). Declared
 * here so this package does not depend on the Workers type definitions.
 */
export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface WorkersAiJevAdapterOptions {
  ai: WorkersAiBinding;
  model?: string;
}

/**
 * Runs Jev through the Workers AI binding available inside a Cloudflare
 * Worker. The binding authenticates implicitly, so no account id or token is
 * required.
 */
export class WorkersAiJevDecisionAdapter implements DecisionAdapter {
  readonly provider = 'cloudflare';
  readonly model: string;

  private readonly ai: WorkersAiBinding;

  constructor(options: WorkersAiJevAdapterOptions) {
    this.ai = options.ai;
    this.model = options.model?.trim() || JEV_MODEL_CLOUDFLARE;
  }

  async evaluate(
    request: DecisionRequest,
    options?: DecisionProviderOptions,
  ): Promise<DecisionProviderResult> {
    let payload: unknown;
    try {
      payload = await this.ai.run(this.model, {
        state: request.state,
        questions: toJevQuestions(request),
      });
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new JevDecisionError(
        this.provider,
        'Workers AI Jev request failed.',
        { cause: error },
      );
    }

    return parseJevResult(payload, this.provider);
  }
}
