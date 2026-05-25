import { MatrixManager } from '@ixo/matrix';
import { type BaseMessage } from '@langchain/core/messages';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import { mainAgentRequestContextSchema } from '../../graph/main-agent-types.js';
import type { Logger, PluginContext } from '../../plugin-api/types.js';
import { ChannelMemoryService } from './channel-memory.service.js';
import type { ObservedMessage } from './channel-memory.types.js';
import {
  markBotThreadActive,
  shouldAgentRespond,
  sweepExpiredBotThreads,
  type GuardEvent,
} from './guard.js';
import { getBotPowerLevel } from './power-levels.js';
import { RoomInfoCache } from './room-info.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface GroupChatMiddlewareOptions {
  activeThreadTtlMs: number;
  requirePowerLevel: number;
  roomInfoTtlMs: number;
  logger?: Logger;
}

/**
 * Per-turn gate for Matrix group rooms. Runs as `beforeAgent`:
 *
 *  - Non-Matrix transports → pass through.
 *  - DMs / rooms with ≤2 members → pass through.
 *  - Group rooms (>2 members):
 *      - Capture the latest HumanMessage into channel memory (side effect).
 *      - Run `shouldAgentRespond` (mention / reply-to-bot / active-thread).
 *      - If the bot shouldn't respond → short-circuit with `jumpTo: 'end'`.
 *      - If it should → check `m.room.power_levels`; short-circuit when the
 *        bot lacks send permission.
 *
 * Does NOT declare a `stateSchema` and NEVER returns state updates.
 * Re-declaring the agent's built-in `messages` channel clobbers its
 * `addMessages` reducer and resets the conversation per turn — that's why
 * earlier versions of this middleware caused "every message is a new
 * thread" behaviour. Side effects only.
 */
