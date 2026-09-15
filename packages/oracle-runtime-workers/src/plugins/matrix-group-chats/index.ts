/**
 * Matrix Group Chats — the Workers port of
 * `packages/oracle-runtime/src/plugins/matrix-group-chats`.
 *
 * STATUS: under development, off by default. The port is complete and
 * tested but not reviewed for production, and it differs from Node in
 * several ways — every difference and the open items are listed in
 * `README.md` next to this file. A deployment turns the lane on with
 * `MATRIX_GROUP_ROOMS=gate` on the gateway; until then the bot never speaks
 * in a room with more than two members and this plugin offers no tools.
 *
 * On Node the plugin owned both halves: the per-turn gate (an agent
 * middleware: answer only when mentioned, replied to or already in an active
 * thread; capture every message into channel memory) and the per-room
 * memory with its four tools. On Workers the gate and the memory run in the
 * Matrix gateway, the one object every room message passes through
 * (`src/matrix/group-chat.ts`); this plugin is the agent-side half: the four
 * channel-memory tools, offered — exactly as on Node — only to a session in
 * a Matrix room with more than two members. The `[DisplayName]: ` speaker
 * prefix is applied by the user object's turn preparer (`speaker-prefix.ts`).
 *
 * The lane is opt-in per deployment: `MATRIX_GROUP_ROOMS=gate` on the
 * gateway. By default (`silent`) the bot never speaks in a group room and
 * this plugin offers nothing. The gate's knobs are read by the gateway from
 * its env (`GROUP_CHAT_ACTIVE_THREAD_TTL_MS`, `GROUP_CHAT_REQUIRE_POWER_LEVEL`,
 * `GROUP_CHAT_ROOM_INFO_TTL_MS`); they are declared here too so an oracle's
 * config validates them the way Node's did.
 */
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import { buildChannelMemoryTools } from './tools';

const configSchema = z.object({
  GROUP_CHAT_ACTIVE_THREAD_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(30 * 60 * 1000)
    .describe('How long a thread stays "active with the bot" after a reply.'),
  GROUP_CHAT_REQUIRE_POWER_LEVEL: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Extra minimum power level the bot must have before posting (0 = use the room default).',
    ),
  GROUP_CHAT_ROOM_INFO_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(30 * 60 * 1000)
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

export class MatrixGroupChatsPlugin extends OraclePlugin {
  static readonly NAME = 'matrix-group-chats';

  readonly name = MatrixGroupChatsPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  /**
   * Per request: the four channel-memory tools only when the deployment
   * runs the group-chat lane and the session is in a Matrix group room
   * (more than two members). DM, portal and task sessions get an empty
   * list, so the agent never sees them there.
   */
  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    const roomId = rtCtx.session.roomId;
    if (rtCtx.session.client !== 'matrix' || !roomId) return [];
    const roomInfo = rtCtx.matrix.roomInfo;
    if (!roomInfo || !rtCtx.matrix.channelMemory) return [];
    try {
      const info = await roomInfo(roomId);
      if (!info.groupLane || info.isDirect || info.memberCount <= 2) return [];
    } catch (err) {
      rtCtx.logger.warn(
        `[matrix-group-chats] roomInfo failed for ${roomId}: ${err instanceof Error ? err.message : String(err)} — skipping tools`,
      );
      return [];
    }
    return buildChannelMemoryTools();
  }
}

export { buildChannelMemoryTools } from './tools';
