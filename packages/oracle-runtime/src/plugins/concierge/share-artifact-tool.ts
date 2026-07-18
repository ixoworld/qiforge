import { MatrixManager } from '@ixo/matrix';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';

const EXTENSION_BY_FORMAT = {
  md: '.md',
  html: '.html',
} as const;

const MIMETYPE_BY_FORMAT = {
  md: 'text/markdown',
  html: 'text/html',
} as const;

const schema = z.object({
  filename: z
    .string()
    .min(1)
    .regex(
      /^[\w][\w .-]*$/,
      'filename must be a plain file name (letters, digits, dots, dashes, spaces — no path separators)',
    )
    .describe(
      'Descriptive file name, e.g. "impact-report-overview.md". The extension may be omitted — it is derived from format.',
    ),
  format: z
    .enum(['md', 'html'])
    .describe(
      'md → a markdown document (long-form text). html → a self-contained visual presentation (tables, styled layout).',
    ),
  content: z
    .string()
    .min(1, 'content is required')
    .describe('The complete file content.'),
});

const DESCRIPTION = `Share a long-form response as a file attached to this Matrix conversation, instead of pasting it into chat.

USE WHEN a complete answer will not comfortably fit as a chat message (roughly anything beyond a few short paragraphs):
- format "md" — long-form TEXT: reports, guides, detailed answers, documentation. (Not for code or raw JSON — keep those in chat code blocks unless the user asks for a file.)
- format "html" — VISUAL presentations: styled tables, comparisons, formatted summaries meant to be viewed, self-contained (inline CSS only).
- For a COLLABORATIVE page/canvas that people will edit together, do NOT use this tool — use the editor's page tools (create_page) when they are available.

After attaching, post a one-or-two-sentence chat summary of what the file contains. The file lands in the current thread.`;

/**
 * `share_artifact` — upload agent-authored MD/HTML content as a standard
 * `m.file` message in the current room/thread. Matrix-client sessions only
 * (the plugin adds this tool when `session.client === 'matrix'`).
 */
export function createShareArtifactTool(): PluginTool {
  return tool(
    async (rawArgs, rtCtx) => {
      const { filename, format, content } = schema.parse(rawArgs);

      const roomId = rtCtx.session.roomId;
      if (!roomId) {
        return 'No Matrix room is attached to this session — deliver the content in chat instead.';
      }

      const extension = EXTENSION_BY_FORMAT[format];
      const otherExtension = format === 'md' ? '.html' : '.md';
      if (filename.toLowerCase().endsWith(otherExtension)) {
        return `The filename extension contradicts format "${format}" — rename the file to end in ${extension} (or change the format) and try again.`;
      }
      const finalName = filename.toLowerCase().endsWith(extension)
        ? filename
        : `${filename}${extension}`;

      await MatrixManager.getInstance().sendFileMessage({
        roomId,
        filename: finalName,
        mimetype: MIMETYPE_BY_FORMAT[format],
        data: Buffer.from(content, 'utf-8'),
        threadId: rtCtx.session.id,
      });

      return `Attached ${finalName} to the conversation. Now post a one-or-two-sentence summary of what it contains.`;
    },
    {
      name: 'share_artifact',
      description: DESCRIPTION,
      schema,
    },
  );
}
