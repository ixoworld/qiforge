import type { StructuredTool } from 'langchain';

import { computeSubAgentToolName } from '../../graph/subagent-as-tool.js';
import { tool as pluginTool } from '../../plugin-api/tool-helper.js';
import type { PluginSubAgent, PluginTool } from '../../plugin-api/types.js';
import {
  createBlocknoteTools,
  type BlocknoteToolsConfig,
} from './blocknote-tools.js';
import { resolveEditorMatrixClient } from './editor-mx.js';
import {
  createMintInvocationEditorTool,
  type BlobStoreCapable,
  type UcanMintCapable,
} from './mint-invocation-tool.js';
import { createPageTools } from './page-tools.js';
import { editorAgentPrompt, editorAgentReadOnlyPrompt } from './prompts.js';
import type { AppConfig, MatrixRoomConfig } from './provider.js';

/** Default sub-agent name surfaced to the main agent. */
export const EDITOR_AGENT_NAME = 'Editor Agent';

/**
 * The tool name the main agent sees for the editor surface — identical for
 * the room-bound sub-agent (derived via `computeSubAgentToolName`) and the
 * standalone tool (which sets it directly). The prompt composer checks this
 * name to decide whether the editor-mode prompts may be injected: telling the
 * model "EDITOR MODE ACTIVE — use the Editor Agent tool" without this tool
 * bound makes it narrate its sub-agent task as user-facing text.
 */
export const EDITOR_AGENT_TOOL_NAME =
  computeSubAgentToolName(EDITOR_AGENT_NAME);

const normalizeRoom = (room: string | MatrixRoomConfig): MatrixRoomConfig => {
  if (typeof room === 'string') {
    return { type: 'id', value: room };
  }
  return room;
};

type AppConfigOverrides = {
  matrix?: Partial<AppConfig['matrix']>;
  provider?: Partial<AppConfig['provider']>;
  blocknote?: Partial<AppConfig['blocknote']>;
};

const buildAppConfig = (
  base: BlocknoteToolsConfig,
  room: MatrixRoomConfig,
  overrides?: AppConfigOverrides,
): AppConfig => {
  const merged: AppConfig = {
    matrix: {
      ...base.matrix,
      room,
    },
    provider: { ...base.provider },
    blocknote: { ...base.blocknote },
  };

  if (!overrides) {
    return merged;
  }

  return {
    matrix: {
      ...merged.matrix,
      ...overrides.matrix,
      room: overrides.matrix?.room ?? merged.matrix.room,
    },
    provider: { ...merged.provider, ...overrides.provider },
    blocknote: { ...merged.blocknote, ...overrides.blocknote },
  };
};

