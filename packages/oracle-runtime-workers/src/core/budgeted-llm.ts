/**
 * The turn's LLM adapter, metered: every model it hands out carries a
 * callback that reserves the call against the `TurnBudget` before the
 * provider is contacted and settles the reservation to the provider's
 * reported usage when the call ends. Helper models (summarizer, attachment
 * extraction, a plugin's own `ctx.llm.get`) are covered the same way as the
 * main model, since they all come from this adapter.
 *
 * The same handler is also put in the graph's run config (`callbacks`) so a
 * model the host constructed elsewhere and passed in directly is still
 * charged; a call reported through both paths is counted once.
 *
 * The handler also traces each call for operators: `[llm] start` and
 * `[llm] end … in N ms` at debug level, and `[llm] … still running after
 * N s` every minute while a call is open, so a stalled call can be told
 * from a long one. Only the role, model id and tags are logged — never
 * message content or credentials.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LLMResult } from '@langchain/core/outputs';
import type { ChatOpenAIFields, Logger, ModelRole } from '../plugin-api/types';
import {
  estimateContentTokens,
  messageContentTokens,
  messageToolCallTokens,
} from './context-budget';
import type { LlmAdapter } from './runtime-context';
import type { TurnBudget } from './turn-budget';
import { NOOP_LOGGER } from './utils';

/** How often an open model call is reported as still running. */
export const LLM_HEARTBEAT_MS = 60_000;

/** Metadata key `budgetedLlm` stamps on the models it hands out. */
const ROLE_METADATA_KEY = 'oracle_model_role';

export interface BudgetedLlmOptions {
  budget: TurnBudget;
  /** Tokens reserved for the reply of each call (the context budget's output reserve). */
  outputReserveTokens: number;
  /** The turn's abort signal: a call after the abort is refused before it starts. */
  signal?: AbortSignal;
  /** Receives the per-call trace (`[llm] start` / `end` / still running). */
  logger?: Logger;
}

export interface BudgetedLlm extends LlmAdapter {
  /** Put this in the run config's `callbacks` as well. */
  readonly callback: BaseCallbackHandler;
  /**
   * End of the turn: clears every heartbeat still open and the abort
   * listener. LangChain reports no end for a stream its consumer stopped
   * reading early, and a live interval keeps the object resident.
   */
  dispose(): void;
}

/**
 * Key of a request's tool list for the per-turn schema estimate: the tool
 * names in order. Within one turn a name always carries the same schema (the
 * tools are bound when the turn's graph is built), so the names identify
 * the list; anything without a recognisable name is not cached.
 */
function toolListKey(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined;
  const names: string[] = [];
  for (const entry of tools) {
    const fn: unknown =
      entry && typeof entry === 'object' && 'function' in entry
        ? entry.function
        : entry;
    const name: unknown =
      fn && typeof fn === 'object' && 'name' in fn ? fn.name : undefined;
    if (typeof name !== 'string') return undefined;
    names.push(name);
  }
  return names.join('\n');
}

/**
 * What one model call sends, reduced to what costs tokens. Message estimates
 * are memoised per message (`messageContentTokens`), the tool schemas per
 * tool list in `toolTokens`, so a long history is not re-serialised on every
 * step of the turn.
 */
function estimateRequestTokens(
  messages: LLMResultMessages,
  invocationParams: unknown,
  toolTokens: Map<string, number>,
): number {
  let tokens = 0;
  for (const batch of messages)
    for (const message of batch) {
      tokens += messageContentTokens(message) + 4;
      if ('tool_calls' in message && Array.isArray(message.tool_calls))
        tokens += messageToolCallTokens(message, message.tool_calls);
    }
  if (
    invocationParams &&
    typeof invocationParams === 'object' &&
    'tools' in invocationParams
  ) {
    const { tools } = invocationParams;
    const key = toolListKey(tools);
    let schema = key === undefined ? undefined : toolTokens.get(key);
    if (schema === undefined) {
      schema = estimateContentTokens(tools);
      if (key !== undefined) toolTokens.set(key, schema);
    }
    tokens += schema;
  }
  return tokens;
}

/** The summarizer tags its model call with this `lc_source` (LangChain's summarization middleware). */
const SUMMARIZATION_SOURCE = 'summarization';

type LLMResultMessages = Parameters<
  NonNullable<BaseCallbackHandler['handleChatModelStart']>
>[1];

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined;
  const n = Reflect.get(value, key);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Provider usage of one call: `llmOutput.tokenUsage` (OpenAI-compatible) or the message's `usage_metadata`. */
function reportedTotalTokens(output: LLMResult): number | undefined {
  const usage: unknown = output.llmOutput?.tokenUsage;
  const total = numberField(usage, 'totalTokens');
  if (total !== undefined) return total;
  const prompt = numberField(usage, 'promptTokens');
  const completion = numberField(usage, 'completionTokens');
  if (prompt !== undefined && completion !== undefined)
    return prompt + completion;
  const generation: unknown = output.generations[0]?.[0];
  const message =
    generation && typeof generation === 'object' && 'message' in generation
      ? generation.message
      : undefined;
  const meta =
    message && typeof message === 'object' && 'usage_metadata' in message
      ? message.usage_metadata
      : undefined;
  return numberField(meta, 'total_tokens');
}

