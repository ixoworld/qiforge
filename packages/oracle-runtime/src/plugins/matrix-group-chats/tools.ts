import { z } from 'zod';
import type {
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { ChannelMemoryService } from './channel-memory.service.js';
import type { ChannelMemoryChunk } from './channel-memory.types.js';

const formatChunk = (chunk: ChannelMemoryChunk) => ({
  id: chunk.id,
  tier: chunk.tier,
  fromTimestamp: new Date(chunk.fromTimestamp).toISOString(),
  toTimestamp: new Date(chunk.toTimestamp).toISOString(),
  messageCount: chunk.messageCount,
  participants: chunk.participants,
  threadIds: chunk.threadIds,
  summary: chunk.summary,
});

function getService(rtCtx: RuntimeContext): ChannelMemoryService {
  const instance = ChannelMemoryService.getInstance();
  if (!instance) {
    rtCtx.logger.warn(
      'ChannelMemoryService not initialised — matrix-group-chats tool invoked without a running Nest context',
    );
    throw new Error('ChannelMemoryService not initialised');
  }
  return instance;
}

function requireRoomId(rtCtx: RuntimeContext): string {
  const roomId = rtCtx.session.roomId;
  if (!roomId) {
    throw new Error(
      'No active Matrix room — channel-memory tools require a roomId in the current session.',
    );
  }
  return roomId;
}

/**
 * Build the per-room channel-memory tools. Visibility=`always` on each so
 * they bypass the capability gate — gating happens in `getRequestTools`,
 * which returns these only when the session is in a Matrix group room.
 */
export function buildChannelMemoryTools(): PluginTool[] {
  return [
    {
      name: 'recall_channel_memory',
      description:
        'Read recent channel memory: most recent compacted summary chunks, pinned facts, and the member roster for the current group room. Use this to understand what has been happening in this channel before responding.',
      visibility: 'always',
      schema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe(
            'Number of recent summary chunks to return (default 10, max 30).',
          ),
      }),
      async handler(args, rtCtx) {
        const roomId = requireRoomId(rtCtx);
        const service = getService(rtCtx);
        const parsed = z
          .object({ limit: z.number().int().min(1).max(30).optional() })
          .parse(args);
        const cap = parsed.limit ?? 10;
        const [chunks, facts, members] = await Promise.all([
          service.recentChunks(roomId, cap),
          service.listPinnedFacts(roomId),
          service.getMembers(roomId),
        ]);
        return {
          chunks: chunks.map(formatChunk),
          pinnedFacts: facts,
          members,
        };
      },
    },
    {
      name: 'search_channel_memory',
      description:
        'Keyword-search the compacted summary chunks for the current group room. Use to find earlier discussions of a topic, decisions, names, dates. Returns matching chunks with their summaries.',
      visibility: 'always',
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe('Keywords or phrase to search for in channel memory.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Maximum matching chunks to return (default 10).'),
      }),
      async handler(args, rtCtx) {
        const roomId = requireRoomId(rtCtx);
        const service = getService(rtCtx);
        const parsed = z
          .object({
            query: z.string().min(1),
            limit: z.number().int().min(1).max(30).optional(),
          })
          .parse(args);
        const cap = parsed.limit ?? 10;
        const chunks = await service.search(roomId, parsed.query, cap);
        if (chunks.length === 0) {
          return { chunks: [], note: 'No matching chunks.' };
        }
        return { chunks: chunks.map(formatChunk) };
      },
    },
    {
      name: 'pin_room_fact',
      description:
        "Save a durable fact to the current group room's memory — survives across threads and sessions. Use for decisions, deadlines, member roles, project context. Surface in your reply so users know it has been saved.",
      visibility: 'always',
      schema: z.object({
        fact: z
          .string()
          .min(3)
          .max(500)
          .describe('Concise factual statement to remember (max 500 chars).'),
        sourceEventId: z
          .string()
          .optional()
          .describe('Optional Matrix event id this fact was derived from.'),
      }),
      async handler(args, rtCtx) {
        const roomId = requireRoomId(rtCtx);
        const service = getService(rtCtx);
        const parsed = z
          .object({
            fact: z.string().min(3).max(500),
            sourceEventId: z.string().optional(),
          })
          .parse(args);
        const trimmed = parsed.fact.trim();
        if (!trimmed) {
          throw new Error('Pinned fact must not be empty.');
        }
        const pinned = await service.pinFact({
          roomId,
          fact: trimmed.slice(0, 500),
          pinnedByDid: rtCtx.user.did,
          sourceEventId: parsed.sourceEventId,
        });
        return { factId: pinned.id, fact: pinned.fact };
      },
    },
    {
      name: 'unpin_room_fact',
      description:
        "Remove a previously pinned fact from this group room's memory by its factId.",
      visibility: 'always',
      schema: z.object({
        factId: z.string().min(1).describe('The id of the fact to remove.'),
      }),
      async handler(args, rtCtx) {
        const roomId = requireRoomId(rtCtx);
        const service = getService(rtCtx);
        const parsed = z.object({ factId: z.string().min(1) }).parse(args);
        const ok = await service.unpinFact(roomId, parsed.factId);
        return { ok };
      },
    },
  ];
}
