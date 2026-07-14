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
import {
  getMatrixHomeServerCroppedForDid,
  OpenIdTokenProvider,
} from '@ixo/oracles-chain-client';
import {
  ActionCallEvent,
  ReasoningEvent,
  ToolCallEvent,
} from '@ixo/oracles-events';

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
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Request, Response } from 'express';
import { SqliteSaver } from '@ixo/sqlite-saver';
import {
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
  ToolMessage,
} from 'langchain';
import { emojify } from 'node-emoji';
import * as crypto from 'node:crypto';
import { MainAgentGraph } from 'src/graph';
import { cleanAdditionalKwargs } from 'src/graph/nodes/chat-node/utils';
import { type TMainAgentGraphState } from 'src/graph/state';
import { ApprovalService } from 'src/tasks/approval.service';
import {
  classifyApprovalResponse,
  type ApprovalClassification,
} from 'src/tasks/processors/processor-utils';
import { TasksService } from 'src/tasks/task.service';
import { isRedisEnabled } from 'src/config';
import { type ENV } from 'src/types';
import { BlobStoreService } from 'src/blob-store/blob-store.service';
import { UcanService } from 'src/ucan/ucan.service';
import { UserMatrixSqliteSyncService } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { normalizeDid } from 'src/utils/header.utils';
import { emitSSEEvent, runWithSSEContext } from 'src/utils/sse-context';
import {
  formatSSE,
  sendSSEDone,
  sendSSEError,
  setSSEHeaders,
  startSSEHeartbeat,
} from 'src/utils/sse.utils';
import { TokenLimiter } from 'src/utils/token-limit-handler';
import { ChannelMemoryService } from 'src/channel-memory/channel-memory.service';
import { type ObservedMessage } from 'src/channel-memory/channel-memory.types';
import {
  isActiveBotThread,
  markBotThreadActive,
  shouldAgentRespond,
  sweepExpiredBotThreads,
} from './group-chat.guard';
import { type ListMessagesDto } from './dto/list-messages.dto';
import {
  type MessageFeedback,
  type MessageFeedbackResponse,
} from './dto/message-feedback.dto';
import {
  clearMessageFeedback as clearPersistedMessageFeedback,
  listMessageFeedback,
  saveMessageFeedback,
  validateMessageFeedbackTarget,
} from './message-feedback.repository';
import { type SendMessagePayload } from './dto/send-message.dto';
import {
  FileProcessingService,
  type SandboxUploadConfig,
} from './file-processing.service';

type MessageDto = ListOracleMessagesResponse['messages'][number];
export type MessageWithFeedback = MessageDto & {
  feedback?: MessageFeedback;
};
export interface ListMessagesWithFeedbackResponse {
  messages: MessageWithFeedback[];
  capabilities: { messageFeedback: true };
}

@Injectable()
export class MessagesService implements OnModuleInit, OnModuleDestroy {
  private cleanUpMatrixListener: () => void;
  private cleanUpJoinListener: (() => void) | undefined;
  private threadRootCache = new Map<string, string>(); // eventId → rootEventId
  private abortControllers = new Map<string, AbortController>(); // sessionId → AbortController
  private readonly oracleOpenIdTokenProvider: OpenIdTokenProvider;
  private readonly oracleMatrixBaseUrl: string;

  /**
   * Rooms we've already greeted in this process. Stops duplicate welcomes if
   * matrix-bot-sdk fires `room.join` more than once for the same room.
   * Lost on restart — that's fine: room.join only fires for fresh joins, not
   * for already-joined rooms during initial sync.
   */
  private readonly welcomedRooms = new Set<string>();
  /** Brief settle delay before sending the welcome — lets Olm sessions form. */
  private static readonly WELCOME_DELAY_MS = 1500;

  /** Cached room-shape lookup so we don't hit Matrix API on every message. */
  private readonly roomTypeCache = new Map<
    string,
    { isDirect: boolean; memberCount: number; expiresAt: number }
  >();
  private static readonly ROOM_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Active bot threads in group rooms. Key = `${roomId}:${threadId}`,
   * value = expiresAt epoch ms. Updated when the bot responds in a thread,
   * decayed on read. Cleared on restart.
   */
  private readonly activeBotThreads = new Map<string, number>();
  private static readonly ACTIVE_THREAD_TTL_MS = 30 * 60 * 1000;

