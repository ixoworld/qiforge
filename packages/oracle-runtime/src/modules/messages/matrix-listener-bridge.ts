import {
  SessionManagerService,
  type ChatSession,
} from '@ixo/common';
import {
  type MatrixManager,
  type MessageEvent,
  type MessageEventContent,
} from '@ixo/matrix';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const FILE_MSGTYPES = new Set(['m.file', 'm.image', 'm.video', 'm.audio']);
const DEBOUNCE_MS = 500;

/**
 * Matrix text-event content. Spec-standard fields the base
 * `MessageEventContent` type from `@ixo/matrix` doesn't enumerate:
 *   - `m.mentions` — explicit mention list (since MSC3952)
 *   - `m.relates_to.m.in_reply_to` — reply chain pointer
 */
interface MatrixTextContent extends MessageEventContent {
  'm.mentions'?: { user_ids?: string[] };
  'm.relates_to'?: { 'm.in_reply_to'?: { event_id: string } };
}

interface BufferedEvent {
  event: MessageEvent<MessageEventContent>;
  roomId: string;
}

interface BufferEntry {
  events: BufferedEvent[];
  timer: NodeJS.Timeout;
}

export interface MatrixIncomingMessage {
  did: string;
  message: string;
  threadId: string;
  langchainThreadId?: string;
  roomId: string;
  homeServer?: string;
  /** Sender's full Matrix user id (e.g. `@alice:matrix.example`). */
  senderMatrixUserId?: string;
  /** Matrix event id of the latest text event being delivered. */
  eventId?: string;
  /** Raw `m.mentions` payload from the event, if present. */
  mentions?: { user_ids?: string[] };
  /** Raw `m.relates_to` payload from the event, if present. */
  relatesTo?: { 'm.in_reply_to'?: { event_id: string } };
  attachments?: Array<{
    eventId: string;
    filename: string;
    mimetype: string;
    size?: number;
  }>;
}

/**
 * Bridges Matrix room events into chat turns. Handles:
 *
 *   - Ignoring own (oracle) messages and INTERNAL events
 *   - Thread-root resolution with caching (a Matrix reply chain → session)
 *   - Per-thread debounce so text + file pairs land as one turn
 *   - Session bootstrap when the sender doesn't have one yet
 *
 * The bridge owns the listener registration. The caller (MessagesService)
 * supplies a callback that turns a debounced thread batch into a chat
 * invocation — this keeps the bridge ignorant of the runtime/graph layer.
 */
