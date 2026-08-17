import { SessionManagerService, type ChatSession } from '@ixo/common';
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
import * as crypto from 'node:crypto';
import { normalizeDid } from '../../config/normalize-did.js';
import { workStatusProducer } from '../../matrix/work-status-producer.js';
import { lruInsert } from '../../utils/lru.js';
import type { CommerceContext } from '../../plugin-api/types.js';
import { MessageRouterService } from './message-router.service.js';

const FILE_MSGTYPES = new Set(['m.file', 'm.image', 'm.video', 'm.audio']);
const DEBOUNCE_MS = 500;
/** Max wait for a superseded turn to settle before dispatching the new one. */
const SUPERSEDE_DRAIN_MS = 3_000;
/** Matrix typing notifications expire ~30s; refresh well inside that. */
const TYPING_REFRESH_MS = 20_000;
/** Capped LRU of already-handled event ids (homeserver re-delivery guard). */
const PROCESSED_EVENTS_CAP = 500;
/** Cap on the eventId → thread-root memo (two short strings per entry). */
const THREAD_ROOT_CACHE_CAP = 5_000;

/**
 * Spec-standard `m.relates_to` payload. Two shapes matter here:
 *   - a thread relation — `rel_type: 'm.thread'` plus the thread root's
 *     `event_id`; clients that thread natively send this
 *   - a reply-chain pointer — a bare `m.in_reply_to`
 *
 * They co-occur: a threaded client also sets `m.in_reply_to` (with
 * `is_falling_back`) at the *newest* message in the thread so non-threaded
 * clients render something sensible. That pointer is not the thread root.
 */
export interface MatrixRelatesTo {
  rel_type?: string;
  event_id?: string;
  is_falling_back?: boolean;
  'm.in_reply_to'?: { event_id: string };
}

/**
 * Matrix text-event content. Spec-standard fields the base
 * `MessageEventContent` type from `@ixo/matrix` doesn't enumerate:
 *   - `m.mentions` — explicit mention list (since MSC3952)
 *   - `m.relates_to` — thread relation / reply chain pointer
 */
interface MatrixTextContent extends MessageEventContent {
  'm.mentions'?: { user_ids?: string[] };
  'm.relates_to'?: MatrixRelatesTo;
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
  relatesTo?: MatrixRelatesTo;
  attachments?: Array<{
    eventId: string;
    filename: string;
    mimetype: string;
    size?: number;
  }>;
  /**
   * Per-turn abort controller, constructed by `flush()`. Aborting it cancels
   * the turn's LangGraph run end-to-end — the signal travels through the
   * delivery into the invoke config and `RuntimeContext.abortSignal`.
   */
  abortController: AbortController;
  /**
   * Bridge-minted per-turn request id. Reused by the request preparer so the
   * `work_status` card, the runnable config, and `ctx.session.requestId`
   * agree for the whole turn.
   */
  requestId: string;
  /** Commerce routing outcome — set only when the commerce router is active. */
  commerce?: CommerceContext;
}

interface InFlightTurn {
  requestId: string;
  controller: AbortController;
  /** The turn's coalesced user text — prepended to a superseding turn. */
  userText: string;
  /** Resolves when the turn's delivery settles (bounded-drain target). */
  settled: Promise<void>;
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
  /**
   * eventId → thread-root memo for reply-chain resolution. Written on every
   * inbound message, so it MUST be capped (like `processedEventIds` below) —
   * an evicted entry just means a later deep reply re-walks the chain via
   * the Matrix API instead of hitting the memo.
   */
  private readonly threadRootCache = new Map<string, string>();
  private readonly buffer = new Map<string, BufferEntry>();
  /**
   * One entry per in-flight turn, keyed by sessionId (= thread root). A new
   * flush for the same session aborts + drains the old turn and prepends its
   * unanswered text (double-text supersede). Purely in-process — the Matrix
   * sync loop is single-instance per oracle.
   */
  private readonly inFlight = new Map<string, InFlightTurn>();
  /**
   * Insertion-ordered Set as a capped LRU of handled event ids, so a
   * homeserver re-delivering an event can't double-answer the user.
   */
  private readonly processedEventIds = new Set<string>();
  private readonly matrixManager: MatrixManager;
  private deliverHandler:
    | ((msg: MatrixIncomingMessage) => Promise<unknown>)
    | null = null;
  private roomSessionResolver:
    | ((roomId: string) => Promise<string | undefined>)
    | null = null;

  constructor(
    private readonly sessions: SessionManagerService,
    private readonly config: ConfigService,
    private readonly router: MessageRouterService,
  ) {
    this.matrixManager = this.sessions.matrixManger;
  }

  /** Register the callback invoked once a debounced thread batch is ready. */
  setDeliverHandler(
    handler: (msg: MatrixIncomingMessage) => Promise<unknown>,
  ): void {
    this.deliverHandler = handler;
  }

