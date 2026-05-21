import { type StructuredTool } from 'langchain';
import { createHash } from 'node:crypto';
import { getProviderChatModel } from '../../llm-provider';

import { Logger } from '@nestjs/common';
import type { AgentSpec } from '../subagent-as-tool';
import {
  BLOCKNOTE_TOOLS_CONFIG,
  createBlocknoteTools,
} from './blocknote-tools';
import type { BlobStoreService } from 'src/blob-store/blob-store.service';
import type { UcanService } from 'src/ucan/ucan.service';
import type { AppConfig, MatrixRoomConfig } from './config';
import { EditorMatrixClient } from './editor-mx';
import type { PageMemoryAuth } from './page-memory';
import { createPageTools } from './page-tools';
import { editorAgentPrompt, editorAgentReadOnlyPrompt } from './prompts';

const llm = getProviderChatModel('main', {
  __includeRawResponse: true,
  modelKwargs: {
    include_reasoning: true,
  },
  reasoning: {
    effort: 'low',
  },
});

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
  room: MatrixRoomConfig,
  overrides?: AppConfigOverrides,
): AppConfig => {
  const base: AppConfig = {
    matrix: {
      ...BLOCKNOTE_TOOLS_CONFIG.matrix,
      room,
    },
    provider: {
      ...BLOCKNOTE_TOOLS_CONFIG.provider,
    },
    blocknote: {
      ...BLOCKNOTE_TOOLS_CONFIG.blocknote,
    },
  };

  if (!overrides) {
    return base;
  }

  return {
    matrix: {
      ...base.matrix,
      ...overrides.matrix,
      room: overrides.matrix?.room ?? base.matrix.room,
    },
    provider: {
      ...base.provider,
      ...overrides.provider,
    },
    blocknote: {
      ...base.blocknote,
      ...overrides.blocknote,
    },
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
      readInvocationsTool: StructuredTool;
      readSurveyTool: StructuredTool;
      validateSurveyAnswersTool: StructuredTool;
      mintInvocationTool: StructuredTool | null;
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
      readInvocationsTool: StructuredTool;
      readSurveyTool: StructuredTool;
      fillSurveyAnswersTool: StructuredTool;
      validateSurveyAnswersTool: StructuredTool;
      executeActionTool: StructuredTool;
      findAndReplaceTool: StructuredTool;
      moveBlockTool: StructuredTool;
      bulkEditBlocksTool: StructuredTool;
      mintInvocationTool: StructuredTool | null;
    };

export type EditorAgentMode = 'edit' | 'readOnly';

export type EditorAgentInstance = AgentSpec;

export interface CreateEditorAgentParams {
  room: string | MatrixRoomConfig;
  mode?: EditorAgentMode;
  configOverrides?: AppConfigOverrides;
  name?: string;
  description?: string;
  /** Matrix user ID of the page owner — invited and given power level 50 on page creation */
  userMatrixId?: string;
  /** Matrix space ID to nest new pages under */
  spaceId?: string;
  /** Auth context for logging page/block operations to the Memory Engine */
  memoryAuth?: PageMemoryAuth;
  /** When provided, registers `mint_invocation` on the editor agent so skills can sign UCAN invocations against external services without round-tripping the delegation CAR through the LLM. */
  ucanService?: UcanService;
  /** When provided alongside `ucanService`, the minted invocation is also stored in the blob store under a fresh blobId; the tool returns that blobId so the main agent can pass it to `sandbox_write_blob` instead of relaying the CAR through the LLM. */
  blobStore?: BlobStoreService;
}

const resolveTools = (
  mode: EditorAgentMode,
  toolset: BlocknoteToolset,
): StructuredTool[] => {
  if (mode === 'readOnly') {
    const tools: StructuredTool[] = [
      toolset.listBlocksTool,
      toolset.readBlockByIdTool,
      toolset.searchBlocksTool,
      toolset.readFlowContextTool,
      toolset.readFlowStatusTool,
      toolset.readBlockHistoryTool,
      toolset.readPermissionsTool,
      toolset.readInvocationsTool,
      toolset.readSurveyTool,
      toolset.validateSurveyAnswersTool,
    ];
    if (toolset.mintInvocationTool) tools.push(toolset.mintInvocationTool);
    return tools;
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
      readInvocationsTool: StructuredTool;
      readSurveyTool: StructuredTool;
      fillSurveyAnswersTool: StructuredTool;
      validateSurveyAnswersTool: StructuredTool;
      executeActionTool: StructuredTool;
      findAndReplaceTool: StructuredTool;
      moveBlockTool: StructuredTool;
      bulkEditBlocksTool: StructuredTool;
      mintInvocationTool: StructuredTool | null;
    }
  >;

  if (!writableToolset.editBlockTool || !writableToolset.createBlockTool) {
    throw new Error('Writable editor mode requires edit and create tools.');
  }

  const tools: StructuredTool[] = [
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
    writableToolset.readInvocationsTool,
    writableToolset.readSurveyTool,
    writableToolset.fillSurveyAnswersTool,
    writableToolset.validateSurveyAnswersTool,
    writableToolset.executeActionTool,
    writableToolset.findAndReplaceTool,
    writableToolset.moveBlockTool,
    writableToolset.bulkEditBlocksTool,
  ];
  if (writableToolset.mintInvocationTool)
    tools.push(writableToolset.mintInvocationTool);
  return tools;
};

export const createEditorAgent = async ({
  room,
  mode = 'edit',
  configOverrides,
  name = 'Editor Agent',
  description = 'AI Agent that read and write to pages and editor.',
  userMatrixId,
  spaceId,
  memoryAuth,
  ucanService,
  blobStore,
  userDid,
  sessionId,
}: CreateEditorAgentParams & {
  userDid: string;
  sessionId: string;
}): Promise<EditorAgentInstance> => {
  const roomConfig = normalizeRoom(room);
  const editorMatrixClient = EditorMatrixClient.getInstance();
  await editorMatrixClient.waitUntilReady();
  const matrixClient = editorMatrixClient.getClient();

  const appConfig = buildAppConfig(roomConfig, configOverrides);

  const blocknoteTools = (await createBlocknoteTools(
    matrixClient,
    appConfig,
    mode === 'readOnly',
    ucanService,
    blobStore,
    userDid,
  )) as BlocknoteToolset;

  const agentTools = resolveTools(mode, blocknoteTools);

  // Add page management tools — pass the editor room ID so update_page/read_page
  // default to it instead of requiring the LLM to provide it
  const editorRoomId = roomConfig.type === 'id' ? roomConfig.value : undefined;
  const pageTools = createPageTools(
    matrixClient,
    userMatrixId,
    spaceId,
    memoryAuth,
    editorRoomId,
  );
  agentTools.push(pageTools.readPageTool);
  if (mode === 'edit') {
    agentTools.push(pageTools.createPageTool);
    agentTools.push(pageTools.updatePageTool);
  }

  Logger.log(`Created editor agent with Mode: ${mode}`);
  Logger.log(`Tools: ${agentTools.map((t) => t.name).join(', ')}`);
  return {
    name,
    description,
    tools: agentTools,
    systemPrompt:
      mode === 'readOnly' ? editorAgentReadOnlyPrompt : editorAgentPrompt,
    model: llm,
    middleware: [],
    userDid,
    sessionId,
    threadSuffix: editorRoomId
      ? createHash('sha256').update(editorRoomId).digest('hex').slice(0, 5)
      : undefined,
  };
};