export const createGroupChatMiddleware = (
  options: GroupChatMiddlewareOptions,
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const activeBotThreads = new Map<string, number>();
  const roomInfoCache = new RoomInfoCache(options.roomInfoTtlMs);

  return createMiddleware({
    name: 'GroupChatMiddleware',
    contextSchema: mainAgentRequestContextSchema,
    beforeAgent: {
      canJumpTo: ['end'],
      hook: async (state, runtime) => {
        const parsedCtx = mainAgentRequestContextSchema.safeParse(
          (runtime as { context?: unknown }).context,
        );
        if (!parsedCtx.success) return;
        const ctx = parsedCtx.data;
        if (ctx.session.client !== 'matrix' || !ctx.session.roomId) {
          return;
        }
        const roomId = ctx.session.roomId;

        const messages: BaseMessage[] = Array.isArray(state.messages)
          ? (state.messages as BaseMessage[])
          : [];
        const lastHuman = findLastHuman(messages);
        console.log("🚀 ~ createGroupChatMiddleware ~ lastHuman:", lastHuman)
        if (!lastHuman) return;

        const kwargs: Record<string, unknown> = lastHuman.additional_kwargs
          ? { ...lastHuman.additional_kwargs }
          : {};
        const eventId = pickString(kwargs.eventId);
        const threadId = pickString(kwargs.threadId) ?? eventId;
        if (!eventId || !threadId) {
          logger.warn?.(
            '[GroupChatMiddleware] Last HumanMessage is missing eventId/threadId metadata — passing through',
          );
          return;
        }

        let roomInfo: Awaited<ReturnType<RoomInfoCache['get']>>;
        try {
          roomInfo = await roomInfoCache.get(roomId);
        } catch (err) {
          logger.warn?.(
            `[GroupChatMiddleware] getRoomInfo failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }

        if (roomInfo.isDirect || roomInfo.memberCount <= 2) {
          return;
        }

        const channelMemory = ChannelMemoryService.getInstance();
        const senderDid = pickString(kwargs.senderDid) ?? ctx.user.did;
        const senderMatrixUserId =
          pickString(kwargs.senderMatrixUserId) ?? ctx.user.matrixUserId;
        const senderDisplayName =
          pickString(kwargs.senderDisplayName) ?? senderMatrixUserId;

        const body = stringifyContent(lastHuman.content);
        const observed: ObservedMessage = {
          eventId,
          threadId,
          senderDid,
          senderMatrixUserId,
          senderDisplayName,
          body,
          timestamp: Date.now(),
        };

        if (channelMemory) {
          try {
            channelMemory.observeMessage(roomId, observed);
          } catch (err) {
            logger.warn?.(
              `[GroupChatMiddleware] observeMessage failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        sweepExpiredBotThreads(activeBotThreads);

        const matrixManager = MatrixManager.getInstance();
        const botMatrixUserId = matrixManager.getBotMatrixUserId();
        const event: GuardEvent = { eventId, content: kwargs };
        const decision = await shouldAgentRespond({
          event,
          roomId,
          threadId,
          matrixManager,
          botMatrixUserId,
          roomInfo,
          activeBotThreads,
          activeBotThreadTtlMs: options.activeThreadTtlMs,
        });

        if (!decision.respond) {
          logger.log(
            `[GroupChatMiddleware] room=${roomId} thread=${threadId.slice(0, 10)} ignored (${decision.reason})`,
          );
          return { jumpTo: 'end' as const };
        }

        // Power-level check — short-circuit silently if the bot can't post.
        try {
          const pl = await getBotPowerLevel(roomId, botMatrixUserId);
          if (!pl.allowed(options.requirePowerLevel)) {
            logger.warn(
              `[GroupChatMiddleware] room=${roomId} bot PL ${pl.pl} < required ${Math.max(pl.sendThreshold, options.requirePowerLevel)} — skipping`,
            );
            return { jumpTo: 'end' as const };
          }
        } catch (err) {
          logger.warn?.(
            `[GroupChatMiddleware] power_levels check failed for ${roomId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        markBotThreadActive(
          activeBotThreads,
          roomId,
          threadId,
          options.activeThreadTtlMs,
        );

        // Refresh the member roster mid-conversation. Fire-and-forget so
        // we never block the turn waiting on Matrix.
        if (channelMemory) {
          channelMemory
            .refreshMembers(roomId, matrixManager)
            .catch(() => undefined);
          // JIT compaction — service has its own 3-sec timeout cap.
          await channelMemory.compactJustInTime(roomId).catch(() => undefined);
        }

        // Intentionally NO state mutation here. Returning `{ messages: ... }`
        // from `beforeAgent` interacts with the `addMessages` reducer in
        // ways that break checkpointer thread continuity. The speaker
        // identity is already on the HumanMessage's `additional_kwargs`
        // for downstream consumers; we don't need to rewrite the content.
        return;
      },
    },
  });
};

function findLastHuman(
  messages: ReadonlyArray<BaseMessage>,
): BaseMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === 'human') {
      return m;
    }
  }
  return undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Build the middleware from `PluginContext` config. */
export function buildGroupChatMiddleware(ctx: PluginContext): AgentMiddleware {
  const config = ctx.config as {
    GROUP_CHAT_ACTIVE_THREAD_TTL_MS?: number;
    GROUP_CHAT_REQUIRE_POWER_LEVEL?: number;
    GROUP_CHAT_ROOM_INFO_TTL_MS?: number;
  };
  return createGroupChatMiddleware({
    activeThreadTtlMs: config.GROUP_CHAT_ACTIVE_THREAD_TTL_MS ?? 30 * 60 * 1000,
    requirePowerLevel: config.GROUP_CHAT_REQUIRE_POWER_LEVEL ?? 0,
    roomInfoTtlMs: config.GROUP_CHAT_ROOM_INFO_TTL_MS ?? 30 * 60 * 1000,
    logger: ctx.logger,
  });
}

export { RoomInfoCache } from './room-info.js';
