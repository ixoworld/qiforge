/**
 * `read_result` — pages through a tool result the model no longer has in
 * full: one too large for the context (`result-cap.ts` saved it whole and
 * showed a head, a tail and the handle) or one trimmed from an earlier turn
 * (`context-guard.ts` left a stub naming the tool call, and the message
 * itself is still in the thread's state). Chunks of a saved result are byte
 * ranges, of a trimmed one character ranges; `next` is the offset of the
 * following chunk or `null` at the end.
 */
import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper';
import type { PluginTool } from '../plugin-api/types';
import type { ReadResultOutcome } from '../do/result-store';
import { contentToText } from './middlewares/result-cap';

export interface ReadResultToolOptions {
  read: (
    id: string,
    offset: number,
    length: number,
  ) => Promise<ReadResultOutcome>;
  /** Longest chunk this deployment hands back (kept under the result cap). */
  maxChars: number;
}

export const READ_RESULT_TOOL_NAME = 'read_result';

/** The longest chunk `read_result` hands back under a result cap: well under the cap, so a page is never capped itself. */
export function readResultMaxChars(resultCapChars: number): number {
  return Math.min(16_000, Math.max(512, Math.floor(resultCapChars / 2)));
}

/**
 * The text of the thread's tool result for call `id`, if it is still there.
 * Newest first: a provider can use a call id again on a later turn.
 */
function threadResult(
  messages: readonly BaseMessage[],
  id: string,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (ToolMessage.isInstance(message) && message.tool_call_id === id)
      return contentToText(message.content);
  }
  return undefined;
}

export function buildReadResultTool(
  options: ReadResultToolOptions,
): PluginTool {
  const maxChars = Math.max(512, Math.min(options.maxChars, 64 * 1024));
  const defaultChars = Math.min(4_000, maxChars);
  const schema = z.object({
    id: z
      .string()
      .min(1)
      .max(256)
      .describe('The id named in a "[Result truncated …]" footer or stub.'),
    offset: z.number().int().min(0).default(0).describe('Offset to read from.'),
    length: z
      .number()
      .int()
      .min(256)
      .max(maxChars)
      .default(defaultChars)
      .describe(`Length to read (max ${maxChars}).`),
  });
  return tool(
    async (rawArgs, ctx) => {
      const { id, offset, length } = schema.parse(rawArgs);
      const text = threadResult(ctx.history.messages, id);
      if (text !== undefined) {
        const end = offset + length;
        return {
          id,
          offset,
          length: Math.max(0, Math.min(end, text.length) - offset),
          size: text.length,
          next: end < text.length ? end : null,
          text: text.slice(offset, end),
        };
      }
      const outcome = await options.read(id, offset, length);
      if (outcome.status !== 'ok')
        return {
          error:
            outcome.status === 'expired'
              ? 'This saved result has expired; run the tool again to get it back.'
              : 'No saved result with this id in this session.',
        };
      return {
        id: outcome.id,
        offset: outcome.offset,
        length: outcome.length,
        size: outcome.size,
        next: outcome.next,
        text: outcome.text,
      };
    },
    {
      name: READ_RESULT_TOOL_NAME,
      effect: 'read',
      visibility: 'always',
      description:
        'Read a tool result you no longer have in full, in chunks. Use the id from a "[Result truncated …]" footer or a stub that says the result was removed; start at offset 0 and pass the returned `next` as the offset of the following call until `next` is null.',
      schema,
    },
  );
}