  /**
   * Optionally pin every message in a room to a single session, bypassing
   * reply-chain thread resolution. A plugin that owns a room (e.g. the tasks
   * plugin's dedicated task rooms) registers this so a plainly-typed reply
   * continues that room's bound session — no quote-reply required. Returning
   * `undefined` for a room falls back to normal thread-root resolution.
   */
  setRoomSessionResolver(
    resolver: (roomId: string) => Promise<string | undefined>,
  ): void {
    this.roomSessionResolver = resolver;
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
    for (const [, turn] of this.inFlight) turn.controller.abort();
    this.inFlight.clear();
    this.threadRootCache.clear();
    this.cleanUpListener?.();
  }

  /**
   * Record an event id as handled. Returns `false` when the id was already
   * seen — the caller drops the event (homeserver re-delivery).
   */
  private markProcessed(eventId: string): boolean {
    if (this.processedEventIds.has(eventId)) return false;
    this.processedEventIds.add(eventId);
    if (this.processedEventIds.size > PROCESSED_EVENTS_CAP) {
      const oldest = this.processedEventIds.values().next().value;
      if (oldest !== undefined) this.processedEventIds.delete(oldest);
    }
    return true;
  }

  /** Insert into the thread-root memo, evicting oldest entries past the cap. */
  private cacheThreadRoot(eventId: string, root: string): void {
    lruInsert(this.threadRootCache, eventId, root, THREAD_ROOT_CACHE_CAP);
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
    const isFile = typeof msgtype === 'string' && FILE_MSGTYPES.has(msgtype);
    if (!isText && !isFile) return;

    if (event.eventId && !this.markProcessed(event.eventId)) {
      this.logger.debug(
        `Skipping already-processed eventId=${event.eventId} (re-delivery)`,
      );
      return;
    }

    // A plugin that owns this room can pin it to one session — every message
    // there continues that bound session, skipping reply-chain resolution.
    const boundSession = this.roomSessionResolver
      ? await this.roomSessionResolver(roomId).catch((err) => {
          this.logger.warn(
            `roomSessionResolver failed for ${roomId}: ${(err as Error).message}`,
          );
          return undefined;
        })
      : undefined;

    const threadId = boundSession ?? (await this.getThreadRoot(event, roomId));
    if (!threadId) {
      this.logger.warn(
        `No thread root for eventId=${event.eventId} roomId=${roomId}`,
      );
      return;
    }

    // The bound session id IS the langchain thread; only read the thread-root
    // event's `sessionId` when we resolved via the reply chain.
    const langchainThreadId = boundSession
      ? undefined
      : (
          (await this.matrixManager.getEventById(roomId, threadId)).content as {
            sessionId?: string;
          }
        )?.sessionId;
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
        // Anchor the session at the THREAD ROOT, not this event. They're the
        // same for a plain message, but when the user quote-replies to a
        // message that isn't itself a session root (e.g. a worker-posted task
        // approval prompt), the root differs — and `prepare()` looks the
        // session up by the root, so creating it under `event.eventId` here
        // would 404 with "Session not found".
        sessionId,
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

    const messageRAW =
      text ??
      (attachments.length === 1
        ? `User shared a file: ${attachments[0]?.filename ?? 'file'}`
        : `User shared ${attachments.length} file(s): ${attachments.map((a) => a.filename).join(', ')}`);

    const message = messageRAW.replace(
      this.config.getOrThrow('MATRIX_ORACLE_ADMIN_USER_ID'),
      '(USER MENTIONED YOU @AI_AGENT)',
    );

    if (!this.deliverHandler) {
      this.logger.warn(
        'MatrixListenerBridge.flush: deliverHandler not set; dropping message',
      );
      return;
    }

    // One controller per delivered turn so the run can be cancelled while
    // in flight (the HTTP path gets the same per-turn controller from the
    // SSE stream runner).
    const abortController = new AbortController();
    const requestId = crypto.randomUUID();

    // Double-texting supersede: a new message into a thread whose turn is
    // still running kills that turn, waits (bounded) for it to settle, flips
    // its status card to `superseded`, and prepends its unanswered text so
    // nothing the user said is lost.
    let turnMessage = message;
    const prior = this.inFlight.get(threadId);
    if (prior) {
      this.inFlight.delete(threadId);
      prior.controller.abort();
      await Promise.race([prior.settled, delay(SUPERSEDE_DRAIN_MS)]);
      workStatusProducer.finish(prior.requestId, 'superseded');
      turnMessage = `${prior.userText}\n${turnMessage}`;
      this.logger.log(
        `Superseded in-flight turn requestId=${prior.requestId} for threadId=${threadId}`,
      );
    }

    // Every Matrix turn gets a liveness card, commerce or not. Registering
    // the turn and posting the opening beat here — before any routing work —
    // is what makes the room show progress from the instant the message
    // lands, and gives every later phase an anchor event to replace.
    workStatusProducer.beginTurn({
      requestId,
      roomId: first.roomId,
      threadId,
      sessionId: threadId,
      forEventId: eventId ?? threadId,
    });
    workStatusProducer.emit(requestId, 'routing');

    // Commerce routing — Matrix-only, inert unless the oracle-payments
    // plugin registered its port.
    let commerce: CommerceContext | undefined;
    if (this.router.isActive()) {
      commerce = await this.router.route({
        roomId: first.roomId,
        threadId,
        senderDid: did,
        text: turnMessage,
      });
    }

    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.inFlight.set(threadId, {
      requestId,
      controller: abortController,
      userText: turnMessage,
      settled,
    });

    const typingClient = this.matrixManager.getClient()?.mxClient;
    let typingKeepalive: NodeJS.Timeout | undefined;
    try {
      await typingClient?.setTyping(first.roomId, true);
      // Typing notifications expire server-side (~30s); a long turn needs
      // periodic refreshes or the indicator drops mid-run.
      typingKeepalive = setInterval(() => {
        typingClient?.setTyping(first.roomId, true).catch(() => undefined);
      }, TYPING_REFRESH_MS);

      const aiResponse = (await this.deliverHandler({
        did,
        message: turnMessage,
        threadId,
        langchainThreadId,
        roomId: first.roomId,
        homeServer,
        senderMatrixUserId,
        eventId,
        abortController,
        requestId,
        ...(commerce && { commerce }),
        ...(mentions && { mentions }),
        ...(relatesTo && { relatesTo }),
        ...(attachments.length > 0 && { attachments }),
      })) as undefined | { message: { type: string; content: string } };

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

      workStatusProducer.emit(requestId, 'delivering');
      await this.matrixManager.sendMessage({
        message: aiResponse.message.content,
        roomId: first.roomId,
        threadId,
        isOracleAdmin: true,
        disablePrefix: true,
      });
      workStatusProducer.finish(requestId, 'done');
    } catch (error) {
      this.logger.error('Failed to handle Matrix message', error);
    } finally {
      if (typingKeepalive) clearInterval(typingKeepalive);
      // Close the card on every exit — thrown error, no AI response, or a
      // reply that was skipped — so no turn can leave a spinner running in
      // the room. `finish` unregisters the turn, so the success path above
      // has already consumed this and the call is a no-op there. The one
      // turn whose card is left alone is a superseded one: the newer flush
      // flipped it to `superseded` and that is its terminal state.
      if (!abortController.signal.aborted) {
        workStatusProducer.finish(requestId, 'done');
      } else {
        // Aborted turns must still unregister: supersede already did (its
        // `finish` posted the terminal card — this is a no-op there), but a
        // user-cancel abort otherwise leaves the entry in the producer's
        // turn map forever.
        workStatusProducer.endTurn(requestId);
      }
      const current = this.inFlight.get(threadId);
      if (current?.requestId === requestId) this.inFlight.delete(threadId);
      settle();
      await typingClient?.setTyping(first.roomId, false).catch(() => undefined);
    }
  }

