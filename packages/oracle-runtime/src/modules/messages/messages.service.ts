import {
  SessionManagerService,
  transformGraphStateMessageToListMessageResponse,
  type ListOracleMessagesResponse,
} from '@ixo/common';
import { SqliteSaver } from '@ixo/sqlite-saver';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AIMessage, HumanMessage, type BaseMessage } from 'langchain';

import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { BatchInvoker } from './batch-invoker.js';
import { type ListMessagesDto } from './dto/list-messages.dto.js';
import { type SendMessagePayload } from './dto/send-message.dto.js';
import { FileProcessingService } from './file-processing.service.js';
import { MatrixListenerBridge } from './matrix-listener-bridge.js';
import { PostMessageSyncer } from './post-message-syncer.js';
import { RequestPreparer } from './request-preparer.js';
import { SseStreamRunner } from './sse-stream-runner.js';

/**
 * Express-side auth shape (as set by `AuthHeaderMiddleware`). Mirrors the
 * declaration-merged `Request.authData.ucanDelegation` so the controller
 * can hand it down without translating UCAN's native `can`/`with` naming
 * into the plugin-API's `action`/`resource` naming at the boundary.
 * Translation lives in `AgentBuilder` where the value is actually consumed
 * as a `UcanDelegation`.
 */
export interface AuthUcanDelegation {
  raw: string;
  issuer: string;
  audience: string;
  capabilities: unknown[];
  expiration?: number;
}

export interface SendMessageRequest extends SendMessagePayload {
  res?: Response;
  req?: Request;
  clientType?: 'matrix' | 'slack' | 'portal';
  msgFromMatrixRoom?: boolean;
  overrideLangchainThreadId?: string;
  /**
   * Authenticated UCAN delegation from `req.authData.ucanDelegation`.
   * Threaded through to `requestCtx.user.ucanDelegation` so plugins can
   * mint downstream invocations from the raw header. Absent on the Matrix
   * listener path — the bot acts as the oracle, not as a user.
   */
  ucanDelegation?: AuthUcanDelegation;
}

interface SendMessageReply {
  message: { type: string; content: string; id: string };
  sessionId: string;
}

/**
 * Public entry point for the chat HTTP surface. Owns:
 *
 *   - the AbortController registry (one in-flight stream per session)
 *   - the cross-cutting "Matrix replay of the user's text" fire-and-forget
 *   - delegation to `RequestPreparer` → (`SseStreamRunner` |
 *     `BatchInvoker`) → `PostMessageSyncer`
 *
 * The Matrix listener bridge calls back into `sendMessage({ clientType:
 * 'matrix' })` for the matrix-room ingress path. That keeps the chat code
 * path linear: every request, regardless of source, lands here.
 */
