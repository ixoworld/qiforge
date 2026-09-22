import type { z } from 'zod';
import type {
  DecisionAdapter,
  DecisionDefinition,
  DecisionEvaluateOptions,
  DecisionEvaluation,
  DecisionRegistration,
  DecisionRequest,
} from './types.js';
import {
  validateDecisionProviderResult,
  validateDecisionRequest,
} from './validation.js';

export const DEFAULT_DECISION_TIMEOUT_MS = 5_000;

export interface DecisionRuntimeLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

/**
 * Minimal read view over a decision registry. Each runtime owns its own
 * registry implementation; the runtime only needs to resolve a name to the
 * registration that prepares the request.
 */
export interface DecisionLookup {
  get(name: string): { decision: DecisionRegistration } | undefined;
}

export interface DecisionEvaluator {
  evaluate<TSchema extends z.ZodType>(
    definition: DecisionDefinition<TSchema>,
    input: z.input<TSchema>,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation>;
  evaluateByName(
    name: string,
    input: unknown,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation>;
}

export class DecisionProviderUnavailableError extends Error {
  constructor() {
    super(
      'No DecisionAdapter is configured. Set DECISION_PROVIDER (openrouter-jev or cloudflare-jev), pass a decisionAdapter to the runtime, or configure a test decision mock.',
    );
    this.name = 'DecisionProviderUnavailableError';
  }
}

export class DecisionRuntime implements DecisionEvaluator {
  constructor(
    private readonly registry?: DecisionLookup,
    private readonly adapter?: DecisionAdapter,
    private readonly logger?: DecisionRuntimeLogger,
  ) {}

  async evaluate<TSchema extends z.ZodType>(
    definition: DecisionDefinition<TSchema>,
    input: z.input<TSchema>,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation> {
    return this.evaluatePrepared(
      definition,
      definition.prepare(input),
      options,
    );
  }

  async evaluateByName(
    name: string,
    input: unknown,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation> {
    if (!this.registry) {
      throw new Error('No DecisionRegistry is configured.');
    }
    const entry = this.registry.get(name);
    if (!entry) {
      throw new Error(`Decision "${name}" is not registered.`);
    }
    return this.evaluatePrepared(
      entry.decision,
      entry.decision.prepare(input),
      options,
    );
  }

  private async evaluatePrepared(
    registration: DecisionRegistration,
    request: DecisionRequest,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation> {
    if (!this.adapter) throw new DecisionProviderUnavailableError();

    // `defineDecision` already validates inside `prepare`; this second pass is
    // the safety net for hand-written `DecisionRegistration.prepare`
    // implementations so no adapter ever receives an unbounded request.
    validateDecisionRequest(request);

    const timeoutMs =
      options?.timeoutMs ??
      registration.timeoutMs ??
      DEFAULT_DECISION_TIMEOUT_MS;
    const controller = new AbortController();
    const sourceSignal = options?.signal;

    if (sourceSignal?.aborted) {
      controller.abort(sourceSignal.reason);
    }
    const forwardAbort = () => controller.abort(sourceSignal?.reason);
    sourceSignal?.addEventListener('abort', forwardAbort, { once: true });

    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.adapter.evaluate(request, { signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort(
              new Error(`Decision timed out after ${timeoutMs}ms`),
            );
            reject(new Error(`Decision timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);

      const result = validateDecisionProviderResult(request, raw);

      const latencyMs = Date.now() - started;
      this.logger?.debug?.(
        `[decisions] name=${registration.name} provider=${this.adapter.provider} model=${this.adapter.model} latencyMs=${latencyMs}`,
      );

      return {
        decision: {
          name: registration.name,
          version: registration.version,
        },
        provider: this.adapter.provider,
        model: this.adapter.model,
        ...(result.modelVersion ? { modelVersion: result.modelVersion } : {}),
        answers: result.answers,
        latencyMs,
        ...(result.usage ? { usage: result.usage } : {}),
        evaluatedAt: new Date().toISOString(),
      };
    } finally {
      if (timer) clearTimeout(timer);
      sourceSignal?.removeEventListener('abort', forwardAbort);
    }
  }
}

/**
 * Evaluator used when no adapter is configured: every call rejects with
 * `DecisionProviderUnavailableError` so callers get one consistent failure.
 */
export const UNAVAILABLE_DECISION_EVALUATOR: DecisionEvaluator = {
  async evaluate() {
    throw new DecisionProviderUnavailableError();
  },
  async evaluateByName() {
    throw new DecisionProviderUnavailableError();
  },
};