  private async getThreadRoot(
    event: MessageEvent<
      MessageEventContent & { 'm.relates_to'?: MatrixRelatesTo }
    >,
    roomId: string,
  ): Promise<string | undefined> {
    const eventId = event.eventId;
    if (!eventId) return undefined;
    const relatesTo = event.content['m.relates_to'];
    // A thread relation names its root outright — take it and skip the walk.
    // Falling through to the reply chain would root the thread on this event,
    // and a homeserver refuses to root a thread on an event that already
    // carries a relation ("Cannot start threads from an event with a
    // relation"), failing every send for the rest of the turn. The sibling
    // `m.in_reply_to` points at the newest message in the thread, not the
    // root, so it must not win here.
    if (relatesTo?.rel_type === 'm.thread' && relatesTo.event_id) {
      this.cacheThreadRoot(eventId, relatesTo.event_id);
      return relatesTo.event_id;
    }
    const inReplyTo = relatesTo?.['m.in_reply_to']?.event_id;
    if (!inReplyTo) {
      this.cacheThreadRoot(eventId, eventId);
      return eventId;
    }
    if (this.threadRootCache.has(inReplyTo)) {
      const root = this.threadRootCache.get(inReplyTo);
      if (!root) return undefined;
      this.cacheThreadRoot(eventId, root);
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
        pathToCache.forEach((id) => this.cacheThreadRoot(id, root));
        return root;
      }
      const parent = await this.matrixManager.getEventById<{
        'm.relates_to'?: MatrixRelatesTo;
      }>(roomId, cursor);
      const parentRelatesTo = parent.content['m.relates_to'];
      // Quote-reply aimed at a message that itself lives in a thread: that
      // thread's root is the root, and `cursor` is unusable as one.
      if (
        parentRelatesTo?.rel_type === 'm.thread' &&
        parentRelatesTo.event_id
      ) {
        const root = parentRelatesTo.event_id;
        pathToCache.forEach((id) => this.cacheThreadRoot(id, root));
        return root;
      }
      const parentReply = parentRelatesTo?.['m.in_reply_to']?.event_id;
      if (!parentReply) {
        pathToCache.forEach((id) => this.cacheThreadRoot(id, cursor));
        return cursor;
      }
      cursor = parentReply;
    }
    const fallback = cursor || eventId;
    pathToCache.forEach((id) => this.cacheThreadRoot(id, fallback));
    return fallback;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
