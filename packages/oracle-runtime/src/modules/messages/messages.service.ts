import {
  ChatSession,
  SessionManagerService,
  transformGraphStateMessageToListMessageResponse,
  type ListOracleMessagesResponse,
} from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { SqliteSaver } from '@ixo/sqlite-saver';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AIMessage, HumanMessage, type BaseMessage } from 'langchain';

import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { postAgentReplyToMatrix } from '../../matrix/outbound-reply.js';
import { BatchInvoker } from './batch-invoker.js';
import { type ListMessagesDto } from './dto/list-messages.dto.js';
import {
  type SendMessagePayload,
  type SendMessageResponse,
} from './dto/send-message.dto.js';
import { FileProcessingService } from './file-processing.service.js';
import { MatrixListenerBridge } from './matrix-listener-bridge.js';
import { PostMessageSyncer } from './post-message-syncer.js';
import { RequestPreparer } from './request-preparer.js';
import { SseStreamRunner } from './sse-stream-runner.js';
import { isSyntheticSessionId } from './synthetic-session.js';

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
   * Throwaway-session callers (e.g. the tasks plugin's `AgentInvoker`, which
   * creates a synthetic session, runs one turn, then deletes it) set this so
   * the fire-and-forget post-message sync does NOT persist the session row.
   * Without it, the sync races the caller's own `deleteSession` and
   * re-inserts the synthetic session as an orphan in the user's main room —
   * which then poisons the session list and makes later Matrix thread-relay
   * sends fail with `M_UNKNOWN: Can't send relation to unknown event`.
   */
  skipPostSync?: boolean;
  /**
   * Authenticated UCAN delegation from `req.authData.ucanDelegation`.
   * Threaded through to `requestCtx.user.ucanDelegation` so plugins can
   * mint downstream invocations from the raw header. Absent on the Matrix
   * listener path — the bot acts as the oracle, not as a user.
   */
  ucanDelegation?: AuthUcanDelegation;
  // ── Matrix-listener path metadata ──────────────────────────────────────
  /** Sender's full Matrix user id (e.g. `@alice:matrix.example`). */
  senderMatrixUserId?: string;
  /** Matrix event id of the latest text event the user sent. */
  matrixEventId?: string;
  /** Raw `m.mentions` payload from the Matrix event, used by group-chat gating. */
  matrixMentions?: { user_ids?: string[] };
  /** Raw `m.relates_to` payload, used to detect reply-to-bot. */
  matrixRelatesTo?: { 'm.in_reply_to'?: { event_id: string } };
  /** Room id (mirrors the bridge call) — used for display-name + roomInfo lookups. */
  matrixRoomId?: string;
}

