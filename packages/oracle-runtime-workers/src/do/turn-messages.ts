/**
 * Ordering of the messages a turn feeds the graph: hidden attachment context
 * and the person's message.
 */

import {
  AIMessage,
  type BaseMessage,
  type HumanMessage,
} from '@langchain/core/messages';

import type { ExtractedAttachment } from '../attachments';

export interface TurnMessageParts {
  human: HumanMessage;
  /** Extraction-lane text: follows the HumanMessage (as on Node). */
  extracted: readonly ExtractedAttachment[];
  /**
   * One line per natively-sent file naming its reference. These go BEFORE the
   * HumanMessage so the turn never ends on an assistant message (providers
   * reject or mis-handle an assistant-last conversation).
   */
  nativeNotes: readonly ExtractedAttachment[];
  matrixRoom: boolean;
  now?: () => Date;
}

function hiddenNote(
  item: ExtractedAttachment,
  matrixRoom: boolean,
  now: () => Date,
): AIMessage {
  return new AIMessage({
    content: item.text,
    additional_kwargs: {
      msgFromMatrixRoom: matrixRoom,
      timestamp: now().toISOString(),
      attachment: item.meta,
    },
  });
}

/**
 * Native notes, then the HumanMessage, then the extraction-lane text. The
 * hidden messages carry an `attachment` kwarg, which the transcript hides.
 */
export function assembleTurnMessages(parts: TurnMessageParts): BaseMessage[] {
  const now = parts.now ?? (() => new Date());
  return [
    ...parts.nativeNotes.map((n) => hiddenNote(n, parts.matrixRoom, now)),
    parts.human,
    ...parts.extracted.map((n) => hiddenNote(n, parts.matrixRoom, now)),
  ];
}