  /**
   * Per-thread debounce buffer for Matrix events.
   * When a user sends text + file, Matrix delivers them as separate events.
   * We batch events arriving within MATRIX_DEBOUNCE_MS into a single sendMessage() call.
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
    private readonly config: ConfigService<ENV>,
    private readonly checkpointStorageSyncService: UserMatrixSqliteSyncService,
    private readonly fileProcessingService: FileProcessingService,
    private readonly channelMemoryService: ChannelMemoryService,
    @Optional() private readonly tasksService?: TasksService,
    @Optional() private readonly approvalService?: ApprovalService,
    @Optional() private readonly ucanService?: UcanService,
    @Optional() private readonly blobStore?: BlobStoreService,
  ) {
    this.matrixManager = this.sessionManagerService.matrixManger;
    this.oracleMatrixBaseUrl = this.config
      .getOrThrow<string>('MATRIX_BASE_URL')
      .replace(/\/$/, '');
    this.oracleOpenIdTokenProvider = new OpenIdTokenProvider({
      matrixAccessToken: this.config.getOrThrow(
        'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
      ),
      homeServerUrl: this.oracleMatrixBaseUrl,
      matrixUserId: this.config.getOrThrow('MATRIX_ORACLE_ADMIN_USER_ID'),
    });
  }

  public onModuleDestroy(): void {
    // Clear all pending debounce timers to prevent flushes after destroy
    for (const [, entry] of this.matrixEventBuffer) {
      clearTimeout(entry.timer);
    }
    this.matrixEventBuffer.clear();

    if (this.cleanUpMatrixListener) {
      this.cleanUpMatrixListener();
    }
    if (this.cleanUpJoinListener) {
      this.cleanUpJoinListener();
      this.cleanUpJoinListener = undefined;
    }
  }

  private async getThreadRoot(
    event: MessageEvent<
      MessageEventContent & {
        'm.relates_to'?: {
          rel_type?: string;
          event_id?: string;
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

    const relatesTo = event.content['m.relates_to'];

    // Matrix thread replies carry rel_type="m.thread" with the true root in
    // event_id. The m.in_reply_to field is a fallback pointing at the previous
    // message (NOT the root), so we must NOT walk it for threaded messages.
    if (relatesTo?.rel_type === 'm.thread' && relatesTo?.event_id) {
      const root = relatesTo.event_id;
      this.threadRootCache.set(eventId, root);
      return root;
    }

    const inReplyTo = relatesTo?.['m.in_reply_to']?.event_id;

    if (!inReplyTo) {
      // This event IS the root
      this.threadRootCache.set(eventId, eventId);
      return eventId;
    }

    // Check if we already know the parent's root
    if (this.threadRootCache.has(inReplyTo)) {
      const rootEventId = this.threadRootCache.get(inReplyTo);
      if (!rootEventId) {
        return undefined;
      }

      // Cache this event too while we're at it
      this.threadRootCache.set(eventId, rootEventId);

      Logger.log(`Cache hit for event ${eventId} with root ${rootEventId}`);
      return rootEventId;
    }

    // Need to walk up the chain
    const pathToCache: string[] = [eventId]; // Track events we visit
    let currentEventId = inReplyTo;
    const visited = new Set<string>();

    while (currentEventId && !visited.has(currentEventId)) {
      visited.add(currentEventId);
      pathToCache.push(currentEventId);

      // Check cache before doing expensive lookup
      if (this.threadRootCache.has(currentEventId)) {
        const rootEventId = this.threadRootCache.get(currentEventId);
        if (!rootEventId) {
          return undefined;
        }
        // Cache entire path we just discovered
        pathToCache.forEach((id) => this.threadRootCache.set(id, rootEventId));
        Logger.log(
          `Cache hit for event ${currentEventId} with root ${rootEventId}`,
        );
        return rootEventId;
      }

      let parentEvent: Awaited<
        ReturnType<
          typeof this.matrixManager.getEventById<{
            'm.relates_to'?: {
              rel_type?: string;
              event_id?: string;
              'm.in_reply_to'?: { event_id: string };
            };
          }>
        >
      >;
      try {
        parentEvent = await this.matrixManager.getEventById<{
          'm.relates_to'?: {
            rel_type?: string;
            event_id?: string;
            'm.in_reply_to'?: { event_id: string };
          };
        }>(roomId, currentEventId);
      } catch {
        // Event not found (404) — treat currentEventId as the root
        pathToCache.forEach((id) =>
          this.threadRootCache.set(id, currentEventId),
        );
        return currentEventId;
      }

      const parentRelatesTo = parentEvent.content['m.relates_to'];

      // If the parent is itself a thread reply, its root IS the true root
      if (
        parentRelatesTo?.rel_type === 'm.thread' &&
        parentRelatesTo?.event_id
      ) {
        const root = parentRelatesTo.event_id;
        pathToCache.forEach((id) => this.threadRootCache.set(id, root));
        return root;
      }

      const parentInReplyTo = parentRelatesTo?.['m.in_reply_to']?.event_id;
      if (!parentInReplyTo) {
        // Found the root!

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

  /** Supported Matrix file message types */
  private static readonly FILE_MSGTYPES = new Set([
    'm.file',
    'm.image',
    'm.video',
    'm.audio',
  ]);

  /**
   * Resolve a room's shape (DM vs group) with a 5-minute cache.
   * Cache misses fetch from Matrix; failures fall back to a "treat as DM"
   * default to preserve current behaviour for unknown rooms.
   */
  private async getCachedRoomInfo(
    roomId: string,
  ): Promise<{ isDirect: boolean; memberCount: number }> {
    const now = Date.now();
    const cached = this.roomTypeCache.get(roomId);
    if (cached && cached.expiresAt > now) {
      return { isDirect: cached.isDirect, memberCount: cached.memberCount };
    }
    try {
      const info = await this.matrixManager.getRoomInfo(roomId);
      this.roomTypeCache.set(roomId, {
        isDirect: info.isDirect,
        memberCount: info.memberCount,
        expiresAt: now + MessagesService.ROOM_TYPE_CACHE_TTL_MS,
      });
      return { isDirect: info.isDirect, memberCount: info.memberCount };
    } catch (err) {
      Logger.warn(
        `[MessagesService] getRoomInfo failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}; defaulting to isDirect=true`,
      );
      return { isDirect: true, memberCount: 0 };
    }
  }

  private invalidateRoomTypeCache(roomId: string): void {
    this.roomTypeCache.delete(roomId);
  }

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

