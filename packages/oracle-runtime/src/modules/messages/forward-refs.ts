/**
 * Forward-declarations for cross-module services that are pulled in via
 * `@Optional()` injection or runtime feature toggles.
 *
 * These thin shapes describe the surface area MessagesService consumes from
 * each peer (graph orchestrator, tasks/approval, token limiter). The runtime
 * substitutes the concrete implementations at composition time. Each entry
 * here is replaced when the corresponding sibling module ships.
 */

import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { Injectable } from '@nestjs/common';
import { type BaseMessage } from 'langchain';
import {
  type AgActionDto,
  type AttachmentDto,
  type BrowserToolCallDto,
} from './dto/send-message.dto.js';

export interface UcanOptions {
  ucanService?: unknown;
  mcpInvocations?: Record<string, string>;
}

export type UserContextData = Record<string, unknown>;

export interface SendMessageOptions {
  input: BaseMessage[];
  runnableConfig: IRunnableConfigWithRequiredFields & {
    configurable: { sessionId: string };
  };
  browserTools?: BrowserToolCallDto[];
  msgFromMatrixRoom?: boolean;
  initialUserContext?: UserContextData;
  editorRoomId?: string;
  currentEntityDid?: string;
  clientType?: 'matrix' | 'slack' | 'portal';
  ucanOptions?: UcanOptions;
  fileProcessingService?: unknown;
  spaceId?: string;
  tasksService?: unknown;
}

export interface StreamMessageOptions extends SendMessageOptions {
  abortController: AbortController;
  agActions?: AgActionDto[];
}

export interface MainAgentResult {
  messages: BaseMessage[];
}

/**
 * Surface MessagesService relies on. The runtime supplies the concrete
 * orchestrator (e.g. createMainAgent output) at composition time.
 */
@Injectable()
export class MainAgentGraph {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendMessage(_options: SendMessageOptions): Promise<MainAgentResult> {
    throw new Error('MainAgentGraph not provided to runtime');
  }

  async streamMessage(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: StreamMessageOptions,
  ): Promise<AsyncIterable<{ data: unknown; event: string; tags?: string[] }>> {
    throw new Error('MainAgentGraph not provided to runtime');
  }
}

export interface ApprovalClassification {
  decision: 'approved' | 'rejected';
  reason?: string;
}

/**
 * Optional approval orchestration surface. The runtime injects the concrete
 * service when the approvals plugin is loaded; otherwise messages flow
 * through the standard chat path.
 */
@Injectable()
export class ApprovalService {
  async getPendingTaskForRoom(_roomId: string): Promise<string | null> {
    return null;
  }

  async handleApprovalResponse(_input: {
    taskId: string;
    approved: boolean;
    mainRoomId: string;
    rejectionReason?: string;
  }): Promise<void> {
    // no-op
  }
}

@Injectable()
export class TasksService {}

/**
 * Default no-op classifier — replaced by the tasks plugin when loaded.
 */
export async function classifyApprovalResponse(
  _text: string,
): Promise<ApprovalClassification | null> {
  return null;
}

/** Whether REDIS_URL is configured. */
export function isRedisEnabled(): boolean {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_URL.length > 0);
}

/**
 * Credit accounting hook used to deduct pre-flight file-processing usage.
 * The credits plugin overrides this when loaded; the default is a no-op.
 */
export const TokenLimiter = {
  usdCostToCredits(_usd: number): number {
    return 0;
  },
  llmTokenToCredits(_tokens: number): number {
    return 0;
  },
  async limit(
    _userDid: string,
    _credits: number,
  ): Promise<{ success: boolean; remaining: number }> {
    return { success: true, remaining: 0 };
  },
};

export type AttachmentMeta = {
  filename?: string;
  mimetype?: string;
  size?: number;
  mxcUri?: string;
  eventId?: string;
};

export type ProcessedAttachment = AttachmentMeta & {
  category: 'document' | 'image' | 'audio' | 'video';
  sandboxPath?: string;
};

export interface SandboxUploadConfig {
  sandboxMcpUrl: string;
  homeServerName: string;
  oracleHomeServerUrl: string;
}

/**
 * Surface MessagesService consumes from FileProcessingService.
 * The full implementation ships alongside `messages` and is exported below.
 */
export type { AttachmentDto };
