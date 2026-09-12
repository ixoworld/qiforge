import { savedResultNotice } from '../result-tool';
import {
  ToolMessage,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import type { HarnessStore } from '../harness-store';
import {
  estimateTokens,
  HarnessLimitError,
  type TurnBudget,
} from '../turn-budget';

export function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /context_length_exceeded|maximum context length|context window exceeded|prompt is too long|input tokens exceed/i.test(
    error.message,
  );
}

/** Runs after capability gating; only the schemas actually sent are charged. */
export function createRequestBudgetMiddleware(options: {
  budget: TurnBudget;
  store?: HarnessStore;
  sessionId: string;
  log?: (message: string) => void;
}): AgentMiddleware {
  const { budget, store, sessionId } = options;
  const schemaCache = new WeakMap<object, unknown>();
  return createMiddleware({
    name: 'RequestBudgetMiddleware',
    wrapModelCall: async (request, handler) => {
      const schemas = request.tools.map((entry) => {
        const cached = schemaCache.get(entry);
        if (cached) return cached;
        const schema = 'schema' in entry ? convertToOpenAITool(entry) : entry;
        schemaCache.set(entry, schema);
        return schema;
      });
      const overhead =
        estimateTokens(request.systemMessage.content) + estimateTokens(schemas);
      const cap =
        Math.floor(budget.limits.contextTokens * 0.95) -
        budget.limits.outputTokens;
      const size = (messages: BaseMessage[]) =>
        overhead +
        estimateTokens(
          messages.map((m) => ({
            role: m.type,
            content: m.content,
            ...(isAIMessage(m) ? { tool_calls: m.tool_calls } : {}),
          })),
        );
      let messages = request.messages;
      const shrink = async (target: number): Promise<void> => {
        if (!store) return;
        messages = [...messages];
        const candidates = messages
          .map((m, index) => ({ m, index, size: estimateTokens(m.content) }))
          .filter(({ m, size }) => isToolMessage(m) && size > 1500)
          .sort((a, b) => b.size - a.size);
        for (const { m, index } of candidates) {
          if (size(messages) <= target) break;
          if (!isToolMessage(m)) continue;
          const id = await store.putResult(
            sessionId,
            typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content),
          );
          messages[index] = new ToolMessage({
            id: m.id,
            name: m.name,
            status: m.status,
            additional_kwargs: m.additional_kwargs,
            content: savedResultNotice(id),
            tool_call_id: m.tool_call_id,
          });
        }
      };
      await shrink(cap);
      const call = async () => {
        const inputTokens = size(messages);
        if (inputTokens > cap)
          throw new HarnessLimitError(
            'context_overflow',
            'The request exceeds the configured context budget even after result offload. Reduce the input or tool surface.',
          );
        budget.check(request.runtime.signal);
        options.log?.(
          `[harness] inputEstimate=${inputTokens} schemaEstimate=${estimateTokens(schemas)} reservedOutput=${budget.limits.outputTokens}`,
        );
        return handler({
          ...request,
          messages,
          modelSettings: {
            ...request.modelSettings,
            maxTokens: budget.limits.outputTokens,
          },
        });
      };
      try {
        return await call();
      } catch (error) {
        if (!isContextOverflow(error)) throw error;
        const previous = size(messages);
        await shrink(Math.floor(previous * 0.75));
        if (size(messages) >= previous)
          throw new HarnessLimitError(
            'context_overflow',
            'The provider rejected the context and no smaller safe request is available.',
          );
        try {
          return await call();
        } catch (retryError) {
          if (isContextOverflow(retryError))
            throw new HarnessLimitError(
              'context_overflow',
              'The provider rejected the reduced context. No further retry was attempted.',
            );
          throw retryError;
        }
      }
    },
  });
}