@Injectable()
export class MessagesService implements OnModuleInit {
  private readonly logger = new Logger(MessagesService.name);
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly preparer: RequestPreparer,
    private readonly streamer: SseStreamRunner,
    private readonly batchInvoker: BatchInvoker,
    private readonly fileProcessing: FileProcessingService,
    private readonly checkpointSync: UserMatrixSqliteSyncService,
    private readonly postSync: PostMessageSyncer,
    private readonly matrixBridge: MatrixListenerBridge,
    private readonly sessions: SessionManagerService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.matrixBridge.setDeliverHandler((msg) =>
      this.sendMessage({
        clientType: 'matrix',
        message: msg.message,
        did: msg.did,
        sessionId: msg.threadId,
        overrideLangchainThreadId: msg.langchainThreadId,
        homeServer: msg.homeServer,
        msgFromMatrixRoom: true,
        ...(msg.attachments && { attachments: msg.attachments }),
      }),
    );
  }

  abortRequest(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.abortControllers.delete(sessionId);
    return true;
  }

  async listMessages(
    params: ListMessagesDto & { did: string; homeServer?: string },
  ): Promise<ListOracleMessagesResponse> {
    const { did, sessionId } = params;
    this.preparer.validateSessionId(sessionId, did);

    this.checkpointSync.markUserActive(did);
    try {
      const db = await this.checkpointSync.getUserDatabase(did);
      const saver = SqliteSaver.fromDatabase(db);
      const tuple = await saver.getTuple({
        configurable: { thread_id: sessionId },
      });
      const messages =
        (tuple?.checkpoint?.channel_values?.messages as
          | BaseMessage[]
          | undefined) ?? [];
      return transformGraphStateMessageToListMessageResponse(messages);
    } finally {
      this.checkpointSync.markUserInactive(did);
    }
  }

  async sendMessage(
    params: SendMessageRequest,
  ): Promise<SendMessageReply | undefined> {
    this.checkpointSync.markUserActive(params.did);

    try {
      const prepared = await this.preparer.prepare(params);
      const inputMessages = await this.assembleInput(params, prepared);
      const msgFromMatrixRoom = params.msgFromMatrixRoom ?? false;

      if (!msgFromMatrixRoom) {
        this.sessions.matrixManger
          .sendMessage({
            message: params.message,
            roomId: prepared.roomId,
            threadId: prepared.sessionId,
            isOracleAdmin: false,
          })
          .catch((err) =>
            this.logger.error('Matrix replay (user message) failed', err),
          );
      }

      if (params.stream && params.res) {
        await this.streamer.run({
          payload: { ...params },
          prepared,
          inputMessages,
          res: params.res,
          abortControllers: this.abortControllers,
          onComplete: (assistantText) => {
            if (!msgFromMatrixRoom && assistantText) {
              this.sessions.matrixManger
                .sendMessage({
                  message: assistantText,
                  roomId: prepared.roomId,
                  threadId: prepared.sessionId,
                  isOracleAdmin: true,
                })
                .catch((err) =>
                  this.logger.error('Matrix replay (AI response) failed', err),
                );
            }
            this.firePostSync(params, prepared);
          },
        });
        return undefined;
      }

      const result = await this.batchInvoker.invoke({
        payload: { ...params },
        prepared,
        inputMessages,
      });

      if (!msgFromMatrixRoom) {
        this.sessions.matrixManger
          .sendMessage({
            message: result.message.content,
            roomId: prepared.roomId,
            threadId: prepared.sessionId,
            isOracleAdmin: true,
          })
          .catch((err) =>
            this.logger.error('Matrix replay (AI response) failed', err),
          );
      }
      this.firePostSync(params, prepared);
      return result;
    } finally {
      this.checkpointSync.markUserInactive(params.did);
    }
  }

  private async assembleInput(
    params: SendMessageRequest,
    prepared: { roomId: string; sessionId: string },
  ): Promise<BaseMessage[]> {
    const msgFromMatrixRoom = params.msgFromMatrixRoom ?? false;
    const timestamp = new Date().toISOString();
    const out: BaseMessage[] = [
      new HumanMessage({
        content: params.message,
        additional_kwargs: { msgFromMatrixRoom, timestamp },
      }),
    ];

    if (!params.attachments?.length) return out;

    this.logger.log(
      `sendMessage: ${params.attachments.length} attachment(s) for session ${prepared.sessionId}`,
    );
    const { texts, metadata } = await this.fileProcessing.processAttachments(
      params.attachments,
      prepared.roomId,
      params.did,
    );

    texts.forEach((text, i) => {
      const meta = metadata[i];
      if (!meta) return;
      const sourceRef = meta.eventId
        ? `[source: eventId="${meta.eventId}"]`
        : meta.mxcUri
          ? `[source: url="${meta.mxcUri}"]`
          : '';
      const content = sourceRef ? `${sourceRef}\n${text}` : text;
      out.push(
        new AIMessage({
          content,
          additional_kwargs: {
            msgFromMatrixRoom,
            timestamp: new Date().toISOString(),
            attachment: meta,
          },
        }),
      );
    });
    return out;
  }

  private firePostSync(
    params: SendMessageRequest,
    prepared: {
      sessionId: string;
      langchainThreadId: string;
      roomId: string;
      targetSession: import('@ixo/common').ChatSession;
    },
  ): void {
    // Keep the user active for the duration of the fire-and-forget sync —
    // the matching markUserInactive lives in PostMessageSyncer.
    this.checkpointSync.markUserActive(params.did);
    this.postSync.run({
      did: params.did,
      sessionId: prepared.sessionId,
      langchainThreadId: prepared.langchainThreadId,
      roomId: prepared.roomId,
      targetSession: prepared.targetSession,
    });
  }
}
