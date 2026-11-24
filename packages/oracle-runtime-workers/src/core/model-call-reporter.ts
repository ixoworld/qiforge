/**
 * The one path every model call the runtime makes on a person's behalf is
 * reported through: a `ModelCallReport` (`src/llm/model-call.ts`) per call,
 * once, to the plugins' `onModelCall`.
 *
 * - Chat models (platform or BYO) put their call record on the reply or the
 *   error; a LangChain callback (`ModelCallReports`, used by the turn's
 *   metered adapter and by `ModelCallReporter` outside a turn) reads it when
 *   the call ends and adds the purpose, the call id (the LangChain run id of
 *   the call) and the start time.
 * - The purpose rides on the model's run metadata
 *   (`MODEL_CALL_PURPOSE_METADATA_KEY`, set with `withModelCallPurpose` or
 *   `reportingLlm`); without it the role decides (`main` → `reply`,
 *   `summarizer` → `summarization`), else `other`.
 * - A Decision is not a chat model: `reportingDecisions` wraps an evaluator
 *   and reports each evaluation from what it returns (provider, model,
 *   tokens, latency; Decisions report no cost).
 * - Attachment extraction calls the provider over HTTP and builds its report
 *   itself (`src/attachments/extract.ts`).
 */
import type {
  DecisionEvaluateOptions,
  DecisionEvaluation,
  DecisionEvaluator,
} from '@ixo/common/ai/decisions';
import { DecisionProviderUnavailableError } from '@ixo/common/ai/decisions';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LLMResult } from '@langchain/core/outputs';
import {
  buildModelCallRecord,
  isModelCallPurpose,
  modelCallOf,
  awaitCallEnd,
  forgetCallEnd,
  type ModelCallRecord,
  type ModelCallPurpose,
  type ModelCallReport,
} from '../llm/model-call';
import type { ChatOpenAIFields, Logger } from '../plugin-api/types';
import type { LlmAdapter } from './runtime-context';

/** Metadata key the metered adapter stamps with the model's role. */
export const MODEL_ROLE_METADATA_KEY = 'oracle_model_role';

/** Metadata key that names a model's purpose for its call reports. */
export const MODEL_CALL_PURPOSE_METADATA_KEY = 'oracle_model_purpose';

/** The summarizer tags its model call with this `lc_source` (LangChain's summarization middleware). */
const SUMMARIZATION_SOURCE = 'summarization';

/** Receives each report once. */
export type ModelCallSink = (call: ModelCallReport) => void;

/** `params` with the purpose put on the model's metadata (callers' metadata kept). */
export function withModelCallPurpose(
  params: ChatOpenAIFields | undefined,
  purpose: ModelCallPurpose,
): ChatOpenAIFields {
  const callerMetadata: unknown = params?.metadata;
  return {
    ...params,
    metadata: {
      ...(callerMetadata && typeof callerMetadata === 'object'
        ? callerMetadata
        : {}),
      [MODEL_CALL_PURPOSE_METADATA_KEY]: purpose,
    },
  };
}

/** A call's purpose, from its run metadata. */
export function purposeOfRun(
  metadata: Record<string, unknown> | undefined,
): ModelCallPurpose {
  const stamped = metadata?.[MODEL_CALL_PURPOSE_METADATA_KEY];
  if (isModelCallPurpose(stamped)) return stamped;
  if (metadata?.lc_source === SUMMARIZATION_SOURCE) return 'summarization';
  const role = metadata?.[MODEL_ROLE_METADATA_KEY];
  if (role === 'main') return 'reply';
  if (role === 'summarizer') return 'summarization';
  return 'other';
}

/**
 * Per-call bookkeeping of a callback handler: when each call started and
 * what for, and which calls were reported (a handler can see one call twice,
 * registered on the model and in the run config).
 */
export class ModelCallReports {
  private readonly open = new Map<
    string,
    { startedAt: number; purpose: ModelCallPurpose }
  >();
  private readonly reported = new Set<string>();

