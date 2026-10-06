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

import { filterForwardedMessages } from '../../core/subagent-as-tool';
import { tool as pluginTool } from '../../plugin-api/tool-helper';
import {
  canAccessToolPlane,
  requireToolPlane,
} from '../../plugin-api/tool-plane';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types';
import { sharedDocumentSource, type DocumentOpener } from './content-session';
import { createContentTools } from './content-tools';
import { buildAppConfig, EDITOR_AGENT_TOOL_NAME } from './editor-agent';
import type { BlocknoteToolsConfig } from './editor-config';
import { resolveEditorMatrixClient } from './editor-mx';
import { noDocument, notAMember } from './failures';
import { editorAgentPrompt } from './prompts';
import { isUserInRoom } from './room-membership';

const standaloneEditorSchema = z.object({
  room_id: z
    .string()
    .regex(
      /^![A-Za-z0-9._=-]+:[A-Za-z0-9.-]+(?::\d+)?$/,
      'Not a Matrix room id. A real id looks like "!oeGkcJIKNpeSiaGHVE:devmx.ixo.earth" ' +
        'and only ever comes from a tool result (list_workspace_pages, ' +
        'create_page_room). Never invent or placeholder one — omit room_id ' +
        'to target the document the user has open.',
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
  /** Editor config built when the plugin's request tools are resolved. */
  toolsConfig: BlocknoteToolsConfig;
  /** The contributing plugin: names an admin content tool's capability. */
  pluginName: string;
  /**
   * Opens the target document. Defaults to the matrix-crdt opener; tests
   * pass an in-memory one.
   */
  openDocument?: DocumentOpener;
}

/**
 * Bridge the content `PluginTool`s into LangChain tools for the inner agent,
 * reusing the outer request's `RuntimeContext` rather than rebuilding one.
 * The handlers are called here, not through `wrapPluginTool`, so the plane
 * check it applies is applied here too: an admin content tool the user's
 * delegation does not grant is not bound, and the call re-checks it.
 */
function toStructuredTools(
  tools: PluginTool[],
  ctx: RuntimeContext,
  pluginName: string,
): StructuredTool[] {
  return tools
    .filter((t) => canAccessToolPlane(ctx, pluginName, t))
    .map((t) =>
      lcTool(
        async (args) => {
          requireToolPlane(ctx, pluginName, t);
          return t.handler(args, ctx);
        },
        {
          name: t.name,
          description: t.description,
          schema: t.schema,
        },
      ),
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
      // agent could be steered into any room id it is handed. On Workers the
      // check runs through the gateway Durable Object (ctx.matrix).
      if (!(await isUserInRoom(ctx, roomId, ctx.user.matrixUserId))) {
        ctx.logger.warn(
          `[editor] user ${ctx.user.did} is not a member of ${roomId} — refusing document access`,
        );
        return JSON.stringify(notAMember(roomId));
      }

      let documents: ReturnType<typeof sharedDocumentSource> | undefined;
      try {
        const matrixClient = await resolveEditorMatrixClient({
          baseUrl: opts.toolsConfig.matrix.baseUrl,
          userId: opts.toolsConfig.matrix.userId,
          accessToken: opts.toolsConfig.matrix.accessToken,
          matrixClient: opts.toolsConfig.matrixClient,
        });

        // One session for the whole run: the room cannot change identity
        // within a call, so every content tool reuses the same open doc.
        documents = sharedDocumentSource(
          {
            matrixClient,
            appConfig: buildAppConfig(opts.toolsConfig, {
              type: 'id',
              value: roomId,
            }),
          },
          opts.openDocument,
        );
        const contentTools = createContentTools({ documents });
        const boundTools = toStructuredTools(
          contentTools,
          ctx,
          opts.pluginName,
        );

        const agent = createAgent({
          model: ctx.llm.get('subagent'),
          tools: boundTools,
          systemPrompt: editorAgentPrompt,
          middleware: [],
        });

        // The turn's signal stops the inner agent's model calls and document
        // writes when the user cancels or the turn times out.
        const result = await agent.invoke(
          { messages: [new HumanMessage(task)] },
          { signal: ctx.abortSignal },
        );
        const messages = result.messages as BaseMessage[];
        const text = lastMessageContent(messages);

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
        // A cancelled turn is not a document error: let the cancellation
        // propagate.
        if (ctx.abortSignal.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.error(
          `[editor] standalone failed for ${roomId}: ${message}`,
        );
        return `Error opening the document ${roomId}: ${message}`;
      } finally {
        await documents?.close();
      }
    },
    {
      name: EDITOR_AGENT_TOOL_NAME,
      description: STANDALONE_DESCRIPTION,
      schema: standaloneEditorSchema,
    },
  );
}
