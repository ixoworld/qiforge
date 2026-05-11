/**
 * LangGraph tool wrappers for page creation and reading.
 */

import { tool } from '@langchain/core/tools';
import type { MatrixClient } from 'matrix-js-sdk';
import * as z from 'zod';

import { emojify } from 'node-emoji';
import type { BlocknoteToolsConfig } from './blocknote-tools.js';
import { createPage, readPage, updatePage } from './page-functions.js';

export interface CreatePageToolsParams {
  matrixClient: MatrixClient;
  /** Blocknote tools config built at plugin boot. */
  toolsConfig: BlocknoteToolsConfig;
  userMatrixId?: string;
  defaultSpaceId?: string;
  /**
   * When set, update_page and read_page use this room ID directly — the LLM
   * never sees or provides it.
   */
  defaultRoomId?: string;
}

export function createPageTools({
  matrixClient,
  toolsConfig,
  userMatrixId,
  defaultSpaceId,
  defaultRoomId,
}: CreatePageToolsParams) {
  const { matrix: matrixConfig, provider: providerConfig } = toolsConfig;

  const createPageTool = tool(
    async (input) => {
      try {
        const result = await createPage({
          matrixClient,
          matrixConfig,
          providerConfig,
          title: emojify(input.title),
          topic: input.topic ? emojify(input.topic) : undefined,
          content: input.content ? emojify(input.content) : undefined,
          parentSpaceId: defaultSpaceId,
          inviteUserIds: userMatrixId ? [userMatrixId] : [],
        });

        return JSON.stringify({
          success: true,
          roomId: result.roomId,
          alias: result.alias,
          title: result.title,
          ownerDid: result.ownerDid,
          createdAt: result.createdAt,
          blockCount: result.blockCount,
          message: `Created page "${result.title}" with ${result.blockCount} block(s)`,
          ...(defaultSpaceId && { spaceId: defaultSpaceId }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ success: false, error: message });
      }
    },
    {
      name: 'create_page',
      description:
        "Create a new page in the user's space. Accepts markdown content which is automatically converted to editor blocks. Returns the page ID, title, and owner.",
      schema: z.object({
        title: z.string().describe('The title for the new page'),
        topic: z
          .string()
          .optional()
          .describe('Optional description/topic for the page'),
        content: z
          .string()
          .optional()
          .describe(
            'Optional markdown content to populate the page (headings, lists, bold, etc.)',
          ),
      }),
    },
  );

  // When defaultRoomId is set (editor agent context), the room ID is baked in —
  // the LLM doesn't provide it. When not set (standalone), the LLM must provide it.
  const readPageTool = defaultRoomId
    ? tool(
        async () => {
          try {
            const result = await readPage({
              matrixClient,
              matrixConfig,
              providerConfig,
              roomId: defaultRoomId,
            });

            return JSON.stringify({
              success: true,
              roomId: result.roomId,
              metadata: result.metadata,
              blockCount: result.blockCount,
              blocks: result.blocks,
              message: `Page has ${result.blockCount} block(s)`,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return JSON.stringify({
              success: false,
              roomId: defaultRoomId,
              error: message,
            });
          }
        },
        {
          name: 'read_page',
          description:
            'Read the current page. Returns the page metadata (title, owner, creation date) and all blocks.',
          schema: z.object({}),
        },
      )
    : tool(
        async (input) => {
          try {
            const result = await readPage({
              matrixClient,
              matrixConfig,
              providerConfig,
              roomId: input.room_id,
            });

            return JSON.stringify({
              success: true,
              roomId: result.roomId,
              metadata: result.metadata,
              blockCount: result.blockCount,
              blocks: result.blocks,
              message: `Page has ${result.blockCount} block(s)`,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return JSON.stringify({
              success: false,
              roomId: input.room_id,
              error: message,
            });
          }
        },
        {
          name: 'read_page',
          description:
            'Read an existing page by its Matrix room ID (format: !id:homeserver). Returns the page metadata and all blocks.',
          schema: z.object({
            room_id: z
              .string()
              .regex(
                /^!.+:.+$/,
                'Room ID must start with "!" (e.g., "!abc123:matrix.org")',
              )
              .describe(
                'The Matrix room ID of the page (e.g., "!oeGkcJIKNpeSiaGHVE:devmx.ixo.earth"). Must start with "!".',
              ),
          }),
        },
      );

  // Same pattern: baked-in room ID in editor context, required param in standalone
  const updatePageTool = defaultRoomId
    ? tool(
        async (input) => {
          try {
            const result = await updatePage({
              matrixClient,
              matrixConfig,
              providerConfig,
              roomId: defaultRoomId,
              title: input.title ? emojify(input.title) : undefined,
              topic: input.topic ? emojify(input.topic) : undefined,
              content: input.content ? emojify(input.content) : undefined,
              appendContent: input.appendContent
                ? emojify(input.appendContent)
                : undefined,
            });

            return JSON.stringify({
              success: true,
              roomId: result.roomId,
              title: result.title,
              ownerDid: result.ownerDid,
              updatedAt: result.updatedAt,
              updatedFields: result.updatedFields,
              blockCount: result.blockCount,
              diff: result.diff,
              message:
                result.updatedFields.length > 0
                  ? `Updated ${result.updatedFields.join(', ')} — page now has ${result.blockCount} block(s)`
                  : 'No fields were updated (nothing to change)',
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return JSON.stringify({
              success: false,
              roomId: defaultRoomId,
              error: message,
            });
          }
        },
        {
          name: 'update_page',
          description:
            'Update the current page. Can update title, topic, replace all content with markdown, or append markdown content. All fields are optional — only provided fields are updated.',
          schema: z.object({
            title: z.string().optional().describe('New title for the page'),
            topic: z
              .string()
              .optional()
              .describe('New topic/description for the page'),
            content: z
              .string()
              .optional()
              .describe(
                'Markdown content to REPLACE all existing blocks. Use appendContent to add without replacing.',
              ),
            appendContent: z
              .string()
              .optional()
              .describe('Markdown content to APPEND after existing blocks.'),
          }),
        },
      )
    : tool(
        async (input) => {
          try {
            const result = await updatePage({
              matrixClient,
              matrixConfig,
              providerConfig,
              roomId: input.room_id,
              title: input.title ? emojify(input.title) : undefined,
              topic: input.topic ? emojify(input.topic) : undefined,
              content: input.content ? emojify(input.content) : undefined,
              appendContent: input.appendContent
                ? emojify(input.appendContent)
                : undefined,
            });

            return JSON.stringify({
              success: true,
              roomId: result.roomId,
              title: result.title,
              ownerDid: result.ownerDid,
              updatedAt: result.updatedAt,
              updatedFields: result.updatedFields,
              blockCount: result.blockCount,
              diff: result.diff,
              message:
                result.updatedFields.length > 0
                  ? `Updated ${result.updatedFields.join(', ')} — page now has ${result.blockCount} block(s)`
                  : 'No fields were updated (nothing to change)',
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return JSON.stringify({
              success: false,
              roomId: input.room_id,
              error: message,
            });
          }
        },
        {
          name: 'update_page',
          description:
            'Update an existing page by its Matrix room ID (format: !id:homeserver). Can update title, topic, replace or append content.',
          schema: z.object({
            room_id: z
              .string()
              .regex(
                /^!.+:.+$/,
                'Room ID must start with "!" (e.g., "!abc123:matrix.org")',
              )
              .describe(
                'The Matrix room ID of the page (e.g., "!oeGkcJIKNpeSiaGHVE:devmx.ixo.earth"). Must start with "!".',
              ),
            title: z.string().optional().describe('New title for the page'),
            topic: z
              .string()
              .optional()
              .describe('New topic/description for the page'),
            content: z
              .string()
              .optional()
              .describe(
                'Markdown content to REPLACE all existing blocks. Use appendContent to add without replacing.',
              ),
            appendContent: z
              .string()
              .optional()
              .describe('Markdown content to APPEND after existing blocks.'),
          }),
        },
      );

  return { createPageTool, readPageTool, updatePageTool };
}
