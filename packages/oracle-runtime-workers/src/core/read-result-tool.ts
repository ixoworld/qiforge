/**
 * `read_result` — pages through a tool result the model no longer has in
 * full: one too large for the context (`result-cap.ts` saved it whole and
 * showed a head, a tail and the handle) or one trimmed from an earlier turn
 * (`context-guard.ts` left a stub naming the tool call, and the message
 * itself is still in the thread's state). Chunks of a saved result are byte
 * ranges, of a trimmed one character ranges; `next` is the offset of the
 * following chunk or `null` at the end.
 */
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper';
import type { PluginTool } from '../plugin-api/types';
import type { ReadResultOutcome } from '../do/result-store';
import { contentToText } from './middlewares/result-cap';
import { turnStart } from './middlewares/turn-boundary';

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

/**
 * Reads one turn may make. Paging is for the part of a result a task needs,
 * not for checking that a call worked: a model that read every chunk of a
 * saved result (hundreds of characters at a time) spent a turn and two
 * million tokens on it. Six of the largest chunks cover a result of about
 * 96,000 characters.
 */
export const READ_RESULT_CALLS_PER_TURN = 6;

/** The smallest chunk read: a request for less reads this much, so a turn's reads are never spent on slivers. */
export const READ_RESULT_MIN_CHARS = 2_000;

/** The result of a read past {@link READ_RESULT_CALLS_PER_TURN}: not run. */
export function readBudgetSpent(reads: number): string {
  return `Not read: this turn already read ${reads} chunks, the most one turn may read. Continue with what you have (the head and tail of the result, and each call's own reply, say whether it worked), or tell the person what is still unread.`;
}

/**
 * Reads this turn asked for before the call `toolCallId`, counted on the
 * model's own tool calls so a batch of parallel reads counts each one (their
 * results are not in the thread yet when they run). Without the call's id
 * in the thread, the reads that already returned.
 */
function readsBefore(
  messages: readonly BaseMessage[],
  toolCallId: string | undefined,
): number {
  const start = turnStart(messages);
  if (toolCallId) {
    let asked = 0;
    for (let i = start; i < messages.length; i += 1) {
      const message = messages[i];
      if (!AIMessage.isInstance(message)) continue;
      for (const call of message.tool_calls ?? []) {
        if (call.name !== READ_RESULT_TOOL_NAME) continue;
        if (call.id === toolCallId) return asked;
        asked += 1;
      }
    }
  }
  let returned = 0;
  for (let i = start; i < messages.length; i += 1) {
    const message = messages[i];
    if (
      ToolMessage.isInstance(message) &&
      message.name === READ_RESULT_TOOL_NAME
    )
      returned += 1;
  }
  return returned;
}

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
  const minChars = Math.min(READ_RESULT_MIN_CHARS, maxChars);
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
      .default(maxChars)
      .describe(
        `Length to read (default and max ${maxChars}; at least ${minChars} is read).`,
      ),
  });
  return tool(
    async (rawArgs, ctx) => {
      const parsed = schema.parse(rawArgs);
      const reads = readsBefore(ctx.history.messages, ctx.toolCallId);
      if (reads >= READ_RESULT_CALLS_PER_TURN)
        return { error: readBudgetSpent(reads) };
      const { id, offset } = parsed;
      const length = Math.max(parsed.length, minChars);
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
      description: `Read part of a tool result you no longer have in full: the id from a "[Result truncated …]" footer or a stub that says the result was removed. Read only the part your task needs, in large chunks (pass a returned \`next\` as the offset to continue). Never read a result back to check that a call worked: its visible head and tail and the call's own reply say that. At most ${READ_RESULT_CALLS_PER_TURN} reads per turn.`,
      schema,
    },
  );
}
