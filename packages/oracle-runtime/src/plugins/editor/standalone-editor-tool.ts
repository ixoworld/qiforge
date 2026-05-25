import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { createAgent, type StructuredTool } from 'langchain';
import { emojify } from '../../utils/emoji.js';
import { z } from 'zod';

import { tool as pluginTool } from '../../plugin-api/tool-helper.js';
import type { PluginTool, RuntimeContext } from '../../plugin-api/types.js';
import {
  type BlocknoteToolsConfig,
  createBlocknoteTools,
} from './blocknote-tools.js';
import { resolveEditorMatrixClient } from './editor-mx.js';
import { createMintInvocationEditorTool } from './mint-invocation-tool.js';
import { createPageTools } from './page-tools.js';
import { editorAgentPrompt } from './prompts.js';
import type { AppConfig, MatrixRoomConfig } from './provider.js';

/**
 * Writable toolset shape returned by `createBlocknoteTools(... false)`. The
 * factory returns a discriminated union over the read-only flag; the
 * standalone tool always requests the writable branch, so we narrow via this
 * structural alias.
 */
type WritableBlocknoteToolset = {
  listBlocksTool: StructuredTool;
  editBlockTool: StructuredTool;
  createBlockTool: StructuredTool;
  deleteBlockTool: StructuredTool;
  readBlockByIdTool: StructuredTool;
  searchBlocksTool: StructuredTool;
  readFlowContextTool: StructuredTool;
  readFlowStatusTool: StructuredTool;
  readBlockHistoryTool: StructuredTool;
  readPermissionsTool: StructuredTool;
  readSurveyTool: StructuredTool;
  fillSurveyAnswersTool: StructuredTool;
  validateSurveyAnswersTool: StructuredTool;
  executeActionTool: StructuredTool;
  findAndReplaceTool: StructuredTool;
  moveBlockTool: StructuredTool;
  bulkEditBlocksTool: StructuredTool;
};

const standaloneEditorSchema = z.object({
  room_id: z
    .string()
    .regex(
      /^!.+:.+$/,
      'Room ID must start with "!" (e.g., "!abc123:matrix.org")',
    )
    .describe(
      'The Matrix room ID of the page (e.g., "!oeGkcJIKNpeSiaGHVE:devmx.ixo.earth"). Must start with "!".',
    ),
  task: z
    .string()
    .describe(
      'A detailed, self-contained editing instruction. The editor agent has NO conversation context — ' +
        'this string is ALL it receives. Include: explicit objective, block IDs, property names, exact values, ' +
        'and expected outcome. Do NOT include the room ID here — it goes in room_id.',
    ),
});

const STANDALONE_DESCRIPTION =
  'Call Editor Agent as a sub-agent to operate on a BlockNote page by Matrix room ID. ' +
  'Spins up an ephemeral editor session with full block-level capabilities and page management tools for the supplied room.';

function lastMessageContent(messages: BaseMessage[]): string {
  const last = messages.at(-1);
  if (!last?.content) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    const textPart = last.content.find(
      (block: { type?: string; text?: string }) =>
        block.type === 'text' && block.text,
    );
    return (textPart as { text?: string } | undefined)?.text ?? '';
  }
  return JSON.stringify(last.content);
}

export interface CreateStandaloneEditorToolOptions {
  /** Blocknote tools config built at plugin boot. */
  toolsConfig: BlocknoteToolsConfig;
  /** Matrix space ID to nest new pages under. */
  spaceId: string;
  /** Matrix user ID of the page owner — invited and given power level 50 on page creation. */
  userMatrixId?: string;
}

/**
 * Build the `call_editor_agent` plugin tool for standalone (no preset room)
 * sessions. Each invocation spins up a short-lived inner agent over the
 * supplied `room_id` and returns its final reply text.
 */
export function createStandaloneEditorTool(
  opts: CreateStandaloneEditorToolOptions,
): PluginTool {
  return pluginTool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { room_id: roomId, task } = standaloneEditorSchema.parse(rawArgs);

      try {
        const roomConfig: MatrixRoomConfig = { type: 'id', value: roomId };

        const matrixClient = await resolveEditorMatrixClient({
          baseUrl: opts.toolsConfig.matrix.baseUrl,
          userId: opts.toolsConfig.matrix.userId,
          accessToken: opts.toolsConfig.matrix.accessToken,
          matrixClient: opts.toolsConfig.matrixClient,
        });

        const appConfig: AppConfig = {
          matrix: { ...opts.toolsConfig.matrix, room: roomConfig },
          provider: { ...opts.toolsConfig.provider },
          blocknote: { ...opts.toolsConfig.blocknote },
        };

        // `createBlocknoteTools` returns a discriminated union over the
        // read-only flag. The standalone tool always wants the writable
        // branch; this is the same narrowing the editor sub-agent applies.
        const blocknoteTools = (await createBlocknoteTools(
          matrixClient,
          appConfig,
          false,
        )) as WritableBlocknoteToolset;

        const pageTools = createPageTools({
          matrixClient,
          toolsConfig: opts.toolsConfig,
          userMatrixId: opts.userMatrixId,
          defaultSpaceId: opts.spaceId,
          defaultRoomId: roomId,
        });

        const innerTools: StructuredTool[] = [
          blocknoteTools.listBlocksTool,
          blocknoteTools.editBlockTool,
          blocknoteTools.createBlockTool,
          blocknoteTools.deleteBlockTool,
          blocknoteTools.readBlockByIdTool,
          blocknoteTools.searchBlocksTool,
          blocknoteTools.readFlowContextTool,
          blocknoteTools.readFlowStatusTool,
          blocknoteTools.readBlockHistoryTool,
          blocknoteTools.readPermissionsTool,
          blocknoteTools.readSurveyTool,
          blocknoteTools.fillSurveyAnswersTool,
          blocknoteTools.validateSurveyAnswersTool,
          blocknoteTools.executeActionTool,
          blocknoteTools.findAndReplaceTool,
          blocknoteTools.moveBlockTool,
          blocknoteTools.bulkEditBlocksTool,
          pageTools.readPageTool,
          pageTools.createPageTool,
          pageTools.updatePageTool,
        ].filter((t): t is StructuredTool => Boolean(t));

        // mint_invocation — only when an oracle signing key is loaded. The
        // ephemeral agent gets it for the same reasons the long-lived editor
        // sub-agent does: the delegation CAR is read from the flow's Y.Doc
        // by CID, which needs the matrixClient + roomId baked into this
        // closure.
        if (ctx.ucan.hasSigningKey()) {
          innerTools.push(
            createMintInvocationEditorTool({
              matrixClient,
              appConfig,
              roomId,
              ucanService: ctx.ucan,
              blobStore: ctx.blobStore,
              userDid: ctx.user.did,
            }),
          );
        }

        const agent = createAgent({
          model: ctx.llm.get('subagent'),
          tools: innerTools,
          systemPrompt: editorAgentPrompt,
          middleware: [],
        });

        const result = await agent.invoke({
          messages: [new HumanMessage(task)],
        });
        const messages = result.messages as BaseMessage[];
        return emojify(lastMessageContent(messages));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.error(
          `[StandaloneEditorTool] Failed for room ${roomId}: ${message}`,
        );
        return `Error opening editor for room ${roomId}: ${message}`;
      }
    },
    {
      name: 'call_editor_agent',
      description: STANDALONE_DESCRIPTION,
      schema: standaloneEditorSchema,
    },
  );
}