class TurnBudgetHandler extends BaseCallbackHandler {
  name = 'TurnBudgetHandler';
  /** A refused reservation must fail the model call, not be logged and ignored. */
  raiseError = true;
  awaitHandlers = true;
  private readonly reservations = new Map<
    string,
    { tokens: number; summary: boolean }
  >();
  /** Tool-schema estimate per tool list, for this turn (see `toolListKey`). */
  private readonly toolTokens = new Map<string, number>();
  /** Open calls, for the trace: what they are, when they started, their heartbeat. */
  private readonly open = new Map<
    string,
    {
      what: string;
      started: number;
      heartbeat: ReturnType<typeof setInterval>;
    }
  >();
  private readonly logger: Logger;
  private readonly onAbort = (): void => this.closeAll();

  constructor(private readonly options: BudgetedLlmOptions) {
    super();
    this.logger = options.logger ?? NOOP_LOGGER;
    // A call the abort cut short may never report its end; its heartbeat
    // must not outlive the turn (a live timer keeps the object resident).
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  dispose(): void {
    this.closeAll();
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }

  private traceStart(
    runId: string,
    extraParams: Record<string, unknown> | undefined,
    tags: string[] | undefined,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const role = metadata?.[ROLE_METADATA_KEY];
    const invocation = extraParams?.invocation_params;
    const invocationModel =
      invocation && typeof invocation === 'object' && 'model' in invocation
        ? invocation.model
        : undefined;
    const model =
      typeof invocationModel === 'string'
        ? invocationModel
        : typeof metadata?.ls_model_name === 'string'
          ? metadata.ls_model_name
          : 'unknown';
    const what = `role=${typeof role === 'string' ? role : 'unknown'} model=${model}`;
    this.logger.debug?.(
      `[llm] start ${what} tags=${(tags ?? []).join(',') || '-'}`,
    );
    const started = Date.now();
    const heartbeat = setInterval(() => {
      this.logger.log(
        `[llm] ${what} still running after ${Math.round((Date.now() - started) / 1000)} s`,
      );
    }, LLM_HEARTBEAT_MS);
    this.open.set(runId, { what, started, heartbeat });
  }

  private traceEnd(runId: string, outcome: 'end' | 'error'): void {
    const call = this.open.get(runId);
    if (!call) return;
    clearInterval(call.heartbeat);
    this.open.delete(runId);
    this.logger.debug?.(
      `[llm] ${outcome} ${call.what} in ${Date.now() - call.started} ms`,
    );
  }

  private closeAll(): void {
    for (const call of this.open.values()) clearInterval(call.heartbeat);
    this.open.clear();
  }

  handleChatModelStart(
    _llm: unknown,
    messages: LLMResultMessages,
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    // The handler can reach the same call twice (model-level and run-level
    // registration); the first registration charges it.
    if (this.reservations.has(runId)) return;
    const tokens = this.options.budget.reserveModel(
      estimateRequestTokens(
        messages,
        extraParams?.invocation_params,
        this.toolTokens,
      ),
      this.options.outputReserveTokens,
      this.options.signal,
    );
    this.reservations.set(runId, {
      tokens,
      summary: metadata?.lc_source === SUMMARIZATION_SOURCE,
    });
    // Traced only once admitted: a refused call never starts a heartbeat.
    this.traceStart(runId, extraParams, tags, metadata);
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    this.traceEnd(runId, 'end');
    const reservation = this.reservations.get(runId);
    if (reservation === undefined) return;
    this.reservations.delete(runId);
    const reported = reportedTotalTokens(output);
    if (reported !== undefined)
      this.options.budget.settleModel(reservation.tokens, reported);
  }

  handleLLMError(_error: unknown, runId: string): void {
    this.traceEnd(runId, 'error');
    const reservation = this.reservations.get(runId);
    this.reservations.delete(runId);
    // A failed call keeps its reservation: the provider may have consumed
    // the input before failing, and a retry reserves again. A failed summary
    // is the exception: the summarizer swallows the failure, the turn goes on
    // with its history unchanged and does not try again (summarization.ts),
    // so its reservation — the whole history it was handed — is given back
    // instead of starving the rest of the turn.
    if (reservation?.summary)
      this.options.budget.releaseModel(reservation.tokens);
  }
}

function attach(model: BaseChatModel, handler: BaseCallbackHandler): void {
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

export function budgetedLlm(
  adapter: LlmAdapter,
  options: BudgetedLlmOptions,
): BudgetedLlm {
  const callback = new TurnBudgetHandler(options);
  return {
    callback,
    dispose: () => callback.dispose(),
    get(role: ModelRole, params?: ChatOpenAIFields): BaseChatModel {
      // The role rides on the model's run metadata, for the call trace. It
      // goes in through the constructor params: `ChatOpenAI.bindTools`
      // rebuilds the model from them, dropping anything set afterwards. The
      // instance is stamped too, for adapters that ignore params.
      const callerMetadata: unknown = params?.metadata;
      const metadata = {
        ...(callerMetadata && typeof callerMetadata === 'object'
          ? callerMetadata
          : {}),
        [ROLE_METADATA_KEY]: String(role),
      };
      const model = adapter.get(role, { ...params, metadata });
      model.metadata = { ...model.metadata, ...metadata };
      attach(model, callback);
      return model;
    },
  };
}
