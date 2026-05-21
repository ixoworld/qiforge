import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import 'dotenv/config';
import { type BaseMessage, HumanMessage } from 'langchain';
import {
  type AgActionDto,
  type BrowserToolCallDto,
} from 'src/messages/dto/send-message.dto';
import { type BlobStoreService } from 'src/blob-store/blob-store.service';
import { type UcanService } from 'src/ucan/ucan.service';
import { type FileProcessingService } from 'src/messages/file-processing.service';
import { type TasksService } from 'src/tasks/task.service';
import { createMainAgent } from './agents/main-agent';
import { getLLMProvider, getModelForRole } from './llm-provider';
import { type MCPUCANContext } from './mcp';
import { type TMainAgentGraphState } from './state';

/**
 * Options for agent methods that support UCAN
 */
export interface UCANOptions {
  /** UCAN service for MCP tool authorization */
  ucanService?: UcanService;
  /** Map of tool names to serialized invocations */
  mcpInvocations?: Record<string, string>;
}

/**
 * Options for {@link MainAgentGraph.sendMessage}
 */
export interface SendMessageOptions {
  input: string | BaseMessage[];
  runnableConfig: IRunnableConfigWithRequiredFields & {
    configurable: { sessionId: string };
  };
  browserTools?: BrowserToolCallDto[];
  msgFromMatrixRoom?: boolean;
  initialUserContext?: TMainAgentGraphState['userContext'];
  editorRoomId?: string;
  currentEntityDid?: string;
  clientType?: 'matrix' | 'slack';
  ucanOptions?: UCANOptions;
  blobStore?: BlobStoreService;
  fileProcessingService?: FileProcessingService;
  spaceId?: string;
  tasksService?: TasksService;
}

/**
 * Options for {@link MainAgentGraph.streamMessage}
 */
export interface StreamMessageOptions {
  input: string | BaseMessage[];
  runnableConfig: IRunnableConfigWithRequiredFields & {
    configurable: { sessionId: string };
  };
  browserTools?: BrowserToolCallDto[];
  msgFromMatrixRoom?: boolean;
  initialUserContext?: TMainAgentGraphState['userContext'];
  abortController?: AbortController;
  editorRoomId?: string;
  currentEntityDid?: string;
  clientType?: 'matrix' | 'slack';
  agActions?: AgActionDto[];
  ucanOptions?: UCANOptions;
  blobStore?: BlobStoreService;
  fileProcessingService?: FileProcessingService;
  spaceId?: string;
  tasksService?: TasksService;
}

export class MainAgentGraph {
  async sendMessage(
    options: SendMessageOptions,
  ): Promise<Pick<TMainAgentGraphState, 'messages'>> {
    const {
      input,
      runnableConfig,
      browserTools,
      msgFromMatrixRoom = false,
      initialUserContext,
      editorRoomId,
      currentEntityDid,
      clientType,
      ucanOptions,
      blobStore,
      fileProcessingService,
      spaceId,
      tasksService,
    } = options;

    if (!runnableConfig.configurable.sessionId) {
      throw new Error('sessionId is required');
    }

    const messages: BaseMessage[] =
      typeof input === 'string'
        ? [
            new HumanMessage({
              content: input,
              additional_kwargs: {
                msgFromMatrixRoom,
                timestamp: new Date().toISOString(),
              },
            }),
          ]
        : input;

    Logger.log(
      `[sendMessage]: msgFromMatrixRoom: ${msgFromMatrixRoom} messages: ${messages.length}`,
    );

    // Build UCAN context if invocations are provided
    const mcpUcanContext: MCPUCANContext | undefined =
      ucanOptions?.mcpInvocations
        ? { invocations: ucanOptions.mcpInvocations }
        : undefined;

    const state = {
      messages,
      browserTools,
      editorRoomId,
      currentEntityDid,
      spaceId,
      client: clientType ?? 'portal',
      mcpUcanContext,
      ...(initialUserContext ? { userContext: initialUserContext } : {}),
    } satisfies Partial<TMainAgentGraphState>;

    const configModelOverride = (
      runnableConfig.configurable as Record<string, unknown>
    ).modelOverride as string | undefined;

    const agent = await createMainAgent({
      state,
      config: {
        ...runnableConfig,
        recursionLimit: 150,
        configurable: {
          ...runnableConfig.configurable,
          thread_id: runnableConfig.configurable.sessionId,
        },
      },
      ucanService: ucanOptions?.ucanService,
      blobStore,
      fileProcessingService,
      modelOverride: configModelOverride,
      tasksService,
    });

    const invokeConfig = {
      ...runnableConfig,
      recursionLimit: 150,
      configurable: {
        ...runnableConfig.configurable,
        thread_id: runnableConfig.configurable.sessionId,
      },
    };

    const result = await agent.invoke(
      { messages, editorRoomId },
      {
        ...invokeConfig,
        metadata: {
          llmProvider: getLLMProvider(),
          llmModel: configModelOverride ?? getModelForRole('main'),
        },
        context: {
          userDid: runnableConfig.configurable.configs?.user.did ?? '',
        },
        durability: 'async',
      },
    );

    return {
      messages: result.messages,
    };
  }

