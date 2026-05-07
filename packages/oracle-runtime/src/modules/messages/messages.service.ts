import {
  ChatSession,
  SessionManagerService,
  transformGraphStateMessageToListMessageResponse,
  type ListOracleMessagesResponse,
} from '@ixo/common';
import {
  type IRunnableConfigWithRequiredFields,
  type MatrixManager,
  type MessageEvent,
  type MessageEventContent,
} from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import {
  ActionCallEvent,
  ReasoningEvent,
  ToolCallEvent,
} from '@ixo/oracles-events';
import { SqliteSaver } from '@ixo/sqlite-saver';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
  ToolMessage,
} from 'langchain';
import { emojify } from 'node-emoji';
import * as crypto from 'node:crypto';

import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { type ListMessagesDto } from './dto/list-messages.dto.js';
import { type SendMessagePayload } from './dto/send-message.dto.js';
import { FileProcessingService } from './file-processing.service.js';
import {
  ApprovalService,
  MainAgentGraph,
  TasksService,
  TokenLimiter,
  classifyApprovalResponse,
  isRedisEnabled,
  type ApprovalClassification,
  type UserContextData,
} from './forward-refs.js';
import {
  emitSSEEvent,
  formatSSE,
  runWithSSEContext,
  sendSSEDone,
  sendSSEError,
  setSSEHeaders,
  startSSEHeartbeat,
} from './sse.utils.js';
import { UcanService } from '../ucan/ucan.service.js';

/**
 * Convert a hyphen-delimited Matrix DID (`@did-ixo-…:server`) to the
 * canonical colon-delimited form (`did:ixo:…`).
 */
function normalizeDid(input: string): string {
  const username = input.split(':')[0] ?? '';
  const parts = username.split('-');
  if (parts.length < 3 || parts[0] !== '@did') {
    throw new Error(`Invalid DID format: ${input}`);
  }
  const namespace = parts[1];
  const identifier = parts.slice(2).join('-');
  return `did:${namespace}:${identifier}`;
}

interface AttachmentMeta {
  filename?: string;
  mimetype?: string;
  size?: number;
  mxcUri?: string;
  eventId?: string;
}

interface CleanAdditionalKwargs {
  msgFromMatrixRoom: boolean;
  timestamp: string;
  oracleName: string;
  attachment?: AttachmentMeta;
  reasoning?: string;
  reasoningDetails?: Array<{ type: string; text: string }>;
}

/**
 * Strip noisy provider-specific fields from a chunk's `additional_kwargs`,
 * preserving only what's needed downstream — including the optional
 * reasoning trace shape used by GPT-OSS-style models.
 */