@Injectable()
export class MatrixListenerBridge implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatrixListenerBridge.name);
  private cleanUpListener?: () => void;
  private readonly threadRootCache = new Map<string, string>();
  private readonly buffer = new Map<string, BufferEntry>();
  private readonly matrixManager: MatrixManager;
  private deliverHandler: ((msg: MatrixIncomingMessage) => Promise<unknown>) | null = null;

  constructor(
    private readonly sessions: SessionManagerService,
    private readonly config: ConfigService,
  ) {
    this.matrixManager = this.sessions.matrixManger;
  }

  /** Register the callback invoked once a debounced thread batch is ready. */
  setDeliverHandler(
    handler: (msg: MatrixIncomingMessage) => Promise<unknown>,
  ): void {
    this.deliverHandler = handler;
  }

  onModuleInit(): void {
    this.matrixManager
      .init()
      .then(() => {
        this.cleanUpListener = this.matrixManager.onMessage((roomId, event) => {
          this.handleMessage(event, roomId).catch((err) =>
            this.logger.error('Matrix listener failed', err),
          );
        });
        this.logger.log('Matrix message listener registered');
      })
      .catch((err) =>
        this.logger.error('Failed to set up Matrix listener', err),
      );
  }

  onModuleDestroy(): void {
    for (const [, entry] of this.buffer) clearTimeout(entry.timer);
    this.buffer.clear();
    this.cleanUpListener?.();
  }

  private async handleMessage(
    event: MessageEvent<MessageEventContent>,
    roomId: string,
  ): Promise<void> {
    const did = normalizeDid(event.sender);
    const oracleDid = this.config.getOrThrow<string>('ORACLE_DID');
    if (did === oracleDid) return;
    if ('INTERNAL' in event.content) return;

    const msgtype = event.content.msgtype;
    const isText =
      msgtype === 'm.text' &&
      'body' in event.content &&
      typeof event.content.body === 'string';
    const isFile =
      typeof msgtype === 'string' && FILE_MSGTYPES.has(msgtype);
    if (!isText && !isFile) return;

    const threadId = await this.getThreadRoot(event, roomId);
    if (!threadId) {
      this.logger.warn(
        `No thread root for eventId=${event.eventId} roomId=${roomId}`,
      );
      return;
    }

    const threadEv = await this.matrixManager.getEventById(roomId, threadId);
    const langchainThreadId = (threadEv.content as { sessionId?: string })
      ?.sessionId;
    const sessionId = threadId;

    await this.ensureSession(did, sessionId, event, roomId);

    const existing = this.buffer.get(threadId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push({ event, roomId });
    } else {
      this.buffer.set(threadId, {
        events: [{ event, roomId }],
        timer: null as unknown as NodeJS.Timeout,
      });
    }
    const entry = this.buffer.get(threadId)!;
    entry.timer = setTimeout(() => {
      this.flush(threadId, langchainThreadId).catch((err) =>
        this.logger.error(`Flush failed for thread ${threadId}`, err),
      );
    }, DEBOUNCE_MS);
  }

  private async ensureSession(
    did: string,
    sessionId: string,
    event: MessageEvent<MessageEventContent>,
    roomId: string,
  ): Promise<void> {
    let hasSession: ChatSession | undefined;
    try {
      hasSession = await this.sessions.getSession(sessionId, did, false);
    } catch (err) {
      this.logger.error(
        `Error checking session did=${did} sessionId=${sessionId}`,
        err,
      );
    }
    if (hasSession) return;

    const userHomeServer = event.sender.split(':').slice(1).join(':');

    try {
      await this.sessions.createSession(
        {
          did,
          oracleDid: this.config.getOrThrow('ORACLE_DID'),
          oracleEntityDid: this.config.getOrThrow('ORACLE_ENTITY_DID'),
          oracleName: this.config.getOrThrow('ORACLE_NAME'),
          homeServer: userHomeServer,
          roomId,
        },
        event.eventId,
      );
    } catch (err) {
      this.logger.error(`createSession failed did=${did}`, err);
      throw err;
    }
  }

  private async flush(
    threadId: string,
    langchainThreadId?: string,
  ): Promise<void> {
    const entry = this.buffer.get(threadId);
    if (!entry) return;
    this.buffer.delete(threadId);

    const first = entry.events[0];
    if (!first) return;

    const did = normalizeDid(first.event.sender);
    const homeServer = first.event.sender.split(':')[1];

    let text: string | undefined;
    let latestTextEvent: BufferedEvent['event'] | undefined;
    const attachments: NonNullable<MatrixIncomingMessage['attachments']> = [];
    for (const { event } of entry.events) {
      const msgtype = event.content.msgtype;
      if (
        msgtype === 'm.text' &&
        'body' in event.content &&
        typeof event.content.body === 'string'
      ) {
        text = event.content.body;
        latestTextEvent = event;
      } else if (typeof msgtype === 'string' && FILE_MSGTYPES.has(msgtype)) {
        attachments.push(buildAttachment(event));
      }
    }

    // Speaker + threading metadata for the downstream HumanMessage. Use the
    // latest text event when available (so mentions / replies refer to the
    // user-visible message), otherwise fall back to the first event in the
    // batch (file-only sends).
    const sourceEvent = latestTextEvent ?? first.event;
    this.logger.debug(
      `flush sourceEvent eventId=${sourceEvent.eventId} sender=${sourceEvent.sender}`,
    );
    const senderMatrixUserId = sourceEvent.sender;
    const eventId = sourceEvent.eventId;
    const sourceContent = sourceEvent.content as MatrixTextContent;
    const mentions = sourceContent['m.mentions'];
    const relatesTo = sourceContent['m.relates_to'];

    const message =
      text ??
      (attachments.length === 1
        ? `User shared a file: ${attachments[0]?.filename ?? 'file'}`
        : `User shared ${attachments.length} file(s): ${attachments.map((a) => a.filename).join(', ')}`);

    if (!this.deliverHandler) {
      this.logger.warn(
        'MatrixListenerBridge.flush: deliverHandler not set; dropping message',
      );
      return;
    }

    try {
      const aiResponse = (await this.deliverHandler({
        did,
        message,
        threadId,
        langchainThreadId,
        roomId: first.roomId,
        homeServer,
        senderMatrixUserId,
        eventId,
        ...(mentions && { mentions }),
        ...(relatesTo && { relatesTo }),
        ...(attachments.length > 0 && { attachments }),
      })) as
        | undefined
        | { message: { type: string; content: string } };

      if (!aiResponse) {
        this.logger.warn(`No AI response returned for threadId=${threadId}`);
        return;
      }

      // The BatchInvoker returns whatever lives at the tail of graph state.
      // When a `beforeAgent` middleware short-circuits with `jumpTo: 'end'`
      // (e.g. the group-chat gate ignoring an un-mentioned room message),
      // no AI message is produced and the tail is the user's own
      // HumanMessage. Posting that back would echo the user to themselves
      // with the speaker-prefix applied.
      if (aiResponse.message.type !== 'ai') {
        this.logger.log(
          `Skipping Matrix reply for threadId=${threadId} — agent did not produce an AI message (tail type=${aiResponse.message.type})`,
        );
        return;
      }

      await this.matrixManager.sendMessage({
        message: aiResponse.message.content,
        roomId: first.roomId,
        threadId,
        isOracleAdmin: true,
        disablePrefix: true,
      });
    } catch (error) {
      this.logger.error('Failed to handle Matrix message', error);
    }
  }

  private async getThreadRoot(
    event: MessageEvent<
      MessageEventContent & {
        'm.relates_to'?: { 'm.in_reply_to'?: { event_id: string } };
      }
    >,
    roomId: string,
  ): Promise<string | undefined> {
    const eventId = event.eventId;
    if (!eventId) return undefined;
    const inReplyTo =
      event.content['m.relates_to']?.['m.in_reply_to']?.event_id;
    if (!inReplyTo) {
      this.threadRootCache.set(eventId, eventId);
      return eventId;
    }
    if (this.threadRootCache.has(inReplyTo)) {
      const root = this.threadRootCache.get(inReplyTo);
      if (!root) return undefined;
      this.threadRootCache.set(eventId, root);
      return root;
    }
    const pathToCache: string[] = [eventId];
    let cursor = inReplyTo;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      pathToCache.push(cursor);
      if (this.threadRootCache.has(cursor)) {
        const root = this.threadRootCache.get(cursor);
        if (!root) return undefined;
        pathToCache.forEach((id) => this.threadRootCache.set(id, root));
        return root;
      }
      const parent = await this.matrixManager.getEventById<{
        'm.relates_to'?: { 'm.in_reply_to'?: { event_id: string } };
      }>(roomId, cursor);
      const parentReply =
        parent.content['m.relates_to']?.['m.in_reply_to']?.event_id;
      if (!parentReply) {
        pathToCache.forEach((id) => this.threadRootCache.set(id, cursor));
        return cursor;
      }
      cursor = parentReply;
    }
    const fallback = cursor || eventId;
    pathToCache.forEach((id) => this.threadRootCache.set(id, fallback));
    return fallback;
  }
}

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

function buildAttachment(event: MessageEvent<MessageEventContent>): {
  eventId: string;
  filename: string;
  mimetype: string;
  size?: number;
} {
  const content = event.content as unknown as Record<string, unknown>;
  const info = content.info as { mimetype?: string; size?: number } | undefined;
  return {
    eventId: event.eventId,
    filename:
      (content.filename as string) ?? (content.body as string) ?? 'file',
    mimetype: info?.mimetype ?? 'application/octet-stream',
    size: info?.size,
  };
}
