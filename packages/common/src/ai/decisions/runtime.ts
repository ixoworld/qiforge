import { RunnableLambda } from '@langchain/core/runnables';
import type { z } from 'zod';
import {
  DecisionNotApplicableError,
  DecisionProviderUnavailableError,
} from './errors.js';
import {
  DecisionProviderRegistry,
  DecisionProviderRouter,
  HOST_DECISION_PROVIDER_ID,
} from './provider-router.js';
import type {
  DecisionAdapter,
  DecisionApplicability,
  DecisionDefinition,
  DecisionEvaluateOptions,
  DecisionEvaluation,
  DecisionJudgmentMethod,
  DecisionRegistration,
  DecisionRequest,
} from './types.js';
import {
  validateDecisionProviderResult,
  validateDecisionRequest,
} from './validation.js';

export {
  DecisionNotApplicableError,
  DecisionProviderUnavailableError,
} from './errors.js';

const FULLY_APPLICABLE: DecisionApplicability = {
  applicable: true,
  evidenceComplete: true,
};

const PROVIDER_NATIVE: DecisionJudgmentMethod = { kind: 'provider-native' };

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

export class DecisionRuntime implements DecisionEvaluator {
  private readonly providers?: DecisionProviderRouter;

  /**
   * `providers` is either a provider router (several configured providers and
   * a selection policy) or a single adapter, which is registered as the
   * default provider with id `HOST_DECISION_PROVIDER_ID` (`host`), the same
   * id and selection the Workers runtime records for `decisionAdapter`.
   */
  constructor(
    private readonly registry?: DecisionLookup,
    providers?: DecisionAdapter | DecisionProviderRouter,
    private readonly logger?: DecisionRuntimeLogger,
  ) {
    if (providers instanceof DecisionProviderRouter) {
      this.providers = providers;
    } else if (providers) {
      this.providers = new DecisionProviderRouter(
        new DecisionProviderRegistry([
          { id: HOST_DECISION_PROVIDER_ID, adapter: providers },
        ]),
        { defaultProviderId: HOST_DECISION_PROVIDER_ID },
      );
    }
  }

  async evaluate<TSchema extends z.ZodType>(
    definition: DecisionDefinition<TSchema>,
    input: z.input<TSchema>,
    options?: DecisionEvaluateOptions,
  ): Promise<DecisionEvaluation> {
    options?.signal?.throwIfAborted();
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
    options?.signal?.throwIfAborted();
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
    // `defineDecision` already validates inside `prepare`; this second pass is
    // the safety net for hand-written `DecisionRegistration.prepare`
    // implementations so no adapter ever receives an unbounded request.
    validateDecisionRequest(request);

    // Abstain before any provider is selected or called: missing evidence
    // must never come back as a negative semantic answer.
    const applicability = request.applicability ?? FULLY_APPLICABLE;
    if (!applicability.applicable || !applicability.evidenceComplete) {
      throw new DecisionNotApplicableError(applicability);
    }

    const resolution = this.providers?.resolve(
      registration.name,
      options?.providerId,
    );
    if (!resolution) throw new DecisionProviderUnavailableError();
    const providerId = resolution.provider.id;
    const providerSelection = resolution.selectedBy;
    const adapter = resolution.provider.adapter;

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
    const run = async (): Promise<DecisionEvaluation> => {
      controller.signal.throwIfAborted();
      const raw = await Promise.race([
        adapter.evaluate(request, { signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => {
            const reason: unknown = controller.signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error(String(reason ?? 'Decision cancelled')),
            );
          };
          controller.signal.addEventListener('abort', rejectAbort, {
            once: true,
          });
          if (controller.signal.aborted) rejectAbort();
          timer = setTimeout(() => {
            controller.abort(
              new Error(`Decision timed out after ${timeoutMs}ms`),
            );
            reject(new Error(`Decision timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);

      controller.signal.throwIfAborted();

      const result = validateDecisionProviderResult(request, raw);

      const latencyMs = Date.now() - started;
      this.logger?.debug?.(
        `[decisions] name=${registration.name} providerId=${providerId} selection=${providerSelection} provider=${adapter.provider} model=${adapter.model} latencyMs=${latencyMs}`,
      );

      return {
        decision: {
          name: registration.name,
          version: registration.version,
        },
        providerId,
        providerSelection,
        provider: adapter.provider,
        model: adapter.model,
        ...(result.modelVersion ? { modelVersion: result.modelVersion } : {}),
        applicability: { ...applicability },
        judgment: {
          // An adapter that declares nothing is recorded as provider-native,
          // which makes no claim that its confidence is calibrated.
          method: { ...(result.provenance?.method ?? PROVIDER_NATIVE) },
          ...(result.provenance?.calibration
            ? { calibration: { ...result.provenance.calibration } }
            : {}),
          questionSetVersion: registration.version,
        },
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
      const evaluation = await RunnableLambda.from(run).invoke(
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
            decision_provider_id: providerId,
            decision_provider_selection: providerSelection,
            decision_provider: adapter.provider,
            decision_model: adapter.model,
          },
          ...(options?.callbacks !== undefined && {
            callbacks: options.callbacks,
          }),
        },
      );
      controller.signal.throwIfAborted();
      return evaluation;
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
