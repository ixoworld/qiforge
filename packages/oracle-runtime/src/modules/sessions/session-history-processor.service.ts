// VALUE imports required for Nest DI — `design:paramtypes` metadata needs
// the runtime constructor, not a stripped `type`-only reference.
import {
  MemoryEngineService,
  SessionManagerService,
} from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Cache } from 'cache-manager';
import { UserPreferencesService } from '../../plugins/user-preferences/service/user-preferences.service.js';
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

    // Speaker identities for graphiti's extractor. Without these, every
    // message's episode body starts with the literal string "user" or
    // "assistant" — graphiti's extraction prompt then creates entity nodes
    // with those generic names and pins all extracted facts to them,
    // polluting the graph. Real identities make the graph person-centric.
    // Graphiti partitions memories per (user, oracle) via group_id, so a
    // simple "Me"/"Oracle" fallback is collision-safe within a user's graph.
    const prefs = await UserPreferencesService.getInstance()
      .get(roomId)
      .catch(() => undefined);
    const userSpeakerLabel = await this.resolveUserDisplayName(
      did,
      prefs?.userName,
      userHomeServer,
    );
    const oracleSpeakerLabel =
      prefs?.agentName?.trim() ||
      this.configService.get<string>('ORACLE_NAME')?.trim() ||
      'Oracle';

    const transformedMessages = this.transformMessagesToMemoryEngineFormat(
      newMessages,
      session.title ?? '',
      userSpeakerLabel,
      oracleSpeakerLabel,
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
   * memory engine expects. `userSpeakerLabel` and `oracleSpeakerLabel` become
   * the `name` (and `role`) the memory engine sees for each message — these
   * are what graphiti's extractor will use as the speaker entity in the graph,
   * so they MUST be meaningful identities (not the literal strings
   * "user"/"assistant"), otherwise every fact gets pinned to a generic
   * placeholder node.
   */
  private transformMessagesToMemoryEngineFormat(
    messages: Array<{ type: string; content: string }>,
    sessionTitle: string,
    userSpeakerLabel: string,
    oracleSpeakerLabel: string,
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
          role = userSpeakerLabel;
          name = userSpeakerLabel;
          break;
        case 'ai':
          role_type = 'assistant';
          role = oracleSpeakerLabel;
          name = oracleSpeakerLabel;
          break;
        case 'system':
          role_type = 'system';
          role = 'System';
          name = 'System';
          break;
        case 'tool':
          // Memory engine has no tool role — fold tool replies into assistant.
          // Tool responses are framed as the oracle reporting back, so they
          // share the oracle speaker label.
          role_type = 'assistant';
          role = oracleSpeakerLabel;
          name = oracleSpeakerLabel;
          break;
        default:
          role_type = 'user';
          role = userSpeakerLabel;
          name = userSpeakerLabel;
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

  /**
   * Resolve the user's display name for graphiti's speaker label. Cascade:
   *   1. `userName` from preferences (caller passes it in — fetched once
   *      alongside agentName)
   *   2. Matrix profile displayname (looked up via @did-…:homeServer)
   *   3. "Me" — safe fallback because each user has their own group_id
   *      partition in graphiti, so a generic label can't collide cross-user.
   */
  private async resolveUserDisplayName(
    did: string,
    prefsUserName: string | undefined,
    userHomeServer: string,
  ): Promise<string> {
    const fromPrefs = prefsUserName?.trim();
    if (fromPrefs) return fromPrefs;

    try {
      const matrixUserId = `@did-${did.replace(/:/g, '-')}:${userHomeServer}`;
      const displayName = await MatrixManager.getInstance()
        .getDisplayName(matrixUserId);
      const trimmed = displayName?.trim();
      if (trimmed) return trimmed;
    } catch (error) {
      this.logger.warn(
        `[resolveUserDisplayName] matrix lookup failed for ${did}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return 'Me';
  }
}
