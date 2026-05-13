// VALUE imports required for Nest DI — `design:paramtypes` metadata needs
// the runtime constructor, not a stripped `type`-only reference.
import {
  MemoryEngineService,
  SessionManagerService,
} from '@ixo/common';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Cache } from 'cache-manager';
import { MessagesService } from '../messages/messages.service.js';
import { UcanService } from '../ucan/ucan.service.js';

export interface ProcessSessionHistoryParams {
  sessionId: string;
  did: string;
  oracleEntityDid: string;
  homeServer?: string;
}

@Injectable()
export class SessionHistoryProcessor {
  private readonly logger = new Logger(SessionHistoryProcessor.name);

  constructor(
    private readonly messagesService: MessagesService,
    private readonly memoryEngineService: MemoryEngineService,
    private readonly sessionManagerService: SessionManagerService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Optional() private readonly ucanService?: UcanService,
  ) {}

  /**
   * Process session history by sending messages to memory engine.
   * Uses cache locking to prevent concurrent processing for the same session.
   */
  async processSessionHistory(
    params: ProcessSessionHistoryParams,
  ): Promise<void> {
    const cacheKey = `processing:session:${params.sessionId}`;
    const lockTtl = 5 * 60 * 1000;
    const maxRetries = 3;
    const retryDelay = 10 * 1000;

    const existingLock = await this.cacheManager.get(cacheKey);
    if (existingLock) {
      this.logger.debug(
        `Session ${params.sessionId} is already being processed, skipping`,
      );
      return;
    }

    await this.cacheManager.set(cacheKey, true, lockTtl);

    try {
      await this.processSessionHistoryWithRetry(params, maxRetries, retryDelay);
    } finally {
      await this.cacheManager.del(cacheKey);
    }
  }

  private async processSessionHistoryWithRetry(
    params: ProcessSessionHistoryParams,
    maxRetries: number,
    retryDelay: number,
  ): Promise<void> {
    const { sessionId } = params;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.processSessionHistoryInternal(params);
        this.logger.log(
          `Successfully processed session history for session ${sessionId}`,
        );
        return;
      } catch (error) {
        this.logger.warn(
          `Attempt ${attempt}/${maxRetries} failed for session ${sessionId}:`,
          error,
        );

        if (attempt === maxRetries) {
          this.logger.error(
            `Failed to process session history for session ${sessionId} after ${maxRetries} attempts`,
            error,
          );
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  private async processSessionHistoryInternal({
    sessionId,
    did,
    oracleEntityDid,
    homeServer,
  }: ProcessSessionHistoryParams): Promise<void> {
    this.logger.debug(`Processing session history for session ${sessionId}`);

    const session = await this.sessionManagerService.getSession(
      sessionId,
      did,
      false,
    );

    if (!session) {
      this.logger.warn(`Session ${sessionId} not found, skipping processing`);
      return;
    }

    const userHomeServer =
      homeServer || (await getMatrixHomeServerCroppedForDid(did));
    const { roomId } =
      await this.sessionManagerService.matrixManger.getOracleRoomIdWithHomeServer(
        {
          userDid: did,
          oracleEntityDid,
          userHomeServer,
        },
      );

    if (!roomId) {
      this.logger.warn(
        `Room not found for session ${sessionId}, skipping processing`,
      );
      return;
    }

    const messagesResponse = await this.messagesService.listMessages({
      sessionId,
      did,
      homeServer,
    });

    if (!messagesResponse.messages || messagesResponse.messages.length === 0) {
      this.logger.debug(`No messages found for session ${sessionId}`);
      return;
    }

    const lastProcessedCount = session.lastProcessedCount || 0;
    const newMessages = messagesResponse.messages.slice(lastProcessedCount);

    if (newMessages.length === 0) {
      this.logger.debug(
        `No new messages to process for session ${sessionId} (lastProcessedCount: ${lastProcessedCount})`,
      );
      return;
    }

    const transformedMessages = this.transformMessagesToMemoryEngineFormat(
      newMessages,
      session.title ?? '',
    );

    if (!this.ucanService?.hasSigningKey()) {
      this.logger.warn(
        `No UCAN signing key for session ${sessionId}, skipping memory engine processing`,
      );
      return;
    }

    const oracleMatrixBaseUrl = this.configService
      .getOrThrow<string>('MATRIX_BASE_URL')
      .replace(/\/$/, '');
    const oracleHomeServer = oracleMatrixBaseUrl.replace(/^https?:\/\//, '');

    let memoryUcanInvocation: string | undefined;
    try {
      const invocation = await this.ucanService.createServiceInvocation(
        this.configService.getOrThrow('MEMORY_ENGINE_URL'),
        did,
        'ixo:memory',
      );
      if (invocation) {
        memoryUcanInvocation = invocation;
      }
    } catch (err) {
      this.logger.warn(
        `[UCAN] Failed to create memory engine invocation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!memoryUcanInvocation) {
      this.logger.warn(
        `Could not mint UCAN invocation for memory engine; skipping memory engine processing for session ${sessionId}`,
      );
      return;
    }

    const result = await this.memoryEngineService.processConversationHistory({
      messages: transformedMessages,
      roomId,
      oracleHomeServer,
      userHomeServer,
      ucanInvocation: memoryUcanInvocation,
    });

    if (!result.success) {
      throw new Error('Failed to send messages to memory engine');
    }

    const newLastProcessedCount = lastProcessedCount + newMessages.length;
    await this.sessionManagerService.updateLastProcessedCount({
      sessionId,
      did,
      lastProcessedCount: newLastProcessedCount,
    });

    this.logger.log(
      `Processed ${newMessages.length} new messages for session ${sessionId}, updated lastProcessedCount to ${newLastProcessedCount}`,
    );
  }

  /**
   * Transform LangChain messages into the role/content shape the
   * memory engine expects.
   */
  private transformMessagesToMemoryEngineFormat(
    messages: Array<{ type: string; content: string }>,
    sessionTitle: string,
  ): Array<{
    content: string;
    role_type: 'user' | 'assistant' | 'system';
    role?: string;
    name?: string;
    source_description?: string;
  }> {
    return messages.map((message) => {
      let role_type: 'user' | 'assistant' | 'system';
      let role: string | undefined;
      let name: string | undefined;

      switch (message.type) {
        case 'human':
          role_type = 'user';
          role = 'user';
          name = 'User';
          break;
        case 'ai':
          role_type = 'assistant';
          role = 'assistant';
          name = 'AI Assistant';
          break;
        case 'system':
          role_type = 'system';
          role = 'system';
          name = 'System';
          break;
        case 'tool':
          // Memory engine has no tool role — fold tool replies into assistant.
          role_type = 'assistant';
          role = 'assistant';
          name = 'Tool Response';
          break;
        default:
          role_type = 'user';
          role = 'user';
          name = 'User';
      }

      return {
        content: message.content,
        role_type,
        role,
        name,
        source_description: `Chat Session: ${sessionTitle}`,
      };
    });
  }
}
