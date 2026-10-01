import type { SSEReasoningEventData } from '../../../utils/sse-parser.js';
import type { IMessage } from './types.js';

/**
 * The id under which a turn's streamed reasoning is filed. It is its own
 * message, next to the answer (`requestId`), never the same one: a model
 * that thinks before it speaks (the ChatGPT lane streams its reasoning
 * summary first) would otherwise flag the answer `isReasoning` and the UI,
 * which hides reasoning-only messages, would show nothing until the
 * finished turn came back from the transcript.
 */
export const reasoningMessageId = (requestId: string): string =>
  `${requestId}-reasoning`;

/** One reasoning frame as the message the store accumulates it into. */
export function reasoningMessageOf(
  reasoningData: SSEReasoningEventData,
): IMessage {
  return {
    id: reasoningMessageId(reasoningData.requestId),
    type: 'ai',
    content: reasoningData.reasoning,
    reasoning:
      reasoningData.reasoningDetails
        ?.map((detail) => detail.text)
        .filter((text) => text && text.trim().length > 0)
        .join('\n') || '',
    isComplete: reasoningData.isComplete,
    isReasoning: true,
  };
}
