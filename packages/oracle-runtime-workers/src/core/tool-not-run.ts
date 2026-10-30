import { ToolMessage } from '@langchain/core/messages';

/** `response_metadata` key of a result whose tool did not run (never sent to a provider). */
const NOT_RUN = 'toolNotRun';

/**
 * A tool result saying the tool did not run because another step must come
 * first (for example reading a message type's rules before preparing it).
 * It is an error result, so it never counts as a write that happened, and
 * like a capability-gate refusal the repetition guard lets the identical
 * call through once the step is done (`isToolNotRun`).
 */
export function toolNotRunMessage(input: {
  toolCallId: string;
  name: string;
  content: string;
}): ToolMessage {
  return new ToolMessage({
    tool_call_id: input.toolCallId,
    name: input.name,
    content: input.content,
    status: 'error',
    response_metadata: { [NOT_RUN]: true },
  });
}

/** A result `toolNotRunMessage` made: the tool did not run. */
export function isToolNotRun(message: ToolMessage): boolean {
  return message.response_metadata?.[NOT_RUN] === true;
}
