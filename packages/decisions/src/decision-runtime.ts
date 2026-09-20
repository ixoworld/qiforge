import {
  type DecisionAdapter,
  type DecisionDefinition,
  type DecisionEvaluateOptions,
  type DecisionEvaluation,
  type DecisionRegistration,
  type DecisionRequest,
} from './types.js';
import {
  validateDecisionProviderResult,
  validateDecisionRequest,
} from './validation.js';
import type { z } from 'zod';
export interface DecisionLookup {
  get(name: string): { decision: DecisionRegistration } | undefined;
}

export interface DecisionLogger {
  debug?(message: string): void;
  warn(message: string): void;
}

export const DEFAULT_DECISION_TIMEOUT_MS = 5_000;

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
      'No DecisionAdapter is configured. Supply createOracleApp({ decisionAdapter }) or configure a test decision mock.',
    );
    this.name = 'DecisionProviderUnavailableError';
  }
}

export class DecisionRuntime implements DecisionEvaluator {
  constructor(
    private readonly registry?: DecisionLookup,
    private readonly adapter?: DecisionAdapter,
    private readonly logger?: DecisionLogger,
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

  private inFlight = 0;

  private async evaluatePrepared(
    registration: DecisionRegistration,
    request: DecisionRequest,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation> {
    if (!this.adapter) throw new DecisionProviderUnavailableError();
    if (options?.signal?.aborted)
      throw new DOMException('Decision cancelled.', 'AbortError');
    validateDecisionRequest(request);
    // Isolate caller-owned input and the validation contract from adapter mutation.
    const prepared = structuredClone(request);
    const timeoutMs =
      options?.timeoutMs ??
      registration.timeoutMs ??
      DEFAULT_DECISION_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      throw new RangeError(
        'Decision timeout must be an integer from 1 to 30000ms.',
      );
    }
    if (this.inFlight >= 8)
      throw new Error('Decision concurrency limit reached.');
    const controller = new AbortController();
    const sourceSignal = options?.signal;
    const started = Date.now();
    const forwardAbort = () =>
      controller.abort(new DOMException('Decision cancelled.', 'AbortError'));
    sourceSignal?.addEventListener('abort', forwardAbort, { once: true });
    let rejectAbort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new DOMException('Decision cancelled.', 'AbortError'),
        );
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Decision timed out.', 'TimeoutError'));
    }, timeoutMs);
    this.inFlight++;
    try {
      const provider = this.adapter.provider;
      const model = this.adapter.model;
      const adapter = this.adapter;
      const pending = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return adapter
            .evaluate(structuredClone(prepared), { signal: controller.signal })
            .catch(() => {
              controller.signal.throwIfAborted();
              throw new Error('Decision provider evaluation failed.');
            });
        })
        .finally(() => {
          this.inFlight--;
        });
      // Keep the admission slot until an adapter actually settles, even when it
      // ignores cancellation. Otherwise timeouts allow unbounded orphan work.
      const result = await Promise.race([pending, cancelled]);
      controller.signal.throwIfAborted();
      validateDecisionProviderResult(prepared, result);
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(prepared)),
      );
      const requestHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      controller.signal.throwIfAborted();
      const latencyMs = Date.now() - started;
      this.logger?.debug?.(
        `[decisions] name=${registration.name} provider=${provider} model=${model} latencyMs=${latencyMs}`,
      );
      return {
        requestHash,
        decision: { name: registration.name, version: registration.version },
        provider,
        model,
        ...(result.modelVersion ? { modelVersion: result.modelVersion } : {}),
        answers: result.answers,
        latencyMs,
        ...(result.usage ? { usage: result.usage } : {}),
        evaluatedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
      sourceSignal?.removeEventListener('abort', forwardAbort);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
}

/** A per-turn signal remains authoritative even when a caller adds its own. */
export function scopeDecisions(
  runtime: DecisionEvaluator,
  signal: AbortSignal,
): DecisionEvaluator {
  const optionsFor = (
    options?: DecisionEvaluateOptions,
  ): DecisionEvaluateOptions => ({
    ...options,
    signal: options?.signal
      ? AbortSignal.any([signal, options.signal])
      : signal,
  });
  return {
    evaluate: (definition, input, options) =>
      runtime.evaluate(definition, input, optionsFor(options)),
    evaluateByName: (name, input, options) =>
      runtime.evaluateByName(name, input, optionsFor(options)),
  };
}