    // Skip internal messages
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
    // If this is a text reply and we have an ApprovalService, check
    // if it's a response to a pending approval request.
    if (isText && this.approvalService) {
      Logger.log(
        `[Matrix][handleMessage] isText=${isText} and approvalService exists, attempting approval response classification check`,
      );
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
    } else {
      Logger.log('[Matrix][handleMessage] bypass approvalService ', {
        approvalService: !!this.approvalService,
        isText,
      });
    }

    // ── Group-chat gating + passive capture ────────────────────────
    // Resolve room shape once and use it both for capture and gating.
    const roomInfo = await this.getCachedRoomInfo(roomId);
    const isGroup = !roomInfo.isDirect;

    if (isGroup && isText) {
      // Capture EVERY group-room text message into channel memory, even if
      // the bot isn't going to respond. This is what gives the agent context
      // about top-level chatter when it later does get engaged.
      const body = 'body' in event.content ? String(event.content.body) : '';
      if (body.length > 0) {
        const displayName = await this.matrixManager
          .getCachedDisplayName(event.sender, roomId)
          .catch(() => event.sender);
        const observed: ObservedMessage = {
          eventId: event.eventId,
          threadId,
          senderDid: did,
          senderMatrixUserId: event.sender,
          senderDisplayName: displayName,
          body,
          timestamp: event.timestamp ?? Date.now(),
        };
        this.channelMemoryService.observeMessage(roomId, observed);
      }
    }