  constructor(
    private readonly sink: ModelCallSink | undefined,
    private readonly logger: Logger,
  ) {}

  start(runId: string, metadata: Record<string, unknown> | undefined): void {
    if (this.open.has(runId) || this.reported.has(runId)) return;
    this.open.set(runId, {
      startedAt: Date.now(),
      purpose: purposeOfRun(metadata),
    });
    // An abort may end the call with no end from LangChain; the model then
    // hands its record over directly (`interruptCall`).
    if (this.sink) awaitCallEnd(runId, (record) => this.deliver(runId, record));
  }

  /** The call `runId` ended: `source` is its reply message or its error. */
  end(runId: string, source: unknown): void {
    forgetCallEnd(runId);
    this.deliver(runId, modelCallOf(source));
  }

  private deliver(runId: string, call: ModelCallRecord | undefined): void {
    const started = this.open.get(runId);
    this.open.delete(runId);
    if (!this.sink || this.reported.has(runId)) return;
    if (!call) return;
    this.reported.add(runId);
    const startedAt = started?.startedAt ?? Date.now() - call.durationMs;
    try {
      this.sink({
        ...call,
        purpose: started?.purpose ?? 'other',
        callId: runId,
        startedAt,
      });
    } catch (error) {
      this.logger.warn(
        `[llm] model-call observer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The reply message of a finished call, when it has one. */
export function replyMessageOf(output: LLMResult): unknown {
  const generation: unknown = output.generations[0]?.[0];
  return generation && typeof generation === 'object' && 'message' in generation
    ? generation.message
    : undefined;
}

/**
 * A callback that only reports calls (no budget, no trace): for the model
 * calls the runtime makes outside a turn's metered adapter (the session
 * title, a group room's summary, a plugin hook's `ctx.llm`).
 */
export class ModelCallReporter extends BaseCallbackHandler {
  name = 'ModelCallReporter';
  private readonly reports: ModelCallReports;

  constructor(sink: ModelCallSink, logger: Logger) {
    super();
    this.reports = new ModelCallReports(sink, logger);
  }

  handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.reports.start(runId, metadata);
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    this.reports.end(runId, replyMessageOf(output));
  }

  handleLLMError(error: unknown, runId: string): void {
    this.reports.end(runId, error);
  }
}

/** Add `handler` to the model's own callbacks (once). */
export function attachCallback(
  model: BaseChatModel,
  handler: BaseCallbackHandler,
): void {
  const existing = model.callbacks;
  if (existing === undefined) {
    model.callbacks = [handler];
    return;
  }
  if (Array.isArray(existing)) {
    if (!existing.includes(handler)) model.callbacks = [...existing, handler];
    return;
  }
  const manager = existing.copy();
  manager.addHandler(handler);
  model.callbacks = manager;
}

/**
 * `adapter` whose models carry `purpose` for their call reports. It goes in
 * through the constructor params (see `budgetedLlm`) and is stamped on the
 * instance too, for adapters that ignore params.
 */
export function purposeLlm(
  adapter: LlmAdapter,
  purpose: ModelCallPurpose,
): LlmAdapter {
  return {
    get(role, params) {
      const model = adapter.get(role, withModelCallPurpose(params, purpose));
      model.metadata = {
        ...model.metadata,
        [MODEL_CALL_PURPOSE_METADATA_KEY]: purpose,
      };
      return model;
    },
  };
}

/** `adapter` whose models report each call to `reporter` under `purpose`. */
export function reportingLlm(
  adapter: LlmAdapter,
  reporter: ModelCallReporter,
  purpose: ModelCallPurpose,
): LlmAdapter {
  const stamped = purposeLlm(adapter, purpose);
  return {
    get(role, params) {
      const model = stamped.get(role, params);
      attachCallback(model, reporter);
      return model;
    },
  };
}

/**
 * The calls one attempt of a turn reported, and the deliveries to
 * `onModelCall` (and the post-turn work, the title) still running, so the
 * attempt's `onTurnUsage` comes after all of them.
 */
export class TurnModelCalls {
  private readonly calls: ModelCallReport[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  add(call: ModelCallReport): void {
    this.calls.push(call);
  }

  /** Calls reported so far. */
  get size(): number {
    return this.calls.length;
  }

  /** The calls reported so far, as they are now. */
  snapshot(): readonly ModelCallReport[] {
    return [...this.calls];
  }

  /** Work that may still report a call or deliver one. */
  track(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work
      .catch(() => undefined)
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /**
   * Every call, once the tracked work settled or `timeoutMs` passed (a hook
   * that hangs must not hold the report, nor the object, forever).
   * `timedOut` says the report may be missing calls.
   */
  async settled(
    timeoutMs: number,
  ): Promise<{ calls: readonly ModelCallReport[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return { calls: [...this.calls], timedOut: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...this.pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
    return { calls: [...this.calls], timedOut: false };
  }
}

/** The report of one Decision evaluation (or its failure). */
export function decisionCallReport(
  purpose: ModelCallPurpose,
  startedAt: number,
  outcome: { evaluation: DecisionEvaluation } | { error: unknown },
): ModelCallReport {
  const evaluation = 'evaluation' in outcome ? outcome.evaluation : undefined;
  const usage = evaluation?.usage;
  const record = buildModelCallRecord(
    {
      role: 'decision',
      requestedModel: evaluation?.model ?? 'unknown',
      paidBy: 'platform',
    },
    {
      ...(evaluation?.provider ? { provider: evaluation.provider } : {}),
      ...(evaluation?.modelVersion
        ? { servedModel: evaluation.modelVersion }
        : {}),
      ...(usage
        ? {
            usage: {
              ...(usage.inputTokens !== undefined
                ? { prompt_tokens: usage.inputTokens }
                : {}),
              ...(usage.outputTokens !== undefined
                ? { completion_tokens: usage.outputTokens }
                : {}),
            },
          }
        : {}),
    },
    evaluation?.latencyMs ?? Date.now() - startedAt,
    'error' in outcome ? outcome.error : undefined,
  );
  return { ...record, purpose, callId: crypto.randomUUID(), startedAt };
}

/**
 * `evaluator` with each evaluation reported to `sink`. `purposeOf` names
 * the purpose from the call's options (default `decision`); a sink may also
 * read the options (the capability router's carry the turn's request id in
 * `metadata.request_id`). An evaluation no provider could take
 * (`DecisionProviderUnavailableError`) made no call and is not reported.
 */
export function reportingDecisions(
  evaluator: DecisionEvaluator,
  sink: (call: ModelCallReport, options?: DecisionEvaluateOptions) => void,
  purposeOf: (options?: DecisionEvaluateOptions) => ModelCallPurpose = () =>
    'decision',
): DecisionEvaluator {
  const observe = async (
    options: DecisionEvaluateOptions | undefined,
    evaluate: () => Promise<DecisionEvaluation>,
  ): Promise<DecisionEvaluation> => {
    const startedAt = Date.now();
    const deliver = (outcome: Parameters<typeof decisionCallReport>[2]) => {
      try {
        sink(
          decisionCallReport(purposeOf(options), startedAt, outcome),
          options,
        );
      } catch {
        // A reporting sink never fails the evaluation.
      }
    };
    try {
      const evaluation = await evaluate();
      deliver({ evaluation });
      return evaluation;
    } catch (error) {
      if (!(error instanceof DecisionProviderUnavailableError))
        deliver({ error });
      throw error;
    }
  };
  return {
    evaluate: (definition, input, options) =>
      observe(options, () => evaluator.evaluate(definition, input, options)),
    evaluateByName: (name, input, options) =>
      observe(options, () => evaluator.evaluateByName(name, input, options)),
  };
}
