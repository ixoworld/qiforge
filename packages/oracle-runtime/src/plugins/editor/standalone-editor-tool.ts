import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createAgent, type StructuredTool } from 'langchain';
import { z } from 'zod';
import { emojify } from '../../utils/emoji.js';

import { createConstitutionGateMiddleware } from '../../graph/middlewares/index.js';
import { getCurrentDecisionLedger } from '../../modules/domain-context/current-ledger.js';
import { filterForwardedMessages } from '../../graph/subagent-as-tool.js';
import { isUserInRoom } from '../../matrix/room-membership.js';
import { EDITOR_AGENT_TOOL_NAME } from './editor-agent.js';
import { tool as pluginTool } from '../../plugin-api/tool-helper.js';
import type {
  PluginTool,
  RuntimeContext,
  ToolEffect,
} from '../../plugin-api/types.js';
import {
  createBlocknoteTools,
  type BlocknoteToolsConfig,
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
    .optional()
    .describe(
      'The Matrix room ID of an EXISTING page to read or edit (e.g., "!oeGkcJIKNpeSiaGHVE:devmx.ixo.earth"). ' +
        "OMIT this entirely to CREATE a new page — create_page generates a fresh room under the user's space and returns its id.",
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
  'Call Editor Agent as a sub-agent to operate on a BlockNote page. ' +
  'Pass a `room_id` to read or edit an EXISTING page; OMIT `room_id` to CREATE a new page ' +
  "(create_page makes a fresh room under the user's space and returns its id). " +
  'Spins up an ephemeral editor session with full block-level and page-management tools.';

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
 * sessions. Each invocation spins up a short-lived inner agent — over the
 * supplied `room_id`, or in create mode (no `room_id`) with only the
 * page-lifecycle tools — and returns a Command that pushes the inner tool
 * calls plus the final reply into the parent graph, mirroring the
 * `forwardTools: true` behaviour of the editor sub-agent path.
 */
export function createStandaloneEditorTool(
  opts: CreateStandaloneEditorToolOptions,
): PluginTool {
  return pluginTool(
    async (rawArgs, ctx: RuntimeContext) => {
      const { room_id: roomId, task } = standaloneEditorSchema.parse(rawArgs);

      // Membership guard. For an EXISTING page the user must be a member of
      // that room (the editor acts with the oracle's admin identity, so without
      // this an agent could be steered to read/edit any room id it's handed).
      // For CREATE (no roomId) the new page is nested under `opts.spaceId`, so
      // guard on space membership instead. The refusal text is addressed to
      // the agent so it can explain the situation to the user instead of
      // surfacing a bare permission error.
      const guardRoomId = roomId ?? opts.spaceId;
      if (!(await isUserInRoom(guardRoomId, ctx.user.matrixUserId))) {
        ctx.logger.warn(
          `[StandaloneEditorTool] user ${ctx.user.did} is not a member of ${guardRoomId} — refusing access`,
        );
        return roomId
          ? `Access denied: the user is not a member of page room ${roomId}. ` +
              'Tell the user they do not have access to this page — they need to be ' +
              'invited to it before you can read or edit it on their behalf.'
          : `Access denied: the user is not a member of workspace space ${opts.spaceId}. ` +
              'Tell the user they are not part of this workspace — they need to be ' +
              'invited to the space before you can create pages in it on their behalf.';
      }

      try {
        const matrixClient = await resolveEditorMatrixClient({
          baseUrl: opts.toolsConfig.matrix.baseUrl,
          userId: opts.toolsConfig.matrix.userId,
          accessToken: opts.toolsConfig.matrix.accessToken,
          matrixClient: opts.toolsConfig.matrixClient,
        });

        // `create_page` always mints a brand-new room under the space, so it
        // needs no preset room. read/update fall back to a `room_id` argument
        // when there's no `defaultRoomId` (create mode).
        const pageTools = createPageTools({
          matrixClient,
          toolsConfig: opts.toolsConfig,
          userMatrixId: opts.userMatrixId,
          defaultSpaceId: opts.spaceId,
          defaultRoomId: roomId,
        });

        const innerTools: StructuredTool[] = [];

        // Block-level tools (and mint_invocation) only make sense over an
        // existing page's Y.Doc. In create mode there is no page yet, so we
        // expose ONLY the page-lifecycle tools and let create_page make the
        // room — binding block tools over a non-page room (e.g. the space)
        // would be meaningless and error-prone.
        if (roomId && roomId !== opts.spaceId) {
          const roomConfig: MatrixRoomConfig = { type: 'id', value: roomId };
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

          innerTools.push(
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
          );

          // mint_invocation — only when an oracle signing key is loaded. The
          // delegation CAR is read from the flow's Y.Doc by CID, which needs
          // the matrixClient + roomId baked into this closure.
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
        }

        innerTools.push(
          pageTools.readPageTool,
          pageTools.createPageTool,
          pageTools.updatePageTool,
        );

        const boundTools = innerTools.filter((t): t is StructuredTool =>
          Boolean(t),
        );

        // The editor's tools are assembled here as `StructuredTool`s rather
        // than collected from a registry, so none of them carries an `effect`
        // declaration to read. Until they do, classify by name with the
        // conservative default: anything not obviously a read is treated as a
        // `write`. Erring toward the more restricted class means a
        // misclassification over-gates rather than letting an edit through
        // unevaluated, and the object is scoped to the room being edited so a
        // grant can bound the editor to one workspace.
        const editorEffects = new Map<string, ToolEffect>(
          boundTools.map((t) => [
            t.name,
            {
              type: t.name.startsWith('read_') ? 'read' : 'write',
              action: t.name,
              object: () => `ixo:editor/${roomId}`,
            },
          ]),
        );

        const recorder = getCurrentDecisionLedger();
        const agent = createAgent({
          model: ctx.llm.get('subagent'),
          tools: boundTools,
          systemPrompt: editorAgentPrompt,
          // This used to be an empty array, which made the standalone editor
          // the one agent in the runtime whose tool calls nothing evaluated.
          // Its tools are built here rather than collected from a registry, so
          // the effect map is built here too.
          middleware: [
            createConstitutionGateMiddleware({
              domain: ctx.domain,
              effectByToolName: editorEffects,
              rtCtx: ctx,
              logger: ctx.logger,
              // Not from `ctx`: `RuntimeContext` is the plugin-facing type,
              // and a ledger reachable from it is a ledger any plugin can
              // write to.
              ...(recorder ? { recorder } : {}),
            }),
          ],
        });

        const result = await agent.invoke({
          messages: [new HumanMessage(task)],
        });
        const messages = result.messages as BaseMessage[];
        const text = emojify(lastMessageContent(messages));

        // Forward every inner tool call + result into the parent graph via
        // Command — same mechanism as `createSubagentAsTool` with the editor
        // sub-agent's `forwardTools: true` — so the FE renders page/block
        // activity inline regardless of which editor path handled the turn.
        // Without a parent tool_call_id there is no call to attach the
        // Command's ToolMessage to, so fall back to plain text.
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
        const label = roomId ?? 'new page';
        ctx.logger.error(
          `[StandaloneEditorTool] Failed for ${label}: ${message}`,
        );
        return `Error opening editor for ${label}: ${message}`;
      }
    },
    {
      name: EDITOR_AGENT_TOOL_NAME,
      description: STANDALONE_DESCRIPTION,
      schema: standaloneEditorSchema,
    },
  );
}