function cleanAdditionalKwargs(
  additionalKwargs: Record<string, unknown>,
  msgFromMatrixRoom: boolean,
): CleanAdditionalKwargs {
  const rawResponse = additionalKwargs.__raw_response as
    | {
        choices?: Array<{
          delta?: {
            reasoning?: string;
            reasoning_content?: string | null;
            reasoning_details?: unknown;
          };
        }>;
      }
    | undefined;

  const delta = rawResponse?.choices?.[0]?.delta;
  const reasoning = delta?.reasoning ?? delta?.reasoning_content;
  const reasoningDetails = reasoning ? delta?.reasoning_details : undefined;

  const cleanedKwargs: CleanAdditionalKwargs = {
    msgFromMatrixRoom,
    timestamp: new Date().toISOString(),
    oracleName: process.env.ORACLE_NAME || 'IXO Oracle',
    ...(additionalKwargs.attachment
      ? { attachment: additionalKwargs.attachment as AttachmentMeta }
      : {}),
  };

  if (reasoning) {
    cleanedKwargs.reasoning = reasoning;
  }
  if (
    reasoningDetails &&
    Array.isArray(reasoningDetails) &&
    reasoningDetails.length > 0
  ) {
    cleanedKwargs.reasoningDetails = reasoningDetails
      .filter(
        (
          detail,
        ): detail is { type: string; text: string } =>
          detail &&
          typeof detail === 'object' &&
          typeof (detail as { type?: unknown }).type === 'string' &&
          typeof (detail as { text?: unknown }).text === 'string' &&
          ((detail as { text: string }).text.trim().length > 0),
      )
      .map((detail) => ({
        type: detail.type,
        text: detail.text,
      }));
  }

  return cleanedKwargs;
}

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private cleanUpMatrixListener?: () => void;
  private threadRootCache = new Map<string, string>(); // eventId → rootEventId
  private abortControllers = new Map<string, AbortController>(); // sessionId → AbortController
  private readonly oracleMatrixBaseUrl: string;

  /**
   * Per-thread debounce buffer for Matrix events. When a user sends text +
   * file, Matrix delivers them as separate events; we batch events arriving
   * within MATRIX_DEBOUNCE_MS into a single sendMessage() call.
   */
  private matrixEventBuffer = new Map<
    string,
    {
      events: Array<{
        event: MessageEvent<MessageEventContent>;
        roomId: string;
      }>;
      timer: NodeJS.Timeout;
    }
  >();

  private readonly MATRIX_DEBOUNCE_MS = 500;

  matrixManager: MatrixManager;

  constructor(
    private readonly mainAgent: MainAgentGraph,
    private readonly sessionManagerService: SessionManagerService,
    private readonly config: ConfigService,
    private readonly checkpointStorageSyncService: UserMatrixSqliteSyncService,
    private readonly fileProcessingService: FileProcessingService,
    @Optional() private readonly tasksService?: TasksService,
    @Optional() private readonly approvalService?: ApprovalService,
    @Optional() private readonly ucanService?: UcanService,
  ) {
    this.matrixManager = this.sessionManagerService.matrixManger;
    this.oracleMatrixBaseUrl = this.config
      .getOrThrow<string>('MATRIX_BASE_URL')
      .replace(/\/$/, '');
  }

  public onModuleDestroy(): void {
    for (const [, entry] of this.matrixEventBuffer) {
      clearTimeout(entry.timer);
    }
    this.matrixEventBuffer.clear();

    if (this.cleanUpMatrixListener) {
      this.cleanUpMatrixListener();
    }
  }

  private async getThreadRoot(
    event: MessageEvent<
      MessageEventContent & {
        'm.relates_to'?: {
          'm.in_reply_to'?: {
            event_id: string;
          };
        };
      }
    >,
    roomId: string,
  ): Promise<string | undefined> {
    const eventId = event.eventId;
    if (!eventId) {
      return undefined;
    }
    const inReplyTo =
      event.content['m.relates_to']?.['m.in_reply_to']?.event_id;

    if (!inReplyTo) {
      // This event IS the root.
      this.threadRootCache.set(eventId, eventId);
      return eventId;
    }

    if (this.threadRootCache.has(inReplyTo)) {
      const rootEventId = this.threadRootCache.get(inReplyTo);
      if (!rootEventId) {
        return undefined;
      }
      this.threadRootCache.set(eventId, rootEventId);
      return rootEventId;
    }

    // Walk up the chain.
    const pathToCache: string[] = [eventId];
    let currentEventId = inReplyTo;
    const visited = new Set<string>();

    while (currentEventId && !visited.has(currentEventId)) {
      visited.add(currentEventId);
      pathToCache.push(currentEventId);

      if (this.threadRootCache.has(currentEventId)) {
        const rootEventId = this.threadRootCache.get(currentEventId);
        if (!rootEventId) {
          return undefined;
        }
        pathToCache.forEach((id) => this.threadRootCache.set(id, rootEventId));
        return rootEventId;
      }

      const parentEvent = await this.matrixManager.getEventById<{
        'm.relates_to'?: {
          'm.in_reply_to'?: {
            event_id: string;
          };
        };
      }>(roomId, currentEventId);

      const parentInReplyTo =
        parentEvent.content['m.relates_to']?.['m.in_reply_to']?.event_id;
      if (!parentInReplyTo) {
        // Found the root.
        pathToCache.forEach((id) => {
          this.threadRootCache.set(id, currentEventId);
        });
        return currentEventId;
      }

      currentEventId = parentInReplyTo;
    }

    // Fallback
    const fallbackRoot = currentEventId || eventId;
    pathToCache.forEach((id) => this.threadRootCache.set(id, fallbackRoot));
    return fallbackRoot;
  }

  /** Supported Matrix file message types. */
  private static readonly FILE_MSGTYPES = new Set([
    'm.file',
    'm.image',
    'm.video',
    'm.audio',
  ]);

  private async handleMessage(
    event: MessageEvent<MessageEventContent>,
    roomId: string,
  ): Promise<void> {
    const did = normalizeDid(event.sender);
    const isBot = did === this.config.getOrThrow('ORACLE_DID');
    if (isBot) {
      Logger.log(
        `[Matrix][handleMessage] Ignoring message from bot (DID: ${did})`,
      );
      return;
    }

    if ('INTERNAL' in event.content) {
      Logger.log(
        `[Matrix][handleMessage] Ignoring INTERNAL message eventId=${event.eventId} sender=${event.sender}`,
      );
      return;
    }

    const msgtype = event.content.msgtype;
    const isText =
      msgtype === 'm.text' &&
      'body' in event.content &&
      typeof event.content.body === 'string';
    const isFile =
      typeof msgtype === 'string' && MessagesService.FILE_MSGTYPES.has(msgtype);
    const threadId = await this.getThreadRoot(event, roomId);
    if (!threadId) {
      Logger.warn(
        `[Matrix][handleMessage] Could not find thread root for eventId=${event.eventId} roomId=${roomId}, aborting`,
      );
      return;
    }

    const threadEv = await this.matrixManager.getEventById(roomId, threadId);
    const langchainThreadId = (threadEv.content as { sessionId?: string })
      ?.sessionId;
    const sessionId = threadId;
    if (!isText && !isFile) {
      Logger.log(
        `[Matrix][handleMessage] Ignoring non-text, non-file message: eventId=${event.eventId} msgtype=${msgtype} sender=${event.sender}`,
      );
      return;
    }

    // ── Approval gate interception ────────────────────────────────
    if (isText && this.approvalService) {
      const body = 'body' in event.content ? String(event.content.body) : '';
      const classification = await this.tryHandleApprovalResponse(
        body,
        did,
        roomId,
      );
      if (classification) {
        Logger.log(
          `[Matrix][handleMessage] Handled as approval response (${classification.decision}), skipping normal flow`,
        );
        return;
      }
    }

    Logger.log(
      `[Matrix][handleMessage] Processing message eventId=${event.eventId} roomId=${roomId} threadId=${threadId} sender=${event.sender} sessionId=${sessionId ?? event.eventId}`,
    );

    const checkSessionId = sessionId ?? event.eventId;
    let hasSession: ChatSession | undefined;
    try {
      hasSession = await this.sessionManagerService.getSession(
        checkSessionId,
        did,
        false,
      );
    } catch (err) {
      Logger.error(
        `[Matrix][handleMessage] Error checking for session did=${did} sessionId=${checkSessionId}`,
        err,
      );
    }

    if (!hasSession) {
      const userHomeServer = event.sender.split(':').slice(1).join(':');
      const oracleHomeServer = this.config
        .getOrThrow<string>('MATRIX_BASE_URL')
        .replace(/\/$/, '')
        .replace(/^https?:\/\//, '');

      try {
        Logger.log(
          `[Matrix][handleMessage] Creating NEW session for did=${did} sessionId=${checkSessionId} homeServer=${userHomeServer} oracleHomeServer=${oracleHomeServer}`,
        );
        await this.sessionManagerService.createSession(
          {
            did,
            oracleDid: this.config.getOrThrow('ORACLE_DID'),
            oracleEntityDid: this.config.getOrThrow('ORACLE_ENTITY_DID'),
            oracleName: this.config.getOrThrow('ORACLE_NAME'),
            homeServer: userHomeServer,
            oracleHomeServer,
            userHomeServer,
            roomId, // store the actual room (may be a task room, not main room)
          },
          event.eventId,
        );
      } catch (err) {
        Logger.error(
          `[Matrix][handleMessage] Error creating session for did=${did} sessionId=${checkSessionId}`,
          err,
        );
        return;
      }
    }

    // Buffer the event — the debounce timer will flush once no more arrive.
    const existing = this.matrixEventBuffer.get(threadId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push({ event, roomId });
    } else {
      this.matrixEventBuffer.set(threadId, {
        events: [{ event, roomId }],
        timer: null as unknown as NodeJS.Timeout,
      });
    }

    const entry = this.matrixEventBuffer.get(threadId)!;
    entry.timer = setTimeout(() => {
      this.flushMatrixEvents(threadId, langchainThreadId).catch((err) => {
        Logger.error(
          `Failed to flush Matrix events for thread ${threadId}`,
          err,
        );
      });
    }, this.MATRIX_DEBOUNCE_MS);
  }

  /**
   * Flush buffered Matrix events for a thread into a single sendMessage()
   * call — separates text from file attachments and batches them.
   */
  private async flushMatrixEvents(
    threadId: string,
    overRideSessionId?: string,
  ): Promise<void> {
    const entry = this.matrixEventBuffer.get(threadId);
    if (!entry) {
      Logger.warn(
        `[Matrix][flushMatrixEvents] No event buffer for threadId=${threadId}`,
      );
      return;
    }
    this.matrixEventBuffer.delete(threadId);

    const { events } = entry;
    const firstEvent = events[0];
    if (!firstEvent) {
      return;
    }

    const roomId = firstEvent.roomId;
    const did = normalizeDid(firstEvent.event.sender);
    const homeServer = firstEvent.event.sender.split(':')[1];

    let textBody: string | undefined;
    const attachments: Array<{
      eventId: string;
      filename: string;
      mimetype: string;
      size?: number;
    }> = [];

    for (const { event } of events) {
      const msgtype = event.content.msgtype;

      if (
        msgtype === 'm.text' &&
        'body' in event.content &&
        typeof event.content.body === 'string'
      ) {
        textBody = event.content.body;
      } else if (
        typeof msgtype === 'string' &&
        MessagesService.FILE_MSGTYPES.has(msgtype)
      ) {
        attachments.push(this.buildAttachmentFromEvent(event));
      }
    }

    const message =
      textBody ??
      (attachments.length === 1
        ? `User shared a file: ${attachments[0]?.filename ?? 'file'}`
        : `User shared ${attachments.length} file(s): ${attachments.map((a) => a.filename).join(', ')}`);

    try {
      const aiMessage = await this.sendMessage({
        clientType: 'matrix',
        message,
        did,
        sessionId: threadId,
        overrideLangchainThreadId: overRideSessionId,
        homeServer,
        msgFromMatrixRoom: true,

        ...(attachments.length > 0 && { attachments }),
      });
      if (!aiMessage) {
        Logger.warn(
          `[Matrix][flushMatrixEvents] sendMessage did not return a message for threadId=${threadId}`,
        );
        return;
      }

      await this.sessionManagerService.matrixManger.sendMessage({
        message: aiMessage.message.content,
        roomId,
        threadId,
        isOracleAdmin: true,
        disablePrefix: true,
      });
    } catch (error) {
      Logger.error('Failed to send message', error);
    }
  }

  /**
   * Build an AttachmentDto-compatible object from a Matrix file event.
   * Uses eventId (not mxcUri) because downloadFromMatrixEvent handles both
   * encrypted and unencrypted files transparently.
   */
  private buildAttachmentFromEvent(event: MessageEvent<MessageEventContent>): {
    eventId: string;
    filename: string;
    mimetype: string;
    size?: number;
  } {
    const content = event.content as unknown as Record<string, unknown>;
    const info = content.info as
      | { mimetype?: string; size?: number }
      | undefined;
    return {
      eventId: event.eventId,
      filename:
        (content.filename as string) ?? (content.body as string) ?? 'file',
      mimetype: info?.mimetype ?? 'application/octet-stream',
      size: info?.size,
    };
  }

  /**
   * Check if a message is a response to a pending approval request.
   * Uses a single Redis GET for fast lookup — no Y.Doc or task scanning.
   *
   * Works for both Portal and Matrix paths:
   *   1. Cheap Redis check for a pending approval in the room.
   *   2. If found, classify the message via cheap LLM.
   *   3. Delegate to ApprovalService when the user is approving/rejecting.
   */
  private async tryHandleApprovalResponse(
    messageText: string,
    userDid: string,
    roomId: string,
  ): Promise<ApprovalClassification | null> {
    if (!this.approvalService) {
      return null;
    }

    try {
      const pendingTaskId =
        await this.approvalService.getPendingTaskForRoom(roomId);
      if (!pendingTaskId) {
        return null;
      }

      const classification = await classifyApprovalResponse(messageText);
      if (!classification) {
        return null;
      }

      Logger.log(
        `[ApprovalGate] LLM classified message as ${classification.decision}${classification.reason ? ` (reason: ${classification.reason})` : ''} for task ${pendingTaskId}`,
      );

      const userHomeServer = await getMatrixHomeServerCroppedForDid(userDid);
      const { roomId: mainRoomId } =
        await this.sessionManagerService.matrixManger.getOracleRoomIdWithHomeServer(
          {
            userDid,
            oracleEntityDid: this.config.getOrThrow('ORACLE_ENTITY_DID'),
            userHomeServer,
          },
        );

      if (!mainRoomId) {
        Logger.log(
          `[ApprovalGate] Could not resolve mainRoomId for userDid=${userDid}; skipping approval handling.`,
        );
        return null;
      }

      await this.approvalService.handleApprovalResponse({
        taskId: pendingTaskId,
        approved: classification.decision === 'approved',
        mainRoomId,
        rejectionReason: classification.reason,
      });

      return classification;
    } catch (err) {
      Logger.error(
        `[ApprovalGate] Error handling approval response: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Rethrow so the error propagates — silently falling through to
      // normal chat processing would send "yes"/"no" to the LLM agent
      // and leave approval state inconsistent.
      throw err;
    }
  }

  public async onModuleInit(): Promise<void> {
    // Don't block server startup — defer listener until Matrix is ready.
    // matrixManager.init() is idempotent: returns the existing promise if already in progress.
    this.sessionManagerService.matrixManger
      .init()
      .then(() => {
        this.cleanUpMatrixListener =
          this.sessionManagerService.matrixManger.onMessage((roomId, event) => {
            this.handleMessage(event, roomId).catch((err) => {
              Logger.error(err);
            });
          });
        Logger.log('Matrix message listener registered');
      })
      .catch((err) => {
        Logger.error('Failed to set up Matrix message listener:', err);
      });
  }

  public async listMessages(
    params: ListMessagesDto & {
      did: string;
      homeServer?: string;
    },
  ): Promise<ListOracleMessagesResponse> {
    const { did, sessionId } = params;
    if (!sessionId || !did) {
      throw new BadRequestException('Invalid parameters');
    }

    this.checkpointStorageSyncService.markUserActive(did);
    try {
      const db = await this.checkpointStorageSyncService.getUserDatabase(did);
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
      this.checkpointStorageSyncService.markUserInactive(did);
    }
  }

  public async sendMessage(
    params: SendMessagePayload & {
      res?: Response;
      clientType?: 'matrix' | 'slack';
      msgFromMatrixRoom?: boolean;
      overrideLangchainThreadId?: string;
      req?: Request;
    },
  ): Promise<
    | undefined
    | {
        message: {
          type: string;
          content: string;
          id: string;
        };
        sessionId: string;
      }
  > {
    // Mark user active before any DB-touching path (prepareForQuery → getUserDatabase).
    this.checkpointStorageSyncService.markUserActive(params.did);

    try {
      const hasAttachments = !!params.attachments?.length;

      const queryResult = await this.prepareForQuery(params);

      const {
        runnableConfig,
        sessionId,
        roomId,
        userContext,
        targetSession,
      } = queryResult;

      // ── Portal approval gate interception ───────────────────────
      // Only check for portal clients — Matrix is handled in handleMessage.
      if (!params.msgFromMatrixRoom && roomId && this.approvalService) {
        const classification = await this.tryHandleApprovalResponse(
          params.message,
          params.did,
          roomId,
        );
        if (classification) {
          return {
            message: {
              type: 'ai',
              content:
                classification.decision === 'rejected'
                  ? 'Result rejected. Re-running the task with your feedback…'
                  : 'Result approved and delivered.',
              id: crypto.randomUUID(),
            },
            sessionId,
          };
        }
      }

      const msgFromMatrixRoom = params.msgFromMatrixRoom ?? false;
      const timestamp = new Date().toISOString();
      const inputMessages: HumanMessage[] = [
        new HumanMessage({
          content: params.message,
          additional_kwargs: { msgFromMatrixRoom, timestamp },
        }),
      ];

      if (hasAttachments) {
        Logger.log(
          `sendMessage: ${params.attachments!.length} attachment(s) received for session ${sessionId}, room ${roomId}`,
          'MessagesService',
        );

        const { texts, metadata, totalUsage } =
          await this.fileProcessingService.processAttachments(
            params.attachments!,
            roomId,
          );

        // Deduct credits for file processing API calls.
        if (
          totalUsage &&
          !this.config.get('DISABLE_CREDITS') &&
          isRedisEnabled()
        ) {
          try {
            const credits =
              totalUsage.cost > 0
                ? TokenLimiter.usdCostToCredits(totalUsage.cost)
                : TokenLimiter.llmTokenToCredits(
                    totalUsage.promptTokens + totalUsage.completionTokens,
                  );
            if (credits > 0 && params.did) {
              await TokenLimiter.limit(params.did, credits);
              Logger.log(
                `[FileProcessing] Deducted ${credits} credits (did=${params.did})`,
                'MessagesService',
              );
            }
          } catch (error) {
            // Non-blocking: file was already processed, log and continue.
            Logger.warn(
              `[FileProcessing] Failed to deduct credits: ${error instanceof Error ? error.message : String(error)}`,
              'MessagesService',
            );
          }
        }

        texts.forEach((text, i) => {
          const meta = metadata[i];
          if (!meta) {
            return;
          }
          // Prepend source reference so the agent can use process_file with
          // the correct eventId/url if it needs to re-process later.
          const sourceRef = meta.eventId
            ? `[source: eventId="${meta.eventId}"]`
            : meta.mxcUri
              ? `[source: url="${meta.mxcUri}"]`
              : '';
          const content = sourceRef ? `${sourceRef}\n${text}` : text;

          inputMessages.push(
            new HumanMessage({
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

      if (!params.msgFromMatrixRoom) {
        this.sessionManagerService.matrixManger
          .sendMessage({
            message: params.message,
            roomId,
            threadId: sessionId,
            isOracleAdmin: false,
          })
          .catch((err) => {
            Logger.error('Failed to replay API message to matrix room', err);
          });
      }

      if (params.stream && params.res) {
        setSSEHeaders(params.res, runnableConfig.configurable.requestId);
        params.res.flushHeaders();

        const heartbeat = startSSEHeartbeat(params.res);
        const abortController = new AbortController();

        // Abort any existing request for this session — only one per session.
        const existingController = this.abortControllers.get(sessionId);
        if (existingController) {
          existingController.abort();
        }

        this.abortControllers.set(sessionId, abortController);

        // Listen for client disconnection — Response 'close' is most reliable.
        const onClose = () => {
          abortController.abort();
        };

        params.res.on('close', onClose);

        try {
          await runWithSSEContext(
            params.res,
            async () => {
              // Send a thinking event for faster perceived feedback.
              const thinkingText =
                [
                  'Thinking...',
                  'Working...',
                  'Analyzing...',
                  'Processing...',
                  'Computing...',
                  'Crunching...',
                  'Deliberating...',
                  'Reasoning...',
                  'Calculating...',
                  'Evaluating...',
                  'Pondering...',
                  'Reading...',
                  'Synthesizing...',
                  'Formulating...',
                  'Considering...',
                  'Exploring ideas...',
                  'Investigating...',
                  'Brainstorming...',
                  'Solving...',
                  'Reviewing...',
                  'Reflecting...',
                ].at((Math.random() * 100) % 10) ?? 'thinking...';
              const thinkingEvent = ReasoningEvent.createChunk(
                sessionId,
                runnableConfig.configurable.requestId ?? '',
                thinkingText,
                [{ type: 'thinking', text: thinkingText }],
                false,
              );
              emitSSEEvent(thinkingEvent);
              thinkingEvent.emit();

              const stream = await this.mainAgent.streamMessage({
                input: inputMessages,
                runnableConfig,
                browserTools: params.tools ?? [],
                msgFromMatrixRoom,
                initialUserContext: userContext,
                abortController,
                editorRoomId: params.metadata?.editorRoomId,
                currentEntityDid: params.metadata?.currentEntityDid,
                agActions: params.agActions ?? [],
                ucanOptions: {
                  ucanService: this.ucanService,
                  mcpInvocations: params.mcpInvocations,
                },
                fileProcessingService: this.fileProcessingService,
                spaceId: params.metadata?.spaceId,
                tasksService: this.tasksService,
              });

              let fullContent = '';
              if (params.sessionId) {
                const toolCallMap = new Map<string, ToolCallEvent>();
                const actionCallMap = new Map<string, ActionCallEvent>();
                const agActionNames = new Set(
                  (params.agActions ?? []).map((action) => action.name),
                );

                Logger.log(
                  `[streamMessage] AG-UI actions registered: ${Array.from(agActionNames).join(', ') || 'none'}`,
                );

                for await (const { data, event } of stream) {
                  const isChatNode = true;

                  if (event === 'on_tool_end') {
                    const toolMessage = (data as { output: ToolMessage })
                      .output;

                    const actionCallEvent = actionCallMap.get(
                      toolMessage.tool_call_id,
                    );

                    if (actionCallEvent) {
                      actionCallEvent.payload.output = emojify(
                        toolMessage.content as string,
                      );
                      actionCallEvent.payload.toolCallId =
                        toolMessage.tool_call_id;

                      try {
                        const resultContent =
                          typeof toolMessage.content === 'string'
                            ? JSON.parse(toolMessage.content)
                            : toolMessage.content;

                        if (
                          resultContent?.success === false ||
                          resultContent?.error
                        ) {
                          actionCallEvent.payload.status = 'error';
                          actionCallEvent.payload.error =
                            resultContent.error || 'Action failed';
                        } else {
                          actionCallEvent.payload.status = 'done';
                        }
                      } catch {
                        actionCallEvent.payload.status = 'done';
                      }

                      if (!params.res) {
                        throw new Error('Response not found');
                      }
                      if (
                        !params.res.writableEnded &&
                        !abortController.signal.aborted
                      ) {
                        params.res.write(
                          formatSSE(
                            actionCallEvent.eventName,
                            actionCallEvent.payload,
                          ),
                        );
                      }
                      actionCallMap.delete(toolMessage.tool_call_id);
                      continue;
                    } else {
                      const toolCallEvent = toolCallMap.get(
                        toolMessage.tool_call_id,
                      );
                      if (!toolCallEvent) {
                        continue;
                      }
                      toolCallEvent.payload.output = emojify(
                        toolMessage.content as string,
                      );
                      toolCallEvent.payload.status = 'done';
                      (
                        toolCallEvent.payload.args as Record<string, unknown>
                      ).toolName = toolMessage.name;
                      toolCallEvent.payload.eventId = toolMessage.tool_call_id;
                      if (!params.res) {
                        throw new Error('Response not found');
                      }
                      if (
                        !params.res.writableEnded &&
                        !abortController.signal.aborted
                      ) {
                        params.res.write(
                          formatSSE(
                            toolCallEvent.eventName,
                            toolCallEvent.payload,
                          ),
                        );
                      }
                      toolCallMap.delete(toolMessage.tool_call_id);
                      continue;
                    }
                  }

                  if (event === 'on_chat_model_stream') {
                    const chunk = (data as { chunk: AIMessageChunk }).chunk;
                    const content = chunk.content;
                    const toolCall = chunk.tool_calls;

                    const rawResponse = chunk.additional_kwargs?.__raw_response as
                      | {
                          choices?: Array<{
                            delta?: {
                              reasoning?: string;
                              reasoning_content?: string;
                              reasoning_details?: unknown;
                            };
                          }>;
                        }
                      | undefined;

                    const delta = rawResponse?.choices?.[0]?.delta;
                    const reasoning =
                      delta?.reasoning ?? delta?.reasoning_content;
                    if (reasoning && isChatNode && reasoning.trim()) {
                      const cleanedKwargs = cleanAdditionalKwargs(
                        chunk.additional_kwargs,
                        params.msgFromMatrixRoom ?? false,
                      );

                      const reasoningEvent = ReasoningEvent.createChunk(
                        sessionId,
                        runnableConfig.configurable.requestId ?? '',
                        reasoning,
                        cleanedKwargs.reasoningDetails,
                        false,
                      );

                      if (!params.res) {
                        throw new Error('Response not found');
                      }
                      if (
                        !params.res.writableEnded &&
                        !abortController.signal.aborted
                      ) {
                        params.res.write(
                          formatSSE(
                            reasoningEvent.eventName,
                            reasoningEvent.payload,
                          ),
                        );
                      }
                    }

                    toolCall?.forEach((tool) => {
                      if (!tool.name.trim() || !tool.id) {
                        return;
                      }

                      Logger.log(
                        `[streamMessage] Tool call detected: ${tool.name}, isAgAction: ${agActionNames.has(tool.name)}`,
                      );

                      if (agActionNames.has(tool.name)) {
                        const actionCallEvent = new ActionCallEvent({
                          requestId:
                            runnableConfig.configurable.requestId ?? '',
                          sessionId,
                          toolCallId: tool.id,
                          toolName: tool.name,
                          args: undefined, // sent via WS only
                          status: 'isRunning',
                        });

                        if (!params.res) {
                          throw new Error('Response not found');
                        }
                        if (
                          !params.res.writableEnded &&
                          !abortController.signal.aborted
                        ) {
                          params.res.write(
                            formatSSE(
                              actionCallEvent.eventName,
                              actionCallEvent.payload,
                            ),
                          );
                        }
                        actionCallMap.set(tool.id, actionCallEvent);
                      } else {
                        const toolCallEvent = new ToolCallEvent({
                          requestId:
                            runnableConfig.configurable.requestId ?? '',
                          sessionId,
                          toolName: 'toolCall',
                          args: {},
                          status: 'isRunning',
                        });
                        toolCallEvent.payload.args = tool.args;
                        (
                          toolCallEvent.payload.args as Record<
                            string,
                            unknown
                          >
                        ).toolName = tool.name;
                        toolCallEvent.payload.eventId = tool.id;

                        if (!params.res) {
                          throw new Error('Response not found');
                        }
                        if (
                          !params.res.writableEnded &&
                          !abortController.signal.aborted
                        ) {
                          params.res.write(
                            formatSSE(
                              toolCallEvent.eventName,
                              toolCallEvent.payload,
                            ),
                          );
                        }
                        toolCallMap.set(tool.id, toolCallEvent);
                      }
                    });

                    if (!content) {
                      continue;
                    }
                    if (isChatNode) {
                      const parsed = emojify(String(content));
                      fullContent += parsed;
                      if (!params.res) {
                        throw new Error('Response not found');
                      }
                      if (
                        !params.res.writableEnded &&
                        !abortController.signal.aborted
                      ) {
                        params.res.write(
                          formatSSE('message', {
                            content: parsed,
                            timestamp: new Date().toISOString(),
                          }),
                        );
                      }
                    }
                  }
                }

                if (!abortController.signal.aborted && fullContent) {
                  this.sessionManagerService.matrixManger
                    .sendMessage({
                      message: fullContent,
                      roomId,
                      threadId: sessionId,
                      isOracleAdmin: true,
                    })
                    .catch((err) => {
                      Logger.error(
                        'Failed to replay API AI response message to matrix room',
                        {
                          err,
                          sessionId,
                        },
                      );
                    });
                }
              }

              if (!abortController.signal.aborted) {
                if (!params.res) {
                  throw new Error('Response not found');
                }

                const reasoningCompleteEvent = ReasoningEvent.createChunk(
                  sessionId,
                  runnableConfig.configurable.requestId ?? '',
                  '',
                  undefined,
                  true,
                );

                if (!params.res.writableEnded) {
                  params.res.write(
                    formatSSE(
                      reasoningCompleteEvent.eventName,
                      reasoningCompleteEvent.payload,
                    ),
                  );
                }

                sendSSEDone(params.res);

                // Increment ref count BEFORE firing background task so the
                // outer finally's markUserInactive doesn't drop to 0 while
                // performPostMessageSync still accesses the DB.
                this.checkpointStorageSyncService.markUserActive(params.did);
                this.performPostMessageSync(
                  params,
                  sessionId,
                  roomId,
                  targetSession,
                );
              }
            },
            abortController,
          );

          return;
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === 'AbortError' ||
              error.message.includes('aborted') ||
              error.message.includes('Stream aborted by client'))
          ) {
            if (!params.res.writableEnded) {
              sendSSEDone(params.res);
            }
            return;
          }

          Logger.error('Failed to stream message', error);
          if (!params.res.writableEnded && !abortController.signal.aborted) {
            sendSSEError(
              params.res,
              error instanceof Error ? error : 'Something went wrong',
            );
            sendSSEDone(params.res);
          }
        } finally {
          clearInterval(heartbeat);
          params.res.off('close', onClose);
          this.abortControllers.delete(sessionId);
          if (!params.res.writableEnded) {
            params.res.end();
          }
        }
      }

      const result = await this.mainAgent.sendMessage({
        input: inputMessages,
        runnableConfig,
        browserTools: params.tools ?? [],
        msgFromMatrixRoom,
        initialUserContext: userContext,
        editorRoomId: params.metadata?.editorRoomId,
        currentEntityDid: params.metadata?.currentEntityDid,
        clientType: params.clientType,
        ucanOptions: {
          ucanService: this.ucanService,
          mcpInvocations: params.mcpInvocations,
        },
        fileProcessingService: this.fileProcessingService,
        spaceId: params.metadata?.spaceId,
        tasksService: this.tasksService,
      });
      const lastMessage = result.messages.at(-1);
      if (!lastMessage) {
        throw new BadRequestException('No message returned from the oracle');
      }

      if (!params.msgFromMatrixRoom) {
        this.sessionManagerService.matrixManger
          .sendMessage({
            message: String(lastMessage.content),
            roomId,
            threadId: sessionId,
            isOracleAdmin: true,
          })
          .catch((err) => {
            Logger.error(
              'Failed to replay API AI response message to matrix room',
              { err, sessionId },
            );
          });
      }

      // Increment ref count BEFORE firing background task so the outer
      // finally's markUserInactive doesn't drop to 0 while
      // performPostMessageSync still accesses the DB.
      this.checkpointStorageSyncService.markUserActive(params.did);
      this.performPostMessageSync(params, sessionId, roomId, targetSession);

      return {
        message: {
          type: lastMessage.getType(),
          content: String(lastMessage.content),
          id: lastMessage.id ?? '',
        },
        sessionId,
      };
    } finally {
      this.checkpointStorageSyncService.markUserInactive(params.did);
    }
  }

  /**
   * Fire-and-forget session sync after a message is sent. Loads the latest
   * session messages and persists them (plus oracle metadata and
   * lastProcessedCount) via SessionManagerService.
   */
  private performPostMessageSync(
    params: SendMessagePayload,
    sessionId: string,
    roomId: string,
    targetSession: ChatSession,
  ): void {
    void Promise.resolve().then(async () => {
      try {
        const { messages: currentMessages } = await this.listMessages({
          did: params.did,
          sessionId,
          homeServer: params.homeServer,
        });
        await this.sessionManagerService.syncSessionSet({
          sessionId,
          oracleName: this.config.getOrThrow('ORACLE_NAME'),
          did: params.did,
          messages: currentMessages.map((message) =>
            message.content.toString(),
          ),
          oracleDid: this.config.getOrThrow<string>('ORACLE_DID'),
          oracleEntityDid: this.config.getOrThrow('ORACLE_ENTITY_DID'),
          lastProcessedCount: targetSession?.lastProcessedCount ?? 0,
          roomId,
        });
      } catch (error) {
        Logger.error('Failed to perform post-message sync:', error);
      } finally {
        this.checkpointStorageSyncService.markUserInactive(params.did);
      }
    });
  }

  /** Abort an in-flight stream by sessionId. */
  public abortRequest(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Extract timezone from payload (body) or request headers (fallback).
   * Body takes priority for backends that don't pass custom headers.
   */
  private getTimezoneFromRequest(
    payload?: SendMessagePayload,
    req?: Request,
  ): string | undefined {
    if (payload?.timezone) {
      return payload.timezone.trim() || undefined;
    }

    if (!req) {
      return undefined;
    }

    const timezoneHeader = req.headers['x-timezone'];
    if (!timezoneHeader) {
      return undefined;
    }

    const timezone =
      typeof timezoneHeader === 'string'
        ? timezoneHeader
        : Array.isArray(timezoneHeader)
          ? timezoneHeader[0]
          : undefined;

    return timezone?.trim() || undefined;
  }

  /** Format current time in the given IANA timezone, falling back to UTC. */
  private getCurrentTimeInTimezone(timezone: string): string {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      });

      return formatter.format(now);
    } catch (error) {
      Logger.warn(
        `Failed to format time for timezone ${timezone}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Date().toLocaleString('en-US', {
        timeZone: 'UTC',
        timeZoneName: 'short',
      });
    }
  }

  private async prepareForQuery(
    payload: SendMessagePayload & {
      req?: Request;
      overrideLangchainThreadId?: string;
    },
  ): Promise<{
    sessionId: string;
    roomId: string;
    homeServerName: string;
    runnableConfig: IRunnableConfigWithRequiredFields & {
      configurable: {
        sessionId: string;
      };
    };
    userContext?: UserContextData;
    targetSession: ChatSession;
  }> {
    const did = payload.did;
    const sessionId = payload.sessionId;
    const requestId =
      payload.stream && 'requestId' in payload
        ? (payload.requestId as string)
        : crypto.randomUUID();

    const homeServerName =
      payload.homeServer || (await getMatrixHomeServerCroppedForDid(did));

    // Sync and session lookup in parallel — they're independent.
    const [, targetSession] = await Promise.all([
      this.checkpointStorageSyncService.syncLocalStorageFromMatrixStorage({
        userDid: did,
      }),
      this.sessionManagerService.getSession(sessionId, did, false),
    ]);

    if (!targetSession) {
      throw new NotFoundException('Session not found');
    }

    let roomId = targetSession?.roomId;
    if (!roomId) {
      const roomResult =
        await this.sessionManagerService.matrixManger.getOracleRoomIdWithHomeServer(
          {
            userDid: did,
            oracleEntityDid: this.config.getOrThrow('ORACLE_ENTITY_DID'),
            userHomeServer: homeServerName,
          },
        );
      roomId = roomResult.roomId;
      if (!roomId) {
        throw new NotFoundException('Room not found or Invalid Session Id');
      }
    }

    const timezone = this.getTimezoneFromRequest(payload, payload.req);
    const currentTime = timezone
      ? this.getCurrentTimeInTimezone(timezone)
      : undefined;

    const runnableConfig: IRunnableConfigWithRequiredFields & {
      configurable: {
        sessionId: string;
      };
    } = {
      configurable: {
        thread_id: payload.overrideLangchainThreadId ?? sessionId,
        requestId,
        sessionId: payload.overrideLangchainThreadId ?? sessionId,
        configs: {
          matrix: {
            roomId,
            oracleDid: this.config.getOrThrow<string>('ORACLE_DID'),
            homeServerName,
          },
          user: {
            did,
            ...(timezone && { timezone }),
            ...(currentTime && { currentTime }),
          },
        },
      },
    };

    return {
      roomId,
      homeServerName,
      runnableConfig,
      sessionId,
      userContext: targetSession?.userContext as UserContextData | undefined,
      targetSession,
    };
  }
}