  async streamMessage(options: StreamMessageOptions) {
    const {
      input,
      runnableConfig,
      browserTools,
      msgFromMatrixRoom = false,
      initialUserContext,
      abortController,
      editorRoomId,
      currentEntityDid,
      clientType = 'portal',
      agActions,
      ucanOptions,
      blobStore,
      fileProcessingService,
      spaceId,
      tasksService,
    } = options;

    if (!runnableConfig.configurable.sessionId) {
      throw new Error('sessionId is required');
    }

    // Debug: Log abort signal state
    if (abortController) {
      Logger.debug(
        `[streamMessage] AbortController passed, signal.aborted: ${abortController.signal.aborted}`,
      );
      abortController.signal.addEventListener('abort', () => {
        Logger.debug('[streamMessage] Abort signal fired!');
      });
    }

    const messages: BaseMessage[] =
      typeof input === 'string'
        ? [
            new HumanMessage({
              content: input,
              additional_kwargs: {
                msgFromMatrixRoom,
                timestamp: new Date().toISOString(),
              },
            }),
          ]
        : input;

    // Build UCAN context if invocations are provided
    const mcpUcanContext: MCPUCANContext | undefined =
      ucanOptions?.mcpInvocations
        ? { invocations: ucanOptions.mcpInvocations }
        : undefined;

    const state = {
      messages,
      browserTools,
      editorRoomId,
      currentEntityDid,
      spaceId,
      client: clientType,
      mcpUcanContext,
      ...(initialUserContext ? { userContext: initialUserContext } : {}),
      agActions,
    } satisfies Partial<TMainAgentGraphState>;

    const agent = await createMainAgent({
      state,
      config: {
        ...runnableConfig,
        recursionLimit: 150,
        configurable: {
          ...runnableConfig.configurable,
        },
      },
      ucanService: ucanOptions?.ucanService,
      blobStore,
      fileProcessingService,
      tasksService,
    });

    const stream = agent.streamEvents(
      { messages, editorRoomId },
      {
        version: 'v2',
        ...runnableConfig,
        streamMode: ['updates', 'messages'] as const,
        recursionLimit: 150,
        configurable: {
          ...runnableConfig.configurable,
          llmProvider: getLLMProvider(),
          llmModel: getModelForRole('main'),
        },
        context: {
          userDid: runnableConfig.configurable.configs?.user.did ?? '',
        },
        // Signal must be last to ensure it's not overwritten by runnableConfig spread
        signal: abortController?.signal,
      },
    );

    return stream;
  }

  public async getGraphState(
    config: IRunnableConfigWithRequiredFields & {
      sessionId: string;
    },
  ): Promise<Pick<TMainAgentGraphState, 'messages'> | undefined> {
    const agent = await createMainAgent({
      state: {
        messages: [],
        browserTools: [],
        editorRoomId: undefined,
        currentEntityDid: undefined,
        spaceId: undefined,
        client: 'portal',
        userContext: undefined,
      } satisfies Partial<TMainAgentGraphState>,
      config: {
        ...config,
        recursionLimit: 150,
        configurable: {
          ...config.configurable,
        },
      },
    });
    const state =
      (await agent.graph.getState(config)) ?? agent.getState(config);
    if (Object.keys(state.values as TMainAgentGraphState).length === 0) {
      return undefined;
    }
    return state.values as TMainAgentGraphState;
  }
}

export const mainAgent = new MainAgentGraph();
