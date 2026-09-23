import { RunnableLambda } from '@langchain/core/runnables';
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

    const adapter = this.adapter;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (): Promise<DecisionEvaluation> => {
      const raw = await Promise.race([
        adapter.evaluate(request, { signal: controller.signal }),
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
        `[decisions] name=${registration.name} provider=${adapter.provider} model=${adapter.model} latencyMs=${latencyMs}`,
      );

      return {
        decision: {
          name: registration.name,
          version: registration.version,
        },
        provider: adapter.provider,
        model: adapter.model,
        ...(result.modelVersion ? { modelVersion: result.modelVersion } : {}),
        answers: result.answers,
        latencyMs,
        ...(result.usage ? { usage: result.usage } : {}),
        evaluatedAt: new Date().toISOString(),
      };
    };

    try {
      // The evaluation runs as a LangChain run so an active tracer records it
      // as a span: the request as inputs, the evaluation (or the error) as
      // outputs. With no tracer attached this is a plain call. Inside a
      // LangChain run the span nests under it through the implicit run
      // config; before the graph starts (the routers) the caller passes the
      // turn's tracer in `options.callbacks`. The signal is deliberately not
      // handed to the runnable: abort and timeout stay owned by the code in
      // `run`, so callers keep seeing the same errors.
      return await RunnableLambda.from(run).invoke(
        {
          decision: registration.name,
          state: request.state,
          questions: request.questions,
        },
        {
          runName: `decision:${registration.name}`,
          tags: ['decision'],
          metadata: {
            ...options?.metadata,
            decision_name: registration.name,
            decision_version: registration.version,
            decision_provider: adapter.provider,
            decision_model: adapter.model,
          },
          ...(options?.callbacks !== undefined && {
            callbacks: options.callbacks,
          }),
        },
      );
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
