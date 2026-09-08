/**
 * `view_attachment` — fetch an attachment of this session again after its
 * inline payload was offloaded (see `src/attachments/retention.ts`).
 *
 * Two result shapes, decided by the host surface with the same routing as
 * the turn pipeline:
 *  - text (helper-model description / transcription / document text, or a
 *    decoded plain-text file): returned as the tool output;
 *  - native (the current model reads the modality): the bytes go back to the
 *    model as a content block. A tool message cannot carry one on the
 *    OpenAI-compatible wire, so the tool returns a LangGraph `Command` that
 *    appends its tool message AND a human message holding the block — the
 *    same proven shape a fresh attachment turn uses. That message is tagged
 *    `lc_source: attachment_view`: transcripts hide it, retention treats it
 *    as part of the current user turn and offloads it again later.
 */
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import {
  ATTACHMENT_VIEW_SOURCE,
  buildUserMessageContent,
  VIEW_ATTACHMENT_TOOL_NAME,
} from '../../attachments';
import { tool } from '../../plugin-api/tool-helper';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';

export const viewAttachmentSchema = z.object({
  ref: z
    .string()
    .min(1)
    .describe(
      'The attachment reference exactly as listed in the "[attachment offloaded]" note of the message it belongs to (a Matrix event id such as "$abc…" or an mxc:// URI).',
    ),
});

export const VIEW_ATTACHMENT_DESCRIPTION =
  'Look at an attachment from earlier in this conversation again. Older messages keep only a note listing their ' +
  'attachments ("[attachment offloaded] … ref: …") instead of the file itself; pass that ref to get the file back. ' +
  'Images and documents the current model can read are re-attached as-is; anything else comes back as text ' +
  '(a description, transcription or the document text). Use it whenever the user refers to a file that is no ' +
  'longer inline — do not guess its contents from memory.';

export function createViewAttachmentTool(): PluginTool {
  return tool(
    async (rawArgs: unknown, ctx: RuntimeContext) => {
      const { ref } = viewAttachmentSchema.parse(rawArgs);
      if (!ctx.attachments) {
        throw new Error(
          'attachment access is not available on this host — the file cannot be fetched again',
        );
      }
      const { meta, view } = await ctx.attachments.view(ref);
      if (view.kind === 'text') return view.text;
      if (!ctx.toolCallId) {
        throw new Error(
          `"${meta.filename}" was fetched but cannot be re-attached outside a tool call`,
        );
      }
      const label = `Re-attached "${meta.filename}" (${meta.mimetype}) from earlier in this conversation.`;
      const timestamp = new Date().toISOString();
      const msgFromMatrixRoom = ctx.session.client === 'matrix';
      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: `${label} It follows in the next message.`,
              tool_call_id: ctx.toolCallId,
            }),
            new HumanMessage({
              content: buildUserMessageContent(label, [view.native]),
              additional_kwargs: {
                lc_source: ATTACHMENT_VIEW_SOURCE,
                timestamp,
                msgFromMatrixRoom,
                attachment: meta,
                attachments: [meta],
              },
            }),
          ],
        },
      });
    },
    {
      name: VIEW_ATTACHMENT_TOOL_NAME,
      description: VIEW_ATTACHMENT_DESCRIPTION,
      schema: viewAttachmentSchema,
      visibility: 'always',
    },
  );
}
