import {
  type MatrixManager,
  type MessageEvent,
  type MessageEventContent,
} from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import { type BaseMessage } from 'langchain';

/**
 * Group-chat utilities — pure, self-contained.
 *
 * Mention gating decides whether the agent should respond to an incoming Matrix
 * event in a group room. DMs are unaffected (always respond).
 *
 * The decision flow lives in `shouldAgentRespond`. Helpers below cover the
 * individual signals it uses (mentions, reply-to-bot, active-thread state).
 */

export interface RoomTypeInfo {
  isDirect: boolean;
  memberCount: number;
}

export interface ShouldRespondInput {
  event: MessageEvent<MessageEventContent>;
  roomId: string;
  threadId: string;
  matrixManager: MatrixManager;
  /** Bot's Matrix user ID, e.g. `@oracle:matrix.example.org`. */
  botMatrixUserId: string;
  /** Resolved room type. Caller is responsible for caching. */
  roomInfo: RoomTypeInfo;
  /** Active-thread map shared with the messages service. */
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

/**
 * Returns true when the event's `m.mentions.user_ids` array includes the bot.
 * Tolerant of older clients that omit `m.mentions` — returns false in that case.
 */
export function isBotMentioned(
  content: MessageEventContent | Record<string, unknown> | undefined,
  botMatrixUserId: string,
): boolean {
  if (!content) return false;
  const mentions = (content as Record<string, unknown>)['m.mentions'] as
    | { user_ids?: unknown }
    | undefined;
  const userIds = mentions?.user_ids;
  if (!Array.isArray(userIds)) return false;
  return userIds.some((id) => typeof id === 'string' && id === botMatrixUserId);
}

/**
 * Extract the in-reply-to event id from message content, if present.
 */
export function getInReplyToEventId(
  content: MessageEventContent | Record<string, unknown> | undefined,
): string | undefined {
  if (!content) return undefined;
  const relates = (content as Record<string, unknown>)['m.relates_to'] as
    | { ['m.in_reply_to']?: { event_id?: unknown } }
    | undefined;
  const eventId = relates?.['m.in_reply_to']?.event_id;
  return typeof eventId === 'string' ? eventId : undefined;
}

/**
 * Check whether an incoming message is a direct reply to a bot-authored event.
 * Performs at most one Matrix API lookup; failures degrade to `false`.
 */
export async function isReplyToBotMessage(
  event: MessageEvent<MessageEventContent>,
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
    Logger.warn(
      `[GroupChatGuard] Failed to fetch reply target ${inReplyTo} in ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
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
 * True when the (room, thread) pair is in the active-bot-thread map and not
 * expired. Lazily evicts expired entries.
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

/**
 * Periodic eviction of expired entries. Cheap; called opportunistically.
 */
export function sweepExpiredBotThreads(
  activeBotThreads: Map<string, number>,
): void {
  const now = Date.now();
  for (const [key, expiresAt] of activeBotThreads.entries()) {
    if (expiresAt <= now) activeBotThreads.delete(key);
  }
}

/**
 * Returns true when the bot has previously sent a message in the given thread.
 * Used as a fallback when the in-memory active-thread cache is cold (restart /
 * TTL expiry). Re-warms the cache on hit so subsequent messages are free.
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

  // Cache miss — fall back to Matrix history. Only worth checking for replies
  // inside an existing thread (threadId differs from the event's own id).
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
 * In group rooms, every HumanMessage carries `additional_kwargs.senderDid`
 * (and friends). In DMs, fall back to the session-owner DID provided by the
 * caller — that's the existing single-user invariant.
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
    // BaseMessage subclasses expose _getType(); HumanMessage returns 'human'.
    if (typeof m?._getType === 'function' && m._getType() === 'human') {
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
