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
import { estimateContentTokens } from './context-budget';
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

/** What one model call sends, reduced to what costs tokens. */
function estimateRequestTokens(
  messages: LLMResultMessages,
  invocationParams: unknown,
): number {
  let tokens = 0;
  for (const batch of messages)
    for (const message of batch) {
      tokens += estimateContentTokens(message.content) + 4;
      if ('tool_calls' in message && Array.isArray(message.tool_calls))
        tokens += estimateContentTokens(message.tool_calls);
    }
  if (
    invocationParams &&
    typeof invocationParams === 'object' &&
    'tools' in invocationParams
  )
    tokens += estimateContentTokens(invocationParams.tools);
  return tokens;
}

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
  private readonly reservations = new Map<string, number>();

  constructor(private readonly options: BudgetedLlmOptions) {
    super();
  }

  handleChatModelStart(
    _llm: unknown,
    messages: LLMResultMessages,
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    // The handler can reach the same call twice (model-level and run-level
    // registration); the first registration charges it.
    if (this.reservations.has(runId)) return;
    const reservation = this.options.budget.reserveModel(
      estimateRequestTokens(messages, extraParams?.invocation_params),
      this.options.outputReserveTokens,
      this.options.signal,
    );
    this.reservations.set(runId, reservation);
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const reservation = this.reservations.get(runId);
    if (reservation === undefined) return;
    this.reservations.delete(runId);
    const reported = reportedTotalTokens(output);
    if (reported !== undefined)
      this.options.budget.settleModel(reservation, reported);
  }

  handleLLMError(_error: unknown, runId: string): void {
    // A failed call keeps its reservation: the provider may have consumed
    // the input before failing, and a retry reserves again.
    this.reservations.delete(runId);
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