type SendMessageReply = SendMessageResponse;

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
        senderMatrixUserId: msg.senderMatrixUserId,
        matrixEventId: msg.eventId,
        matrixMentions: msg.mentions,
        matrixRelatesTo: msg.relatesTo,
        matrixRoomId: msg.roomId,
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
      // A synthetic (background-task) session id is not a real Matrix event:
      // using it as a thread-relation target 400s, and post-sync would try to
      // edit the nonexistent root event for the title. Replays post top-level
      // and the session sync is skipped — see synthetic-session.ts.
      const synthetic = isSyntheticSessionId(prepared.sessionId);
      const replayThreadId = synthetic ? undefined : prepared.sessionId;
      const skipPostSync = params.skipPostSync || synthetic;

      if (!msgFromMatrixRoom) {
        this.sessions.matrixManger
          .sendMessage({
            message: params.message,
            roomId: prepared.roomId,
            threadId: replayThreadId,
            isOracleAdmin: false,
          })
          .catch((err) =>
            this.logger.error(
              `Matrix replay (user message) failed — roomId=${prepared.roomId} threadId=${prepared.sessionId}`,
              err,
            ),
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
              postAgentReplyToMatrix({
                matrixManager: this.sessions.matrixManger,
                content: assistantText,
                roomId: prepared.roomId,
                threadId: replayThreadId,
                disablePrefix: false,
              }).catch((err) =>
                this.logger.error(
                  `Matrix replay (AI response) failed — roomId=${prepared.roomId} threadId=${prepared.sessionId}`,
                  err,
                ),
              );
            }
            if (!skipPostSync) this.firePostSync(params, prepared);
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
        postAgentReplyToMatrix({
          matrixManager: this.sessions.matrixManger,
          content: result.message.content,
          roomId: prepared.roomId,
          threadId: replayThreadId,
          disablePrefix: false,
        }).catch((err) =>
          this.logger.error(
            `Matrix replay (AI response) failed — roomId=${prepared.roomId} threadId=${prepared.sessionId}`,
            err,
          ),
        );
      }
      if (!skipPostSync) this.firePostSync(params, prepared);
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

    const { content, additionalKwargs } = await this.buildHumanMessageParts(
      params,
      prepared,
      msgFromMatrixRoom,
      timestamp,
    );

    const out: BaseMessage[] = [
      new HumanMessage({
        content,
        additional_kwargs: additionalKwargs,
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

  /**
   * Build the `content` and `additional_kwargs` for the HumanMessage that
   * lands in graph state. For Matrix-originated turns this is where we:
   *   - resolve the speaker's display name (via the existing 30-min cache
   *     on `MatrixManager.getCachedDisplayName`)
   *   - decide whether the room is a group (memberCount > 2) and prefix
   *     the content with `[DisplayName]: ` if so — so the agent reads who
   *     is speaking without any middleware mutating state mid-graph
   *   - stash speaker + threading metadata + raw `m.mentions` /
   *     `m.relates_to` on `additional_kwargs` for downstream consumers
   *     (the group-chat gating middleware reads them)
   *
   * Non-Matrix turns (portal, slack) keep the prior behaviour: just
   * `msgFromMatrixRoom` + `timestamp`.
   */
  private async buildHumanMessageParts(
    params: SendMessageRequest,
    prepared: { roomId: string; sessionId: string },
    msgFromMatrixRoom: boolean,
    timestamp: string,
  ): Promise<{ content: string; additionalKwargs: Record<string, unknown> }> {
    const baseKwargs: Record<string, unknown> = {
      msgFromMatrixRoom,
      timestamp,
    };

    if (!msgFromMatrixRoom || !params.senderMatrixUserId) {
      return { content: params.message, additionalKwargs: baseKwargs };
    }

    const roomId = params.matrixRoomId ?? prepared.roomId;
    const matrixManager = MatrixManager.getInstance();

    const [displayName, roomInfo] = await Promise.all([
      matrixManager
        .getCachedDisplayName(params.senderMatrixUserId, roomId)
        .catch((err) => {
          this.logger.warn(
            `getCachedDisplayName failed for ${params.senderMatrixUserId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return params.senderMatrixUserId;
        }),
      matrixManager.getRoomInfo(roomId).catch((err) => {
        this.logger.warn(
          `getRoomInfo failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }),
    ]);

    const isGroupRoom =
      !!roomInfo && !roomInfo.isDirect && roomInfo.memberCount > 2;

    const prefix = `[${displayName}]: `;
    const content =
      isGroupRoom && !params.message.startsWith(prefix)
        ? `${prefix}${params.message}`
        : params.message;

    const additionalKwargs: Record<string, unknown> = {
      ...baseKwargs,
      senderDid: params.did,
      senderMatrixUserId: params.senderMatrixUserId,
      senderDisplayName: displayName,
      threadId: prepared.sessionId,
    };
    if (params.matrixEventId) additionalKwargs.eventId = params.matrixEventId;
    if (params.matrixMentions)
      additionalKwargs['m.mentions'] = params.matrixMentions;
    if (params.matrixRelatesTo)
      additionalKwargs['m.relates_to'] = params.matrixRelatesTo;

    return { content, additionalKwargs };
  }

  private firePostSync(
    params: SendMessageRequest,
    prepared: {
      sessionId: string;
      langchainThreadId: string;
      roomId: string;
      targetSession: ChatSession;
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
