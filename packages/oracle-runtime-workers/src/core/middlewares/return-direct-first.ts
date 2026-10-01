/**
 * LangChain's agent loop exits when the LAST tool result of a step comes
 * from a return-direct tool. A model that calls one alongside other tools
 * would then never see those other results. This middleware moves the
 * return-direct call to the front of such a step, so the loop continues and
 * the model answers with every result in view.
 */
import { AIMessage, isAIMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';

export function createReturnDirectFirstMiddleware(
  toolNames: ReadonlySet<string>,
): AgentMiddleware {
  return createMiddleware({
    name: 'ReturnDirectFirstMiddleware',
    afterModel: (state) => {
      const last = state.messages.at(-1);
      if (!last || !isAIMessage(last)) return undefined;
      const calls = last.tool_calls ?? [];
      const lastCall = calls.at(-1);
      // Only a return-direct call in last place ends the loop early, and
      // only when some other tool's result would go unanswered.
      if (!lastCall || !toolNames.has(lastCall.name)) return undefined;
      if (calls.every((c) => toolNames.has(c.name))) return undefined;
      const direct = calls.filter((c) => toolNames.has(c.name));
      return {
        messages: [
          new AIMessage({
            id: last.id,
            name: last.name,
            content: last.content,
            additional_kwargs: last.additional_kwargs,
            response_metadata: last.response_metadata,
            ...(last.usage_metadata
              ? { usage_metadata: last.usage_metadata }
              : {}),
            invalid_tool_calls: last.invalid_tool_calls ?? [],
            tool_calls: [
              ...direct,
              ...calls.filter((c) => !toolNames.has(c.name)),
            ],
          }),
        ],
      };
    },
  });
}
