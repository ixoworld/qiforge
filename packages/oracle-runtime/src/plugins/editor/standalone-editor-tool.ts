/**
 * `call_editor_agent`: the document surface. One tool for every case — it
 * targets the document the user has open by default, and any `room_id` the
 * main agent names, so a page created mid-turn can be written into while
 * another document is open. Each invocation spins up a short-lived inner agent
 * over that one document and forwards its tool calls into the parent graph.
 */

import { tool as lcTool } from '@langchain/core/tools';
import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createAgent, type StructuredTool } from 'langchain';
import { z } from 'zod';

import { filterForwardedMessages } from '../../graph/subagent-as-tool.js';
import { isUserInRoom } from '../../matrix/room-membership.js';
import { tool as pluginTool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import { emojify } from '../../utils/emoji.js';
import { createContentTools } from './content-tools.js';
import { buildAppConfig, EDITOR_AGENT_TOOL_NAME } from './editor-agent.js';
import type { BlocknoteToolsConfig } from './editor-config.js';
import { resolveEditorMatrixClient } from './editor-mx.js';
import { noDocument, notAMember } from './failures.js';
import { editorAgentPrompt } from './prompts.js';

const standaloneEditorSchema = z.object({
  room_id: z
    .string()
    .regex(
      /^!.+:.+$/,
      'Room ID must start with "!" (e.g., "!abc123:matrix.org")',
    )
    .optional()
    .describe(
      'Matrix room ID of the document to read or edit (e.g. ' +
        '"!oeGkcJIKNpeSiaGHVE:devmx.ixo.earth"). Omit it to target the ' +
        'document the user currently has open. Pass it to target any other ' +
        'document — the id returned by create_page_room, or one found with ' +
        'list_workspace_pages. Never guess it.',
    ),
  task: z
    .string()
    .min(1)
    .describe(
      'A detailed, self-contained instruction. The document assistant has NO ' +
        'conversation context — this string is all it receives. Include the ' +
        'objective, block ids, property names, and exact values. Do not put ' +
        'the room id here.',
    ),
});

const STANDALONE_DESCRIPTION =
  'Content assistant for one document. Targets the document the user has ' +
  'open by default; pass `room_id` to target any other document, including ' +
  'one just created with create_page_room. Give it a self-contained `task`: ' +
  'it reads the document and edits its content (insert, rewrite, reorder, ' +
  'delete, replace text). It does not create documents, build flows, or run ' +
  'blocks.';

function lastMessageContent(messages: BaseMessage[]): string {
  const last = messages.at(-1);
  if (!last?.content) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    for (const part of last.content) {
      if (typeof part !== 'object' || part === null) continue;
      const record: Record<string, unknown> = part;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
    }
    return '';
  }
  return JSON.stringify(last.content);
}

export interface CreateStandaloneEditorToolOptions {
  /** Editor config built at plugin boot. */
  toolsConfig: BlocknoteToolsConfig;
}

/**
 * Bridge the content `PluginTool`s into LangChain tools for the inner agent,
 * reusing the outer request's `RuntimeContext` rather than rebuilding one.
 */
function toStructuredTools(
  tools: PluginTool[],
  ctx: RuntimeContext,
): StructuredTool[] {
  return tools.map((t) =>
    lcTool(async (args) => t.handler(args, ctx), {
      name: t.name,
      description: t.description,
      schema: t.schema,
    }),
  );
}

/** The document the client reports as open, when there is one. */
function readOpenDocument(ctx: RuntimeContext): string | undefined {
  const value = ctx.history.state.editorRoomId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createStandaloneEditorTool(
  opts: CreateStandaloneEditorToolOptions,
): PluginTool {
  return pluginTool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { room_id: explicitRoomId, task } =
        standaloneEditorSchema.parse(rawArgs);
      const roomId = explicitRoomId ?? readOpenDocument(ctx);
      if (!roomId) return JSON.stringify(noDocument());

      // The assistant acts with the oracle's admin identity, so "the user's
      // documents" must be computed from the *user's* membership — otherwise an
      // agent could be steered into any room id it is handed.
      if (!(await isUserInRoom(roomId, ctx.user.matrixUserId))) {
        ctx.logger.warn(
          `[editor] user ${ctx.user.did} is not a member of ${roomId} — refusing document access`,
        );
        return JSON.stringify(notAMember(roomId));
      }

      try {
        const matrixClient = await resolveEditorMatrixClient({
          baseUrl: opts.toolsConfig.matrix.baseUrl,
          userId: opts.toolsConfig.matrix.userId,
          accessToken: opts.toolsConfig.matrix.accessToken,
          matrixClient: opts.toolsConfig.matrixClient,
        });

        const contentTools = createContentTools({
          matrixClient,
          appConfig: buildAppConfig(opts.toolsConfig, {
            type: 'id',
            value: roomId,
          }),
        });
        const boundTools = toStructuredTools(contentTools, ctx);

        const agent = createAgent({
          model: ctx.llm.get('subagent'),
          tools: boundTools,
          systemPrompt: editorAgentPrompt,
          middleware: [],
        });

        const result = await agent.invoke({
          messages: [new HumanMessage(task)],
        });
        const messages = result.messages as BaseMessage[];
        const text = emojify(lastMessageContent(messages));

        // Forward the inner tool calls + results into the parent graph — the
        // same mechanism `createSubagentAsTool` uses with `forwardTools` — so
        // the FE renders document activity inline whichever path handled the
        // turn. Without a parent tool_call_id there is nothing to attach to.
        const toolCallId = ctx.toolCallId;
        if (!toolCallId) return text;

        const forwardSet = new Set(boundTools.map((t) => t.name));
        const forwarded = filterForwardedMessages(
          messages,
          forwardSet,
          toolCallId,
        );
        if (forwarded.length === 0) return text;

        return new Command({
          update: {
            messages: [
              ...forwarded,
              new ToolMessage({ content: text, tool_call_id: toolCallId }),
            ],
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.error(
          `[editor] standalone failed for ${roomId}: ${message}`,
        );
        return `Error opening the document ${roomId}: ${message}`;
      }
    },
    {
      name: EDITOR_AGENT_TOOL_NAME,
      description: STANDALONE_DESCRIPTION,
      schema: standaloneEditorSchema,
    },
  );
}
