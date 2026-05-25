import { MatrixManager } from '@ixo/matrix';
import type { DynamicModule, Type } from '@nestjs/common';
import { type AgentMiddleware } from 'langchain';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { ChannelMemoryModule } from './channel-memory.module.js';
import { ChannelMemoryService } from './channel-memory.service.js';
import { CHANNEL_MEMORY_SHARED_KEY } from './channel-memory.types.js';
import { buildGroupChatMiddleware } from './middleware.js';
import { RoomInfoCache } from './room-info.js';
import { buildChannelMemoryTools } from './tools.js';

const DEFAULT_ROOM_INFO_TTL_MS = 30 * 60 * 1000;

const configSchema = z.object({
  CHANNEL_MEMORY_SYNC_INTERVAL_MS: z
    .coerce.number()
    .int()
    .min(1000)
    .default(60_000)
    .describe('Debounce window between a write and the Matrix snapshot upload.'),
  // Group-chat gating
  GROUP_CHAT_ACTIVE_THREAD_TTL_MS: z
    .coerce.number()
    .int()
    .min(60_000)
    .default(30 * 60 * 1000)
    .describe('How long a thread stays "active with the bot" after a reply.'),
  GROUP_CHAT_REQUIRE_POWER_LEVEL: z
    .coerce.number()
    .int()
    .min(0)
    .default(0)
    .describe('Extra minimum power level the bot must have before posting (0 = use the room default).'),
  GROUP_CHAT_ROOM_INFO_TTL_MS: z
    .coerce.number()
    .int()
    .min(60_000)
    .default(DEFAULT_ROOM_INFO_TTL_MS)
    .describe('How long roomInfo (membership, DM flag) stays cached.'),
});

const manifest: PluginManifest = {
  title: 'Matrix Group Chats',
  summary:
    'Lets the oracle participate cleanly in Matrix group rooms: it only replies when mentioned, replied to, or already in an active thread, and keeps an FTS5-searchable compacted memory of every room it sits in.',
  whenToUse: [
    'A user asks what was said or decided earlier in this Matrix group room.',
    'A user asks who is in the room or what their role is.',
    'A durable fact should survive across threads (deadline, decision, project context) — pin it.',
    'You need to recall the gist of prior conversation before answering a multi-step group request.',
  ],
  whenNotToUse: [
    'Single-user DMs — the plugin only acts in rooms with more than 2 members.',
    'Long-term personal memory about a specific user — use the Memory plugin.',
    'Verbatim text of a specific Matrix event — use Matrix history directly.',
  ],
  examples: [
    {
      user: 'What did we agree about the launch date?',
      thought:
        'Search channel memory for "launch date" before answering — the decision may be in an older chunk.',
      tool: 'search_channel_memory',
      args: { query: 'launch date' },
    },
    {
      user: 'Remember that Alice owns the redesign.',
      thought: 'Persist that as a pinned fact for the group room.',
      tool: 'pin_room_fact',
      args: { fact: 'Alice owns the redesign.' },
    },
  ],
  tags: ['matrix', 'group-chat', 'memory'],
  category: 'communication',
  visibility: 'on-demand',
  stability: 'beta',
};

/**
 * `matrix-group-chats` — one plugin that owns the per-room memory pipeline
 * AND the per-turn gating middleware for Matrix group rooms.
 *
 * Activation:
 *  - **Boot:** on by default. Developers opt out with
 *    `features: { 'matrix-group-chats': false }`.
 *  - **Per request:** the middleware short-circuits when the session is not
 *    a Matrix room with >2 members, and `getRequestTools` returns the four
 *    channel-memory tools only for group rooms, so DM oracles never see
 *    them in the prompt.
 *
 * Tools (per-tool visibility=`always`, bypassing the capability gate):
 *  - `recall_channel_memory` — recent chunks + pinned facts + members
 *  - `search_channel_memory` — FTS5 keyword search over compacted chunks
 *  - `pin_room_fact` / `unpin_room_fact` — manage durable per-room facts
 */
export class MatrixGroupChatsPlugin extends OraclePlugin {
  static readonly NAME = 'matrix-group-chats';

  readonly name = MatrixGroupChatsPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  /** Shared between `getRequestTools` (membership check) and the middleware. */
  private readonly roomInfoCache = new RoomInfoCache(DEFAULT_ROOM_INFO_TTL_MS);

  override getNestModules(): Array<Type | DynamicModule> {
    return [ChannelMemoryModule];
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [buildGroupChatMiddleware(ctx)];
  }

  /**
   * Per-request: only expose the four channel-memory tools when the current
   * session is in a Matrix group room (memberCount > 2). DM / portal /
   * slack sessions get an empty list so the agent never sees them.
   */
  override async getRequestTools(
    rtCtx: RuntimeContext,
  ): Promise<PluginTool[]> {
    if (rtCtx.session.client !== 'matrix' || !rtCtx.session.roomId) {
      return [];
    }
    try {
      const info = await this.roomInfoCache.get(rtCtx.session.roomId);
      if (info.isDirect || info.memberCount <= 2) {
        return [];
      }
    } catch (err) {
      rtCtx.logger.warn?.(
        `[matrix-group-chats] getRoomInfo failed for ${rtCtx.session.roomId}: ${err instanceof Error ? err.message : String(err)} — skipping tools`,
      );
      return [];
    }
    return buildChannelMemoryTools();
  }

  override getSharedState(): Record<
    string,
    (state: unknown, runCtx: RuntimeContext) => unknown
  > {
    return {
      [CHANNEL_MEMORY_SHARED_KEY]: () => ChannelMemoryService.getInstance(),
    };
  }
}

export { ChannelMemoryModule } from './channel-memory.module.js';
export { ChannelMemoryService } from './channel-memory.service.js';
export {
  CHANNEL_MEMORY_SHARED_KEY,
  type ChannelMember,
  type ChannelMemoryChunk,
  type ObservedMessage,
  type PinnedFact,
} from './channel-memory.types.js';
export {
  isBotMentioned,
  isReplyToBotMessage,
  isActiveBotThread,
  markBotThreadActive,
  sweepExpiredBotThreads,
  shouldAgentRespond,
  getCurrentSpeaker,
  type GuardEvent,
  type RoomTypeInfo,
  type ShouldRespondInput,
  type ShouldRespondReason,
  type ShouldRespondResult,
  type SpeakerContext,
} from './guard.js';
export { getBotPowerLevel, type BotPowerLevel } from './power-levels.js';
export { RoomInfoCache } from './room-info.js';

/**
 * Tiny export so tests can assert the plugin behaves identically against
 * the real MatrixManager singleton. Exposed for symmetry — production
 * callers should use `MatrixGroupChatsPlugin` directly.
 */
export { MatrixManager };