    if (isGroup) {
      let botMatrixUserId: string;
      try {
        botMatrixUserId = this.matrixManager.getBotMatrixUserId();
      } catch (err) {
        Logger.warn(
          `[Matrix][handleMessage] Bot user id unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      const decision = await shouldAgentRespond({
        event,
        roomId,
        threadId,
        matrixManager: this.matrixManager,
        botMatrixUserId,
        roomInfo,
        activeBotThreads: this.activeBotThreads,
        activeBotThreadTtlMs: MessagesService.ACTIVE_THREAD_TTL_MS,
      });
      if (!decision.respond) {
        Logger.log(
          `[Matrix][handleMessage] Group room ${roomId}: silently ignoring eventId=${event.eventId} (reason=${decision.reason})`,
        );
        return;
      }
      Logger.log(
        `[Matrix][handleMessage] Group room ${roomId}: responding to eventId=${event.eventId} (reason=${decision.reason})`,
      );
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
      if (hasSession) {
        Logger.log(
          `[Matrix][handleMessage] FOUND existing session for did=${did} sessionId=${checkSessionId} (threadId=${threadId})`,
        );
      } else {
        Logger.log(
          `[Matrix][handleMessage] No existing session found for did=${did} sessionId=${checkSessionId} (threadId=${threadId}), will create new session`,
        );
      }
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
          `[Matrix][handleMessage] Creating NEW session for did=${did} sessionId=${checkSessionId} homeServer=${userHomeServer} oracleHomeServer=${oracleHomeServer} roomId=${roomId}`,
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
            roomId, // Store the actual room (may be a task room, not main room)
          },
          checkSessionId,
        );
        Logger.log(
          `[Matrix][handleMessage] Session CREATED for did=${did} sessionId=${checkSessionId}`,
        );
      } catch (err) {
        Logger.error(
          `[Matrix][handleMessage] Error creating session for did=${did} sessionId=${checkSessionId}`,
          err,
        );
        return;
      }
    }

    // Buffer the event — the debounce timer will flush once no more events arrive
    const existing = this.matrixEventBuffer.get(threadId);
    if (existing) {
      Logger.log(
        `[Matrix][handleMessage] Found existing buffer for threadId=${threadId}, appending eventId=${event.eventId}`,
      );
      clearTimeout(existing.timer);
      existing.events.push({ event, roomId });
    } else {
      Logger.log(
        `[Matrix][handleMessage] Creating new buffer for threadId=${threadId} with eventId=${event.eventId}`,
      );
      this.matrixEventBuffer.set(threadId, {
        events: [{ event, roomId }],
        timer: null as unknown as NodeJS.Timeout,
      });
    }

    const entry = this.matrixEventBuffer.get(threadId)!;
    entry.timer = setTimeout(() => {
      Logger.log(
        `[Matrix][handleMessage] Debounce timer elapsed for threadId=${threadId}, flushing events (sessionId=${sessionId})`,
      );
      this.flushMatrixEvents(threadId, langchainThreadId).catch((err) => {
        Logger.error(
          `Failed to flush Matrix events for thread ${threadId}`,
          err,
        );
      });
    }, this.MATRIX_DEBOUNCE_MS);
  }

  /**
   * Flush all buffered Matrix events for a thread into a single sendMessage() call.
   * Separates text messages from file attachments and batches them together.
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
    if (events.length === 0) {
      Logger.warn(
        `[Matrix][flushMatrixEvents] No events to flush for threadId=${threadId}`,
      );
      return;
    }

    // Use the roomId from the first event (all events in a thread share the same room)
    const roomId = events[0].roomId;
    const did = normalizeDid(events[0].event.sender);
    const homeServer = events[0].event.sender.split(':')[1];
    const lastEvent = events[events.length - 1].event;

    // Separate text and file events
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
        // Use the last text message if multiple arrive (unlikely but safe)
        textBody = event.content.body;
      } else if (
        typeof msgtype === 'string' &&
        MessagesService.FILE_MSGTYPES.has(msgtype)
      ) {
        attachments.push(this.buildAttachmentFromEvent(event));
      }
    }

    // Resolve room type and speaker metadata for group-chat handling
    const roomInfo = await this.getCachedRoomInfo(roomId);
    const isGroup = !roomInfo.isDirect;

    // Build the message text — for group rooms, prefix with display name so
    // the agent (and the prompt prefix it sees in the HumanMessage) knows who
    // is speaking. DMs keep their existing shape.
    const rawText =
      textBody ??
      (attachments.length === 1
        ? `User shared a file: ${attachments[0].filename}`
        : `User shared ${attachments.length} file(s): ${attachments.map((a) => a.filename).join(', ')}`);

    let speakerDisplayName: string | undefined;
    let message = rawText;
    if (isGroup) {
      speakerDisplayName = await this.matrixManager
        .getCachedDisplayName(lastEvent.sender, roomId)
        .catch(() => lastEvent.sender);
      message = `[${speakerDisplayName}]: ${rawText}`;
    }

    // JIT compaction so the system context block reflects all unsummarised
    // messages, including the one we're responding to. Best-effort, capped.
    if (isGroup) {
      await this.channelMemoryService.compactJustInTime(roomId).catch((err) => {
        Logger.warn(
          `[Matrix][flushMatrixEvents] JIT compaction failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    try {
      Logger.log(
        `[Matrix][flushMatrixEvents] Sending message for threadId=${threadId} sessionId=${overRideSessionId ?? threadId} did=${did} attachments=${attachments.length} group=${isGroup}`,
      );
      const aiMessage = await this.sendMessage({
        clientType: 'matrix',
        message,
        did,
        sessionId: threadId,
        overrideLangchainThreadId: overRideSessionId,
        homeServer,
        msgFromMatrixRoom: true,
        userMatrixOpenIdToken: '',
        ...(isGroup && {
          groupChat: {
            roomId,
            memberCount: roomInfo.memberCount,
            speaker: {
              did,
              matrixUserId: lastEvent.sender,
              displayName: speakerDisplayName ?? lastEvent.sender,
              eventId: lastEvent.eventId,
              threadId,
            },
          },
        }),
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

      // Mark the thread as actively engaged so subsequent messages from any
      // user in this thread (within 30 min) reach the bot without needing a
      // re-mention. Lazy sweep of expired entries keeps the map bounded.
      if (isGroup) {
        markBotThreadActive(
          this.activeBotThreads,
          roomId,
          threadId,
          MessagesService.ACTIVE_THREAD_TTL_MS,
        );
        sweepExpiredBotThreads(this.activeBotThreads);
      }

      Logger.log(
        `[Matrix][flushMatrixEvents] Message sent to Matrix roomId=${roomId} threadId=${threadId} by Oracle (group=${isGroup}, threadActive=${isActiveBotThread(this.activeBotThreads, roomId, threadId)})`,
      );
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
   * 1. First checks if there's a pending approval in the room (cheap — no LLM call)
   * 2. If pending approval found, uses LLM classifier to determine intent
   * 3. Delegates to ApprovalService if the user is approving/rejecting
   *
   * Returns the classification if handled, null otherwise.
   */
  private async tryHandleApprovalResponse(
    messageText: string,
    userDid: string,
    roomId: string,
  ): Promise<ApprovalClassification | null> {
    if (!this.approvalService) {
      Logger.log(
        '[ApprovalGate] No approvalService instance, skipping approval response check.',
      );
      return null;
    }

    try {
      // Fast path: single Redis GET to check if this room has a pending approval
      const pendingTaskId =
        await this.approvalService.getPendingTaskForRoom(roomId);
      if (!pendingTaskId) {
        Logger.log(
          `[ApprovalGate] No pending approval for roomId=${roomId}, returning null.`,
        );
        return null;
      }

      // There IS a pending approval — classify the message with a cheap LLM
      const classification = await classifyApprovalResponse(messageText);
      if (!classification) {
        Logger.log(
          `[ApprovalGate] LLM classification returned null for messageText="${messageText}", skipping approval handling.`,
        );
        return null;
      }

      Logger.log(
        `[ApprovalGate] LLM classified message as ${classification.decision}${classification.reason ? ` (reason: ${classification.reason})` : ''} for task ${pendingTaskId}`,
      );

      // Resolve main room for the task update
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
          `[ApprovalGate] Could not resolve mainRoomId for userDid=${userDid}, oracleEntityDid=${this.config.getOrThrow('ORACLE_ENTITY_DID')}, userHomeServer=${userHomeServer}; skipping approval handling.`,
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

    return null;
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

        // Send a welcome message every time the bot is freshly added to a
        // room. This bootstraps Olm + Megolm sessions BEFORE the user types,
        // which fixes the common "first messages can't be decrypted" failure
        // mode in fresh group rooms.
        this.cleanUpJoinListener = this.matrixManager.onBotJoinedRoom(
          (roomId) => {
            this.handleBotJoinedRoom(roomId).catch((err) => {
              Logger.warn(
                `[Welcome] Handler failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          },
        );
        Logger.log('Matrix room.join welcome listener registered');
      })
      .catch((err) => {
        Logger.error('Failed to set up Matrix message listener:', err);
      });
  }

  /**
   * Send a one-time greeting when the bot joins a room. The message itself is
   * encrypted, which is what we actually want — sending forces the bot to:
   *   1. Establish Olm 1:1 sessions with every current member,
   *   2. Create a Megolm group session that includes those members,
   *   3. Distribute the Megolm key via the Olm sessions.
   *
   * Once that one round-trip completes, the user's next message also rotates
   * to a fresh Megolm session that includes the bot — so it actually decrypts.
   *
   * Idempotent within the process via `welcomedRooms`. matrix-bot-sdk's
   * `room.join` only fires for fresh joins so this should not re-greet on
   * restart, but the Set guards against double-fires within a session.
   */
  private async handleBotJoinedRoom(roomId: string): Promise<void> {
    if (this.welcomedRooms.has(roomId)) {
      Logger.log(
        `[Welcome] Skipping ${roomId}: already greeted in this session`,
      );
      return;
    }
    this.welcomedRooms.add(roomId);

    // Brief settle so the device list / Olm sessions can converge before
    // we trigger an outgoing encrypt.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, MessagesService.WELCOME_DELAY_MS),
    );

    // Tailor the message to room shape — DMs get a friendlier greeting,
    // group rooms get the engagement rules up front so users know what
    // to expect.
    let isDirect = true;
    try {
      const info = await this.matrixManager.getRoomInfo(roomId);
      isDirect = info.isDirect;
    } catch (err) {
      Logger.warn(
        `[Welcome] getRoomInfo failed for ${roomId}, defaulting to DM tone: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const oracleName =
      this.config.get<string>('ORACLE_NAME', { infer: true }) ?? 'Oracle';
    const message = isDirect
      ? `Hi! I'm ${oracleName}. How can I help?`
      : `${oracleName} here — I've joined this room. Mention me with @${oracleName} or reply to one of my messages whenever you'd like my help; I'll stay quiet otherwise.`;

    try {
      await this.matrixManager.sendMessage({
        roomId,
        message,
        isOracleAdmin: true,
        disablePrefix: true,
      });
      Logger.log(`[Welcome] Sent greeting to ${roomId} (isDirect=${isDirect})`);
    } catch (err) {
      // Don't unmark — re-trying could spam the room. User can reinvite.
      Logger.warn(
        `[Welcome] Failed to send greeting to ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  public async listMessages(
    params: ListMessagesDto & {
      did: string;
      homeServer?: string;
    },
  ): Promise<ListMessagesWithFeedbackResponse> {
    const { did, sessionId } = params;
    if (!sessionId || !did) {
      throw new BadRequestException('Invalid parameters');
    }

    this.checkpointStorageSyncService.markUserActive(did);
    try {
      const db = await this.checkpointStorageSyncService.getUserDatabase(did);
      const result = await this.loadSessionMessages(db, sessionId);
      const feedbackByMessageId = listMessageFeedback(db, sessionId);

      return {
        capabilities: { messageFeedback: true },
        messages: result.messages.map((message) => {
          const feedback = feedbackByMessageId.get(message.id);
          return message.type === 'ai' && feedback
            ? { ...message, feedback }
            : message;
        }),
      };
    } finally {
      this.checkpointStorageSyncService.markUserInactive(did);
    }
  }

  public async setMessageFeedback(params: {
    did: string;
    sessionId: string;
    messageId: string;
    feedback: MessageFeedback;
  }): Promise<MessageFeedbackResponse> {
    const { did, sessionId, messageId, feedback } = params;
    this.checkpointStorageSyncService.markUserActive(did);

    try {
      const db = await this.checkpointStorageSyncService.getUserDatabase(did);
      await this.assertMessageFeedbackTarget(db, sessionId, messageId);

      return saveMessageFeedback(db, { sessionId, messageId, feedback });
    } finally {
      this.checkpointStorageSyncService.markUserInactive(did);
    }
  }

  public async clearMessageFeedback(params: {
    did: string;
    sessionId: string;
    messageId: string;
  }): Promise<MessageFeedbackResponse> {
    const { did, sessionId, messageId } = params;
    this.checkpointStorageSyncService.markUserActive(did);

    try {
      const db = await this.checkpointStorageSyncService.getUserDatabase(did);
      await this.assertMessageFeedbackTarget(db, sessionId, messageId);
      return clearPersistedMessageFeedback(db, { sessionId, messageId });
    } finally {
      this.checkpointStorageSyncService.markUserInactive(did);
    }
  }

  private async loadSessionMessages(
    db: DatabaseType,
    sessionId: string,
  ): Promise<ListOracleMessagesResponse> {
    const saver = SqliteSaver.fromDatabase(db);
    const rows = db
      .prepare(
        `SELECT message FROM messages
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId, '') as { message: Buffer | string }[];
    const messages: BaseMessage[] = await Promise.all(
      rows.map((row) => saver.serde.loadsTyped('json', row.message)),
    );

    return transformGraphStateMessageToListMessageResponse(messages);
  }

  private async assertMessageFeedbackTarget(
    db: DatabaseType,
    sessionId: string,
    messageId: string,
  ): Promise<MessageDto> {
    const { messages } = await this.loadSessionMessages(db, sessionId);
    return validateMessageFeedbackTarget(db, sessionId, messageId, messages);
  }

  public async sendMessage(
    params: SendMessagePayload & {
      res?: Response;
      clientType?: 'matrix' | 'slack';
      msgFromMatrixRoom?: boolean;
      overrideLangchainThreadId?: string;
      req?: Request;
      /**
       * Set when the message originates from a group Matrix room.
       * Drives speaker attribution on HumanMessage and triggers
       * channel-memory context injection into the system prompt.
       */
      groupChat?: {
        roomId: string;
        memberCount: number;
        speaker: {
          did: string;
          matrixUserId: string;
          displayName: string;
          eventId: string;
          threadId: string;
        };
      };
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
    // Mark user as active to prevent cron from closing their DB connection
    // Must be set BEFORE prepareForQuery which calls getUserDatabase
    this.checkpointStorageSyncService.markUserActive(params.did);

    try {
      // Run prepareForQuery and oracle token fetch in parallel
      const hasAttachments = !!params.attachments?.length;
      const needsSandbox = hasAttachments && !!params.userMatrixOpenIdToken;

      const [queryResult, oracleToken] = await Promise.all([
        this.prepareForQuery(params),
        needsSandbox
          ? this.oracleOpenIdTokenProvider
              .getToken()
              .catch((error: unknown) => {
                Logger.warn(
                  `Failed to get oracle token: ${error instanceof Error ? error.message : String(error)}`,
                  'MessagesService',
                );
                return undefined;
              })
          : Promise.resolve(undefined),
      ]);

      const {
        runnableConfig,
        sessionId,
        roomId,
        homeServerName,
        userContext,
        targetSession,
      } = queryResult;

      // ── Portal approval gate interception ───────────────────────
      // Check if this message is a response to a pending approval.
      // Only check for portal clients (Matrix is handled in handleMessage).
      if (!params.msgFromMatrixRoom && roomId && this.approvalService) {
        const classification = await this.tryHandleApprovalResponse(
          params.message,
          params.did,
          roomId,
        );
        if (classification) {
          Logger.log(
            `[ApprovalGate] Portal message handled as approval response (${classification.decision})`,
          );
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

      // Build messages array: user text message + separate file messages
      const msgFromMatrixRoom = params.msgFromMatrixRoom ?? false;
      const timestamp = new Date().toISOString();
      const groupSpeaker = params.groupChat?.speaker;
      const inputMessages: HumanMessage[] = [
        new HumanMessage({
          content: params.message,
          additional_kwargs: {
            msgFromMatrixRoom,
            timestamp,
            ...(groupSpeaker && {
              senderDid: groupSpeaker.did,
              senderMatrixUserId: groupSpeaker.matrixUserId,
              senderDisplayName: groupSpeaker.displayName,
              matrixEventId: groupSpeaker.eventId,
              matrixThreadId: groupSpeaker.threadId,
              isGroupChat: true,
            }),
          },
        }),
      ];

      // If we're in a group room, build a one-shot context block from channel
      // memory + recent room messages and stash it on runnableConfig. The
      // graph layer (createMainAgent) will append it to the system prompt and
      // register channel-memory tools. The roomId itself already lives on
      // runnableConfig.configurable.configs.matrix.roomId — don't duplicate.
      if (params.groupChat) {
        try {
          const contextBlock =
            await this.channelMemoryService.buildSessionContext(
              params.groupChat.roomId,
              this.matrixManager,
            );
          (
            runnableConfig.configurable as Record<string, unknown>
          ).groupChatContext = contextBlock;
        } catch (err) {
          Logger.warn(
            `[MessagesService] Failed to build group-chat context: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (hasAttachments) {
        Logger.log(
          `sendMessage: ${params.attachments!.length} attachment(s) received for session ${sessionId}, room ${roomId}`,
          'MessagesService',
        );

        // Build sandbox config using pre-fetched oracle token and cached homeServer
        let sandboxConfig: SandboxUploadConfig | undefined;
        if (oracleToken && params.userMatrixOpenIdToken) {
          try {
            sandboxConfig = {
              sandboxMcpUrl: this.config.getOrThrow<string>('SANDBOX_MCP_URL'),
              userToken: params.userMatrixOpenIdToken,
              oracleToken,
              homeServerName,
              oracleHomeServerUrl: this.oracleMatrixBaseUrl.replace(
                /^https?:\/\//,
                '',
              ),
            };
          } catch (error) {
            Logger.warn(
              `Failed to build sandbox config: ${error instanceof Error ? error.message : String(error)}`,
              'MessagesService',
            );
          }
        }

        const { texts, metadata, totalUsage } =
          await this.fileProcessingService.processAttachments(
            params.attachments!,
            roomId,
            sandboxConfig,
          );

        // Deduct credits for file processing API calls
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
            // Non-blocking: file was already processed, log and continue
            Logger.warn(
              `[FileProcessing] Failed to deduct credits: ${error instanceof Error ? error.message : String(error)}`,
              'MessagesService',
            );
          }
        }

        Logger.log(
          `sendMessage: attachments processed — ${texts.length} text result(s), creating separate messages`,
          'MessagesService',
        );
        texts.forEach((text, i) => {
          const meta = metadata[i];
          // Prepend source reference so the agent can use process_file
          // with the correct eventId/url if it needs to re-process later
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
                ...(groupSpeaker && {
                  senderDid: groupSpeaker.did,
                  senderMatrixUserId: groupSpeaker.matrixUserId,
                  senderDisplayName: groupSpeaker.displayName,
                  matrixEventId: groupSpeaker.eventId,
                  matrixThreadId: groupSpeaker.threadId,
                  isGroupChat: true,
                }),
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
        // Set SSE headers
        setSSEHeaders(params.res, runnableConfig.configurable.requestId);
        params.res.flushHeaders();

        // Start heartbeat to keep connection alive
        const heartbeat = startSSEHeartbeat(params.res);

        // Create abort signal for request cancellation
        const abortController = new AbortController();

        // Abort any existing request for this session (only one request per session at a time)
        const existingController = this.abortControllers.get(sessionId);
        if (existingController) {
          Logger.debug(`Aborting existing request for session ${sessionId}`);
          existingController.abort();
        }

        // Register abort controller for this session
        this.abortControllers.set(sessionId, abortController);

        // Listen for client disconnection - Response 'close' event is most reliable
        const onClose = () => {
          Logger.debug(
            `[MessagesService] Client disconnected, aborting stream. Signal already aborted: ${abortController.signal.aborted}`,
          );
          abortController.abort();
          Logger.debug(
            `[MessagesService] After abort(), signal.aborted: ${abortController.signal.aborted}`,
          );
        };

        // Listen to response close event (fires when client disconnects/aborts)
        params.res.on('close', onClose);

        try {
          await runWithSSEContext(
            params.res,
            async () => {
              // send thinking event to give the user faster feedback
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
                // UCAN options for MCP tool authorization
                ucanOptions: {
                  ucanService: this.ucanService,
                  mcpInvocations: params.mcpInvocations,
                },
                blobStore: this.blobStore,
                fileProcessingService: this.fileProcessingService,
                spaceId: params.metadata?.spaceId,
                tasksService: this.tasksService,
              });

              let fullContent = '';
              if (params.sessionId) {
                const toolCallMap = new Map<string, ToolCallEvent>();
                const actionCallMap = new Map<string, ActionCallEvent>();
                // Get list of AG-UI action names for quick lookup
                const agActionNames = new Set(
                  (params.agActions ?? []).map((action) => action.name),
                );

                Logger.log(
                  `[streamMessage] AG-UI actions registered: ${Array.from(agActionNames).join(', ') || 'none'}`,
                );

                // eslint-disable-next-line no-useless-catch
                try {
                  for await (const { data, event, tags: _tags } of stream) {
                    const isChatNode = true;

                    if (event === 'on_tool_end') {
                      const toolMessage = data.output as ToolMessage;

                      // Check if this is an AG-UI action completion
                      const actionCallEvent = actionCallMap.get(
                        toolMessage.tool_call_id,
                      );

                      if (actionCallEvent) {
                        actionCallEvent.payload.output = emojify(
                          toolMessage.content as string,
                        );
                        actionCallEvent.payload.toolCallId =
                          toolMessage.tool_call_id;

                        // Check if the tool message content indicates an error
                        try {
                          const resultContent =
                            typeof toolMessage.content === 'string'
                              ? JSON.parse(toolMessage.content)
                              : toolMessage.content;

                          // Set status based on whether there's an error
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
                          // If we can't parse, assume success
                          actionCallEvent.payload.status = 'done';
                        }

                        if (!params.res) {
                          throw new Error('Response not found');
                        }
                        // Send action call completion event as SSE
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
                        // Normal tool call handling
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
                        toolCallEvent.payload.eventId =
                          toolMessage.tool_call_id;
                        if (!params.res) {
                          throw new Error('Response not found');
                        }
                        // Send tool call completion event as SSE
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
                      const content = (data.chunk as AIMessageChunk).content;
                      const toolCall = (data.chunk as AIMessageChunk)
                        .tool_calls;

                      // Extract reasoning tokens from raw response
                      const rawResponse = (data.chunk as AIMessageChunk)
                        .additional_kwargs?.__raw_response as
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
                      if (reasoning && isChatNode) {
                        if (reasoning && reasoning.trim()) {
                          // Use cleanAdditionalKwargs to extract and clean reasoning details
                          const cleanedKwargs = cleanAdditionalKwargs(
                            (data.chunk as AIMessageChunk).additional_kwargs,
                            params.msgFromMatrixRoom ?? false,
                          );

                          const reasoningEvent = ReasoningEvent.createChunk(
                            sessionId,
                            runnableConfig.configurable.requestId ?? '',
                            reasoning,
                            cleanedKwargs.reasoningDetails,
                            false, // Not complete yet
                          );

                          // Send reasoning chunk as SSE
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
                      }

                      toolCall?.forEach((tool) => {
                        // update toolCallEvent with toolCall
                        if (!tool.name.trim() || !tool.id) {
                          return;
                        }

                        Logger.log(
                          `[streamMessage] Tool call detected: ${tool.name}, isAgAction: ${agActionNames.has(tool.name)}`,
                        );

                        // Check if this is an AG-UI action
                        if (agActionNames.has(tool.name)) {
                          // Create ActionCallEvent for SSE status update (no args - sent via WebSocket only)
                          const actionCallEvent = new ActionCallEvent({
                            requestId:
                              runnableConfig.configurable.requestId ?? '',
                            sessionId,
                            toolCallId: tool.id,
                            toolName: tool.name,
                            args: undefined, // Args sent via WebSocket only, not SSE
                            status: 'isRunning',
                          });

                          // Send action call start event as SSE
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
                          // Normal tool call handling
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

                          // Send tool call start event as SSE
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
                        // Send message chunk as SSE
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

                  // Only send to Matrix if not aborted
                  if (!abortController.signal.aborted && fullContent) {
                    Logger.debug(
                      `[MessagesService] Sending AI response to Matrix (${fullContent.length} chars)`,
                    );
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
                  } else {
                    Logger.debug(
                      `[MessagesService] Skipping Matrix send - aborted: ${abortController.signal.aborted}, content length: ${fullContent.length}`,
                    );
                  }
                } catch (innerError) {
                  throw innerError;
                }
              }

              // Send completion event only if not aborted
              if (!abortController.signal.aborted) {
                if (!params.res) {
                  throw new Error('Response not found');
                }

                // Send reasoning completion event
                const reasoningCompleteEvent = ReasoningEvent.createChunk(
                  sessionId,
                  runnableConfig.configurable.requestId ?? '',
                  '', // Empty reasoning for completion
                  undefined,
                  true, // Mark as complete
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

                // Increment ref count BEFORE firing background task so
                // the outer finally's markUserInactive doesn't drop to 0
                // while performPostMessageSync still accesses the DB.
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
          // Handle abort errors gracefully - don't treat as error
          if (
            error instanceof Error &&
            (error.name === 'AbortError' ||
              error.message.includes('aborted') ||
              error.message.includes('Stream aborted by client'))
          ) {
            Logger.debug(
              '[MessagesService] Stream aborted by client, exiting cleanly',
            );

            if (!params.res.writableEnded) {
              sendSSEDone(params.res);
            }
            return;
          }

          // Only log and send error if it's not an abort
          Logger.error('Failed to stream message', error);
          Logger.error(
            `Error stack trace: ${error instanceof Error ? error.stack : 'No stack trace'}`,
          );
          if (!params.res.writableEnded && !abortController.signal.aborted) {
            sendSSEError(
              params.res,
              error instanceof Error ? error : 'Something went wrong',
            );
            sendSSEDone(params.res);
          }
        } finally {
          // Clear heartbeat and end response
          clearInterval(heartbeat);
          // Remove listener
          params.res.off('close', onClose);
          // Cleanup abort controller from registry
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
        // UCAN options for MCP tool authorization
        ucanOptions: {
          ucanService: this.ucanService,
          mcpInvocations: params.mcpInvocations,
        },
        blobStore: this.blobStore,
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

      // Increment ref count BEFORE firing background task so
      // the outer finally's markUserInactive doesn't drop to 0
      // while performPostMessageSync still accesses the DB.
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
      // Mark user inactive so cron can safely manage their DB
      // Covers both streaming and non-streaming paths
      this.checkpointStorageSyncService.markUserInactive(params.did);
    }
  }

  /**
   * Fire-and-forget session synchronization after a message is sent.
   * Loads the latest session messages, persists them (plus oracle metadata and
   * lastProcessedCount) via SessionManagerService.
   */
  private performPostMessageSync(
    params: SendMessagePayload,
    sessionId: string,
    roomId: string,
    targetSession: ChatSession,
  ): void {
    // Run in background without blocking
    void Promise.resolve().then(async () => {
      try {
        const { messages: currentMessages } = await this.listMessages({
          did: params.did,
          sessionId,
          homeServer: params.homeServer,
        });
        // Sync session (fire-and-forget)
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

        // Note: Title updates are now handled by syncSessionSet when messages.length > 2
      } catch (error) {
        Logger.error('Failed to perform post-message sync:', error);
        // Don't throw - this is fire-and-forget
      } finally {
        this.checkpointStorageSyncService.markUserInactive(params.did);
      }
    });
  }

  /**
   * Abort an ongoing stream request by sessionId
   */
  public abortRequest(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
      Logger.debug(`Aborted request for session ${sessionId}`);
      return true;
    }
    Logger.debug(`No active request found for session ${sessionId}`);
    return false;
  }

  /**
   * Extract timezone from payload (body) or request headers (fallback)
   * Body takes priority for backward compatibility with backends that don't support custom headers
   */
  private getTimezoneFromRequest(
    payload?: SendMessagePayload,
    req?: Request,
  ): string | undefined {
    // First check payload (body) - this is the primary source
    if (payload?.timezone) {
      return payload.timezone.trim() || undefined;
    }

    // Fallback to header if payload doesn't have it
    if (!req) {
      return undefined;
    }

    const timezoneHeader = req.headers['x-timezone'];
    if (!timezoneHeader) {
      return undefined;
    }

    // Handle both string and array formats
    const timezone =
      typeof timezoneHeader === 'string'
        ? timezoneHeader
        : Array.isArray(timezoneHeader)
          ? timezoneHeader[0]
          : undefined;

    return timezone?.trim() || undefined;
  }

  /**
   * Calculate current time in the user's timezone
   */
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
      // Fallback to UTC if timezone is invalid
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
    userContext?: TMainAgentGraphState['userContext'];
    targetSession: ChatSession; // For post-message sync
  }> {
    const did = payload.did;
    const sessionId = payload.sessionId;
    const requestId =
      payload.stream && 'requestId' in payload
        ? (payload.requestId as string)
        : crypto.randomUUID();

    // Resolve homeServer once — used for room lookup and config
    const homeServerName =
      payload.homeServer || (await getMatrixHomeServerCroppedForDid(did));

    // Run sync and session lookup in parallel — they're independent
    const [, targetSession] = await Promise.all([
      this.checkpointStorageSyncService.syncLocalStorageFromMatrixStorage({
        userDid: did,
      }),
      this.sessionManagerService.getSession(sessionId, did, false),
    ]);

    if (!targetSession) {
      throw new NotFoundException('Session not found');
    }

    // Use cached roomId if available, otherwise fetch it
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

    // Extract timezone and calculate current time
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
            matrixOpenIdToken: payload.userMatrixOpenIdToken,
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
      userContext: targetSession?.userContext,
      targetSession,
    };
  }
}
