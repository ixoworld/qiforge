import { type MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import { type BaseMessage } from '@langchain/core/messages';

/**
 * Group-chat utilities — pure, self-contained.
 *
 * Decides whether the agent should respond to an incoming Matrix event in a
 * group room. DMs are unaffected (always respond). Even when the agent stays
 * silent, the caller is expected to still capture the message into channel
 * memory so summaries stay accurate.
 */

export interface RoomTypeInfo {
  isDirect: boolean;
  memberCount: number;
}

/** Minimal structural type for the incoming Matrix event. */
export interface GuardEvent {
  eventId: string;
  content?: Record<string, unknown> | undefined;
}

export interface ShouldRespondInput {
  event: GuardEvent;
  roomId: string;
  threadId: string;
  matrixManager: MatrixManager;
  /** Bot's Matrix user ID, e.g. `@oracle:matrix.example.org`. */
  botMatrixUserId: string;
  /** Resolved room type. Caller is responsible for caching. */
  roomInfo: RoomTypeInfo;
  /** Active-thread map shared with the middleware. */
  activeBotThreads: Map<string, number>;
  /** TTL to use when re-warming an active-thread entry found via history. */
  activeBotThreadTtlMs: number;
}

export type ShouldRespondReason =
  | 'dm'
  | 'mentioned'
  | 'reply-to-bot'
  | 'active-thread'
  | 'ignored';

export interface ShouldRespondResult {
  respond: boolean;
  reason: ShouldRespondReason;
}

const ACTIVE_THREAD_KEY = (roomId: string, threadId: string): string =>
  `${roomId}:${threadId}`;

const logger = new Logger('GroupChatGuard');

/**
 * True when the event's `m.mentions.user_ids` array includes the bot.
 * Tolerant of older clients that omit `m.mentions` — returns false.
 */
export function isBotMentioned(
  content: Record<string, unknown> | undefined,
  botMatrixUserId: string,
): boolean {
  if (!content) return false;
  const mentions = content['m.mentions'] as
    | { user_ids?: unknown }
    | undefined;
  const userIds = mentions?.user_ids;
  if (!Array.isArray(userIds)) return false;
  return userIds.some((id) => typeof id === 'string' && id === botMatrixUserId);
}

/** Extract the in-reply-to event id from message content, if present. */
export function getInReplyToEventId(
  content: Record<string, unknown> | undefined,
): string | undefined {
  if (!content) return undefined;
  const relates = content['m.relates_to'] as
    | { ['m.in_reply_to']?: { event_id?: unknown } }
    | undefined;
  const eventId = relates?.['m.in_reply_to']?.event_id;
  return typeof eventId === 'string' ? eventId : undefined;
}

/**
 * Check whether an incoming message is a direct reply to a bot-authored event.
 * One Matrix API lookup; failures degrade to `false`.
 */
export async function isReplyToBotMessage(
  event: GuardEvent,
  roomId: string,
  matrixManager: MatrixManager,
  botMatrixUserId: string,
): Promise<boolean> {
  const inReplyTo = getInReplyToEventId(event.content);
  if (!inReplyTo) return false;
  try {
    const target = await matrixManager.getEventById(roomId, inReplyTo);
    return target?.sender === botMatrixUserId;
  } catch (err) {
    logger.warn(
      `Failed to fetch reply target ${inReplyTo} in ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Mark a thread as actively engaged with the bot. */
export function markBotThreadActive(
  activeBotThreads: Map<string, number>,
  roomId: string,
  threadId: string,
  ttlMs: number,
): void {
  activeBotThreads.set(ACTIVE_THREAD_KEY(roomId, threadId), Date.now() + ttlMs);
}

/**
 * True when (room, thread) is in the active-bot-thread map and not expired.
 * Lazily evicts expired entries.
 */
export function isActiveBotThread(
  activeBotThreads: Map<string, number>,
  roomId: string,
  threadId: string,
): boolean {
  const key = ACTIVE_THREAD_KEY(roomId, threadId);
  const expiresAt = activeBotThreads.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    activeBotThreads.delete(key);
    return false;
  }
  return true;
}

/** Periodic eviction of expired entries. Called opportunistically. */
export function sweepExpiredBotThreads(
  activeBotThreads: Map<string, number>,
): void {
  const now = Date.now();
  for (const [key, expiresAt] of activeBotThreads.entries()) {
    if (expiresAt <= now) activeBotThreads.delete(key);
  }
}

/**
 * Fallback when the in-memory active-thread cache is cold (restart / TTL
 * expiry): scan recent Matrix history for prior bot participation in this
 * thread. Re-warms the cache on hit.
 */
async function hasBotSpokenInThread(
  roomId: string,
  threadId: string,
  matrixManager: MatrixManager,
  botMatrixUserId: string,
  activeBotThreads: Map<string, number>,
  activeBotThreadTtlMs: number,
): Promise<boolean> {
  try {
    const { messages } = await matrixManager.getRecentRoomMessages(roomId, {
      limit: 100,
    });
    const botWasActive = messages.some(
      (m) => m.sender === botMatrixUserId && m.threadId === threadId,
    );
    if (botWasActive) {
      markBotThreadActive(
        activeBotThreads,
        roomId,
        threadId,
        activeBotThreadTtlMs,
      );
    }
    return botWasActive;
  } catch {
    return false;
  }
}

/**
 * Resolve whether the agent should respond to this Matrix event.
 *
 * Order of precedence:
 *   1. DM → respond
 *   2. Bot @mentioned → respond
 *   3. Direct reply to a bot message → respond
 *   4. Thread already in active-bot-thread map → respond
 *   5. Cache cold: check Matrix history for prior bot participation → respond
 *   6. Otherwise → ignore (still capture passively elsewhere)
 */
export async function shouldAgentRespond(
  input: ShouldRespondInput,
): Promise<ShouldRespondResult> {
  const {
    event,
    roomId,
    threadId,
    matrixManager,
    botMatrixUserId,
    roomInfo,
    activeBotThreads,
    activeBotThreadTtlMs,
  } = input;

  if (roomInfo.isDirect) {
    return { respond: true, reason: 'dm' };
  }

  if (isBotMentioned(event.content, botMatrixUserId)) {
    return { respond: true, reason: 'mentioned' };
  }

  if (
    await isReplyToBotMessage(event, roomId, matrixManager, botMatrixUserId)
  ) {
    return { respond: true, reason: 'reply-to-bot' };
  }

  if (isActiveBotThread(activeBotThreads, roomId, threadId)) {
    return { respond: true, reason: 'active-thread' };
  }

  if (
    threadId !== event.eventId &&
    (await hasBotSpokenInThread(
      roomId,
      threadId,
      matrixManager,
      botMatrixUserId,
      activeBotThreads,
      activeBotThreadTtlMs,
    ))
  ) {
    return { respond: true, reason: 'active-thread' };
  }

  return { respond: false, reason: 'ignored' };
}

/**
 * Speaker context derived from the most recent HumanMessage in graph state.
 * In group rooms every HumanMessage carries `additional_kwargs.senderDid`
 * (and friends). In DMs, fall back to the session-owner DID.
 */
export interface SpeakerContext {
  did: string;
  matrixUserId?: string;
  displayName?: string;
}

export function getCurrentSpeaker(
  messages: ReadonlyArray<BaseMessage> | undefined,
  fallbackDid: string,
): SpeakerContext {
  if (!messages || messages.length === 0) return { did: fallbackDid };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m._getType === 'function' && m._getType() === 'human') {
      const kwargs = (m.additional_kwargs ?? {}) as Record<string, unknown>;
      const did =
        typeof kwargs.senderDid === 'string' ? kwargs.senderDid : fallbackDid;
      const matrixUserId =
        typeof kwargs.senderMatrixUserId === 'string'
          ? kwargs.senderMatrixUserId
          : undefined;
      const displayName =
        typeof kwargs.senderDisplayName === 'string'
          ? kwargs.senderDisplayName
          : undefined;
      return { did, matrixUserId, displayName };
    }
  }
  return { did: fallbackDid };
}
