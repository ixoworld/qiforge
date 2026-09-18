import {
  validateDecisionProviderResult,
  validateDecisionRequest,
  type DecisionAdapter,
  type DecisionDefinition,
  type DecisionEvaluateOptions,
  type DecisionEvaluation,
  type DecisionRegistration,
  type DecisionRequest,
} from '@ixo/common';
import type { Logger } from '../plugin-api/types.js';
import type { DecisionRegistry } from '../registries/decision-registry.js';

export const DEFAULT_DECISION_TIMEOUT_MS = 5_000;

export interface DecisionEvaluator {
  evaluate<TInput>(
    definition: DecisionDefinition<TInput>,
    input: TInput,
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
      'No DecisionAdapter is configured. Supply createOracleApp({ decisionAdapter }) or configure a test decision mock.',
    );
    this.name = 'DecisionProviderUnavailableError';
  }
}

export class DecisionRuntime implements DecisionEvaluator {
  constructor(
    private readonly registry: DecisionRegistry,
    private readonly adapter?: DecisionAdapter,
    private readonly logger?: Pick<Logger, 'debug' | 'warn'>,
  ) {}

  evaluate<TInput>(
    definition: DecisionDefinition<TInput>,
    input: TInput,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation> {
    return this.evaluatePrepared(
      definition,
      definition.prepare(input),
      options,
    );
  }

  evaluateByName(
    name: string,
    input: unknown,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation> {
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
      const result = await Promise.race([
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

      validateDecisionProviderResult(request, result);

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
        ...(result.modelVersion
          ? { modelVersion: result.modelVersion }
          : {}),
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
