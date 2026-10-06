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
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LLMResult } from '@langchain/core/outputs';
import type { ChatOpenAIFields, ModelRole } from '../plugin-api/types';
import {
  estimateContentTokens,
  messageContentTokens,
  messageToolCallTokens,
} from './context-budget';
import type { LlmAdapter } from './runtime-context';
import type { TurnBudget } from './turn-budget';

export interface BudgetedLlmOptions {
  budget: TurnBudget;
  /** Tokens reserved for the reply of each call (the context budget's output reserve). */
  outputReserveTokens: number;
  /** The turn's abort signal: a call after the abort is refused before it starts. */
  signal?: AbortSignal;
}

export interface BudgetedLlm extends LlmAdapter {
  /** Put this in the run config's `callbacks` as well. */
  readonly callback: BaseCallbackHandler;
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

  constructor(private readonly options: BudgetedLlmOptions) {
    super();
  }

  handleChatModelStart(
    _llm: unknown,
    messages: LLMResultMessages,
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
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
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const reservation = this.reservations.get(runId);
    if (reservation === undefined) return;
    this.reservations.delete(runId);
    const reported = reportedTotalTokens(output);
    if (reported !== undefined)
      this.options.budget.settleModel(reservation.tokens, reported);
  }

  handleLLMError(_error: unknown, runId: string): void {
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
    get(role: ModelRole, params?: ChatOpenAIFields): BaseChatModel {
      const model = adapter.get(role, params);
      attach(model, callback);
      return model;
    },
  };
}
