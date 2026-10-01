/**
 * `read_result` — pages through a tool result that was too large for the
 * context (`result-cap.ts` saved it whole and showed the model a head, a
 * tail and the handle). Chunks are byte ranges; `next` is the offset of the
 * following chunk or `null` at the end.
 */
import { z } from 'zod';
import { tool } from '../plugin-api/tool-helper';
import type { PluginTool } from '../plugin-api/types';
import type { ReadResultOutcome } from '../do/result-store';

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

export function buildReadResultTool(
  options: ReadResultToolOptions,
): PluginTool {
  const maxChars = Math.max(512, Math.min(options.maxChars, 64 * 1024));
  const defaultChars = Math.min(4_000, maxChars);
  const schema = z.object({
    id: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('The saved result id from a "[Result truncated …]" footer.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Byte offset to read from.'),
    length: z
      .number()
      .int()
      .min(256)
      .max(maxChars)
      .default(defaultChars)
      .describe(`Bytes to read (max ${maxChars}).`),
  });
  return tool(
    async (rawArgs) => {
      const { id, offset, length } = schema.parse(rawArgs);
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
        'Read a saved large tool result in chunks. Use the id from a "[Result truncated …]" footer; start at offset 0 and pass the returned `next` as the offset of the following call until `next` is null.',
      schema,
    },
  );
}