type BlocknoteToolset =
  | {
      listBlocksTool: StructuredTool;
      readBlockByIdTool: StructuredTool;
      searchBlocksTool: StructuredTool;
      readFlowContextTool: StructuredTool;
      readFlowStatusTool: StructuredTool;
      readBlockHistoryTool: StructuredTool;
      readPermissionsTool: StructuredTool;
      readSurveyTool: StructuredTool;
      validateSurveyAnswersTool: StructuredTool;
    }
  | {
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

export type EditorAgentMode = 'edit' | 'readOnly';

export interface CreateEditorSubAgentParams {
  /** Matrix room ID (or `{ type: 'alias', value: '#alias:domain' }`). */
  room: string | MatrixRoomConfig;
  /** Read-only restricts the toolset to non-destructive reads. */
  mode?: EditorAgentMode;
  /** Blocknote tools config built once at plugin boot from validated env. */
  toolsConfig: BlocknoteToolsConfig;
  /** Optional per-call overrides — primarily for tests. */
  configOverrides?: AppConfigOverrides;
  /** Tool name surfaced to the main agent (default `Editor Agent`). */
  name?: string;
  /** Tool description surfaced to the main agent. */
  description?: string;
  /** Matrix user ID of the page owner — invited and given power level 50 on page creation. */
  userMatrixId?: string;
  /** Matrix space ID to nest new pages under. */
  spaceId?: string;
  /** When provided, registers `mint_invocation` on the editor agent so skills
   * can sign UCAN invocations against external services without round-
   * tripping the delegation CAR through the LLM. */
  ucanService?: UcanMintCapable;
  /** When provided alongside `ucanService`, the minted invocation is also
   * stored in the blob store under a fresh blobId; the tool returns that
   * blobId so the main agent can pass it to `sandbox_write_blob` instead of
   * relaying the CAR through the LLM. */
  blobStore?: BlobStoreCapable;
  /** Owner of the blob — used as the cache namespace. */
  userDid?: string;
}

const resolveStructuredTools = (
  mode: EditorAgentMode,
  toolset: BlocknoteToolset,
): StructuredTool[] => {
  if (mode === 'readOnly') {
    return [
      toolset.listBlocksTool,
      toolset.readBlockByIdTool,
      toolset.searchBlocksTool,
      toolset.readFlowContextTool,
      toolset.readFlowStatusTool,
      toolset.readBlockHistoryTool,
      toolset.readPermissionsTool,
      toolset.readSurveyTool,
      toolset.validateSurveyAnswersTool,
    ];
  }

  const writableToolset = toolset as Extract<
    BlocknoteToolset,
    {
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
    }
  >;

  if (!writableToolset.editBlockTool || !writableToolset.createBlockTool) {
    throw new Error('Writable editor mode requires edit and create tools.');
  }

  return [
    writableToolset.listBlocksTool,
    writableToolset.editBlockTool,
    writableToolset.createBlockTool,
    writableToolset.deleteBlockTool,
    writableToolset.readBlockByIdTool,
    writableToolset.searchBlocksTool,
    writableToolset.readFlowContextTool,
    writableToolset.readFlowStatusTool,
    writableToolset.readBlockHistoryTool,
    writableToolset.readPermissionsTool,
    writableToolset.readSurveyTool,
    writableToolset.fillSurveyAnswersTool,
    writableToolset.validateSurveyAnswersTool,
    writableToolset.executeActionTool,
    writableToolset.findAndReplaceTool,
    writableToolset.moveBlockTool,
    writableToolset.bulkEditBlocksTool,
  ];
};

/**
 * Adapt a LangChain `StructuredTool` into the runtime's `PluginTool` shape so
 * it can flow through the plugin sub-agent assembly path. The handler simply
 * delegates to the underlying tool's `invoke` — the inner tool keeps its
 * strict argument validation; the wrapper exposes the same Zod schema verbatim.
 */
function wrapStructuredTool(t: StructuredTool): PluginTool {
  // The inner tool already validates its own input shape; the wrapper just
  // forwards the value through. LangChain's `StructuredTool.invoke` accepts
  // the same `unknown` input at runtime — the wrapper's `args: unknown`
  // contract matches the tool's runtime contract even though the static
  // signature is narrower (`ToolInputSchemaBase`-derived).
  return pluginTool(
    async (args) => {
      return t.invoke(args as Parameters<typeof t.invoke>[0]);
    },
    {
      name: t.name,
      description: t.description ?? '',

      schema: t.schema as PluginTool['schema'],
    },
  );
}

/**
 * Build the editor `PluginSubAgent` for the given room. The Matrix admin
 * client (`EditorMatrixClient`) is a process-wide singleton bootstrapped on
 * first call with the credentials carried in `toolsConfig`.
 */
export async function createEditorSubAgent(
  params: CreateEditorSubAgentParams,
): Promise<PluginSubAgent> {
  const {
    room,
    mode = 'edit',
    toolsConfig,
    configOverrides,
    name = EDITOR_AGENT_NAME,
    description = 'AI Agent that reads and writes pages and blocks in the BlockNote editor.',
    userMatrixId,
    spaceId,
    ucanService,
    blobStore,
    userDid,
  } = params;

  const roomConfig = normalizeRoom(room);

  const matrixClient = await resolveEditorMatrixClient({
    baseUrl: toolsConfig.matrix.baseUrl,
    userId: toolsConfig.matrix.userId,
    accessToken: toolsConfig.matrix.accessToken,
    matrixClient: toolsConfig.matrixClient,
  });

  const appConfig = buildAppConfig(toolsConfig, roomConfig, configOverrides);

  const blocknoteTools = (await createBlocknoteTools(
    matrixClient,
    appConfig,
    mode === 'readOnly',
  )) as BlocknoteToolset;

  const structuredTools = resolveStructuredTools(mode, blocknoteTools);

  const editorRoomId = roomConfig.type === 'id' ? roomConfig.value : undefined;
  const pageTools = createPageTools({
    matrixClient,
    toolsConfig,
    userMatrixId,
    defaultSpaceId: spaceId,
    defaultRoomId: editorRoomId,
  });

  structuredTools.push(pageTools.readPageTool);
  if (mode === 'edit') {
    structuredTools.push(pageTools.createPageTool);
    structuredTools.push(pageTools.updatePageTool);
  }

  // mint_invocation lives on the editor (not the main agent) because the
  // delegation CAR is read from the flow's Y.Doc by CID — only this closure
  // has the matrixClient + roomId baked in. The main agent reaches it via
  // call_editor_agent + the `forwardTools` list below.
  if (ucanService && editorRoomId) {
    structuredTools.push(
      createMintInvocationEditorTool({
        matrixClient,
        appConfig,
        roomId: editorRoomId,
        ucanService,
        blobStore,
        userDid,
      }),
    );
  }

  const tools = structuredTools.map(wrapStructuredTool);

  return {
    name,
    description,
    systemPrompt:
      mode === 'readOnly' ? editorAgentReadOnlyPrompt : editorAgentPrompt,
    tools,
    model: 'subagent',
    middlewares: [],
    // Forward EVERY tool call (reads and writes) into the main chat so the
    // FE renders page/block activity inline and the main agent sees results
    // directly — e.g. `mint_invocation`'s `blobId`, which it passes straight
    // to `sandbox_write_blob`.
    forwardTools: ['create_page', 'update_page', 'mint_invocation'],
  };
}
