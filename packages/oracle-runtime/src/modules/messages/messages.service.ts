import {
  ChatSession,
  SessionManagerService,
  transformGraphStateMessageToListMessageResponse,
  type ListOracleMessagesResponse,
} from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { ReasoningEvent } from '@ixo/oracles-events';
import { SqliteSaver } from '@ixo/sqlite-saver';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CommerceContext } from '../../plugin-api/types.js';
import type { Request, Response } from 'express';
import { AIMessage, HumanMessage, type BaseMessage } from 'langchain';
import * as crypto from 'node:crypto';

import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { BatchInvoker } from './batch-invoker.js';
import { type ListMessagesDto } from './dto/list-messages.dto.js';
import {
  type AttachmentDto,
  type SendMessagePayload,
  type SendMessageResponse,
} from './dto/send-message.dto.js';
import {
  getDefaultModelId,
  getModelCapabilities,
  isAllowedModel,
} from '../../llm/index.js';
import { classifyAttachment } from './attachments/classify.js';
import {
  buildUserMessageContent,
  type NativeAttachment,
} from './attachments/content-blocks.js';
import { routeAttachment } from './attachments/route.js';
import { FileProcessingService } from './file-processing.service.js';
import {
  MatrixListenerBridge,
  type MatrixRelatesTo,
} from './matrix-listener-bridge.js';
import { PostMessageSyncer } from './post-message-syncer.js';
import { RequestPreparer } from './request-preparer.js';
import { SseStreamRunner } from './sse-stream-runner.js';
import {
  formatSSE,
  pickThinkingPhrase,
  sendSSEDone,
  sendSSEError,
  setSSEHeaders,
} from './sse.utils.js';
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
  /**
   * Per-turn abort controller from the Matrix listener bridge. Its signal is
   * threaded into the LangGraph invoke config (and so into
   * `RuntimeContext.abortSignal`) so aborting it cancels the graph run —
   * mirroring the per-turn controller the SSE path constructs itself.
   */
  abortController?: AbortController;
  /** Sender's full Matrix user id (e.g. `@alice:matrix.example`). */
  senderMatrixUserId?: string;
  /** Matrix event id of the latest text event the user sent. */
  matrixEventId?: string;
  /** Raw `m.mentions` payload from the Matrix event, used by group-chat gating. */
  matrixMentions?: { user_ids?: string[] };
  /** Raw `m.relates_to` payload, used to detect reply-to-bot. */
  matrixRelatesTo?: MatrixRelatesTo;
  /** Room id (mirrors the bridge call) — used for display-name + roomInfo lookups. */
  matrixRoomId?: string;
  /**
   * Commerce routing outcome from the Matrix message router (support vs work
   * persona, engagement, gate failure, cancellation). Threaded through the
   * agent build into `RuntimeContext.commerce`. Absent on HTTP turns and on
   * Matrix turns where the router is inert.
   */
  commerce?: CommerceContext;
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
        abortController: msg.abortController,
        // The bridge's per-turn id keeps the work_status card, the runnable
        // config, and ctx.session.requestId in agreement.
        requestId: msg.requestId,
        senderMatrixUserId: msg.senderMatrixUserId,
        matrixEventId: msg.eventId,
        matrixMentions: msg.mentions,
        matrixRelatesTo: msg.relatesTo,
        matrixRoomId: msg.roomId,
        ...(msg.commerce && { commerce: msg.commerce }),
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

    // Streaming: open the SSE connection BEFORE any pre-flight work (session
    // lookup, attachment processing, agent build) so the client gets headers
    // + an instant "Thinking..." ack in milliseconds instead of seconds. The
    // requestId is resolvable up front — the SDK sends one, and we mint a
    // UUID otherwise — so `X-Request-Id` still goes out on the headers.
    // `RequestPreparer` reuses `params.requestId`, keeping the header and
    // the runnableConfig in agreement.
    const streaming = Boolean(params.stream && params.res);
    if (streaming && params.res) {
      params.requestId =
        typeof params.requestId === 'string' && params.requestId.length > 0
          ? params.requestId
          : crypto.randomUUID();
      this.openStream(params.res, params.sessionId, params.requestId);
    }

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
              this.sessions.matrixManger
                .sendMessage({
                  message: assistantText,
                  roomId: prepared.roomId,
                  threadId: replayThreadId,
                  isOracleAdmin: true,
                })
                .catch((err) =>
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
        abortController: params.abortController,
      });

      if (!msgFromMatrixRoom) {
        this.sessions.matrixManger
          .sendMessage({
            message: result.message.content,
            roomId: prepared.roomId,
            threadId: replayThreadId,
            isOracleAdmin: true,
          })
          .catch((err) =>
            this.logger.error(
              `Matrix replay (AI response) failed — roomId=${prepared.roomId} threadId=${prepared.sessionId}`,
              err,
            ),
          );
      }
      if (!skipPostSync) this.firePostSync(params, prepared);
      return result;
    } catch (error) {
      // Once the SSE headers have flushed, an HTTP error status can no
      // longer reach the client — pre-flight failures (session not found,
      // attachment load, agent build) must go out as SSE `error` events on
      // the open stream instead of propagating to the controller.
      if (streaming && params.res && params.res.headersSent) {
        this.logger.error(
          `Pre-flight failed after SSE flush — session=${params.sessionId}`,
          error instanceof Error ? error.stack : String(error),
        );
        sendSSEError(
          params.res,
          error instanceof Error ? error : 'Something went wrong',
        );
        sendSSEDone(params.res);
        if (!params.res.writableEnded) params.res.end();
        return undefined;
      }
      throw error;
    } finally {
      this.checkpointSync.markUserInactive(params.did);
    }
  }

  /**
   * Flush SSE headers and the instant "Thinking..." ack. Runs before ANY
   * pre-flight work so the perceived time-to-first-byte is the network
   * round-trip, not the pre-flight latency. Stage-specific progress (e.g.
   * "Recalling your memories...") is emitted later by the components that
   * actually know a slow stage is running.
   */
  private openStream(
    res: Response,
    sessionId: string,
    requestId: string,
  ): void {
    if (res.headersSent) return;
    setSSEHeaders(res, requestId);
    res.flushHeaders();
    const thinkingText = pickThinkingPhrase();
    const thinkingEvent = ReasoningEvent.createChunk(
      sessionId,
      requestId,
      thinkingText,
      [{ type: 'thinking', text: thinkingText }],
      false,
    );
    res.write(formatSSE(thinkingEvent.eventName, thinkingEvent.payload));
    thinkingEvent.emit();
  }

  private async assembleInput(
    params: SendMessageRequest,
    prepared: { roomId: string; sessionId: string },
  ): Promise<BaseMessage[]> {
    const msgFromMatrixRoom = params.msgFromMatrixRoom ?? false;
    const timestamp = new Date().toISOString();

    const { content: baseText, additionalKwargs } =
      await this.buildHumanMessageParts(
        params,
        prepared,
        msgFromMatrixRoom,
        timestamp,
      );

    if (!params.attachments?.length) {
      return [
        new HumanMessage({
          content: baseText,
          additional_kwargs: additionalKwargs,
        }),
      ];
    }

    // Route each attachment by the selected model's native capabilities. The
    // effective model here MUST match what the agent resolves (agent-builder
    // validates the same way), so a supported model receives its images/files
    // directly instead of the helper model turning them into text.
    const effectiveModel = isAllowedModel(params.model)
      ? params.model
      : getDefaultModelId();
    const caps = getModelCapabilities(effectiveModel);

    const nativeAttachments: AttachmentDto[] = [];
    const extractAttachments: AttachmentDto[] = [];
    for (const attachment of params.attachments) {
      const kind = classifyAttachment({
        mimetype: attachment.mimetype,
        filename: attachment.filename,
      });
      const strategy = routeAttachment(kind, caps);
      this.logger.log(
        `[attachments] "${attachment.filename}" (${attachment.mimetype}) kind=${kind} model=${effectiveModel} → ${strategy}`,
      );
      if (strategy === 'send-native') nativeAttachments.push(attachment);
      else extractAttachments.push(attachment);
    }

    // Download + base64 the native attachments. On any failure, fall that one
    // file back to extraction so a bad download never drops the whole message.
    const natives: NativeAttachment[] = [];
    for (const attachment of nativeAttachments) {
      try {
        const { buffer, mimetype } =
          await this.fileProcessing.loadAttachmentBytes(
            attachment,
            prepared.roomId,
          );
        const kind = classifyAttachment({
          mimetype,
          filename: attachment.filename,
        });
        natives.push({
          kind: kind === 'image' ? 'image' : 'file',
          mimeType: mimetype,
          base64: buffer.toString('base64'),
          filename: attachment.filename,
        });
        this.logger.log(
          `[attachments] NATIVE → "${attachment.filename}" sent directly to ${effectiveModel} (${buffer.length} bytes, ${kind}); skipping helper-model extraction`,
        );
        // Archive the original to the sandbox off the hot path — the agent's
        // file-processing tools can still reach it later, without delaying
        // this request.
        this.fileProcessing.archiveAttachmentInBackground(
          attachment,
          buffer,
          params.did,
        );
      } catch (error) {
        this.logger.warn(
          `[attachments] native load failed for "${attachment.filename}", falling back to extraction: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        extractAttachments.push(attachment);
      }
    }

    // Surface EVERY attachment's metadata on the human message — the
    // list-messages transform reads these off human messages, so the client
    // can render the file/image chips after a refetch. Built from the request
    // payload (not the routing outcome): the user attached these files to
    // THIS message regardless of whether the model consumed them natively or
    // via text extraction. `attachment` (first entry) is kept for older
    // clients that only read the singular field.
    const attachmentMetas = params.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimetype: attachment.mimetype,
      size: attachment.size,
      mxcUri: attachment.mxcUri,
      eventId: attachment.eventId,
      category: classifyAttachment({
        mimetype: attachment.mimetype,
        filename: attachment.filename,
      }),
    }));
    const humanKwargs = {
      ...additionalKwargs,
      attachment: attachmentMetas[0],
      attachments: attachmentMetas,
    };

    const out: BaseMessage[] = [
      new HumanMessage({
        content: buildUserMessageContent(baseText, natives),
        additional_kwargs: humanKwargs,
      }),
    ];

    // Everything not sent natively (plain text, and anything a text-only model
    // can't read) is turned into text by the existing pipeline and appended.
    if (extractAttachments.length > 0) {
      this.logger.log(
        `[attachments] EXTRACT ${extractAttachments.length} attachment(s) via file-processing pipeline (local parse for text, helper model otherwise) for session ${prepared.sessionId}`,
      );
      const { texts, metadata } = await this.fileProcessing.processAttachments(
        extractAttachments,
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
    }

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
