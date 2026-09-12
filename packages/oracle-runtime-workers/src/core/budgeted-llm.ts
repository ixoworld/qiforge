import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LlmAdapter } from './runtime-context';
import { estimateTokens, type TurnBudget } from './turn-budget';

/** Provider boundary: includes helper models invoked from tools and compaction. */
export function budgetedLlm(
  adapter: LlmAdapter,
  budget: TurnBudget,
  signal: AbortSignal,
  recordUsage?: () => Promise<void>,
): LlmAdapter & { callback: BaseCallbackHandler } {
  class BudgetHandler extends BaseCallbackHandler {
    name = 'TurnBudget';
    raiseError = true;
    awaitHandlers = true;
    private readonly seen = new Set<string>();
    async handleChatModelStart(
      ...args: Parameters<
        NonNullable<BaseCallbackHandler['handleChatModelStart']>
      >
    ): Promise<void> {
      const [, messages, runId, , extra] = args;
      if (this.seen.has(runId)) return;
      const params = extra?.invocation_params;
      const tools =
        params && typeof params === 'object' && 'tools' in params
          ? params.tools
          : [];
      budget.reserveModel(
        estimateTokens(
          messages.map((batch) =>
            batch.map((m) => ({
              content: m.content,
              ...('tool_calls' in m ? { tool_calls: m.tool_calls } : {}),
            })),
          ),
        ) + estimateTokens(tools),
        signal,
      );
      this.seen.add(runId);
      await recordUsage?.();
    }
  }
  const callback = new BudgetHandler();
  return {
    callback,
    get(role, params) {
      const model = adapter.get(role, {
        ...params,
        maxTokens: budget.limits.outputTokens,
        maxRetries: 0,
      });
      const handler = callback;
      if (Array.isArray(model.callbacks))
        model.callbacks = [...model.callbacks, handler];
      else if (model.callbacks) {
        model.callbacks = model.callbacks.copy();
        model.callbacks.addHandler(handler);
      } else model.callbacks = [handler];
      return model;
    },
  };
}
