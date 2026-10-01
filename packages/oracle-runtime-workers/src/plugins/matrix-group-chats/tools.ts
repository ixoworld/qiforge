/**
 * The four channel-memory tools of a Matrix group room — the Node
 * `plugins/matrix-group-chats/tools.ts` verbatim in contract; the store is
 * the gateway's (`RuntimeContext.matrix.channelMemory`).
 */
import { z } from 'zod';
import type {
  ChannelMemoryChunk,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';

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

function requireMemory(rtCtx: RuntimeContext) {
  const memory = rtCtx.matrix.channelMemory;
  if (!memory)
    throw new Error(
      'Channel memory is not available on this host (no Matrix gateway).',
    );
  return memory;
}

function requireRoomId(rtCtx: RuntimeContext): string {
  const roomId = rtCtx.session.roomId;
  if (!roomId)
    throw new Error(
      'No active Matrix room — channel-memory tools require a roomId in the current session.',
    );
  return roomId;
}

/**
 * Visibility `always` on each tool so they bypass the capability gate —
 * the gating is `getRequestTools`, which returns them only for a session in
 * a Matrix group room.
 */
export function buildChannelMemoryTools(): PluginTool[] {
  return [
    {
      name: 'recall_channel_memory',
      description:
        'Read recent channel memory: most recent compacted summary chunks, pinned facts, and the member roster for the current group room. Use this to understand what has been happening in this channel before responding.',
      visibility: 'always',
      effect: 'read',
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
        const memory = requireMemory(rtCtx);
        const parsed = z
          .object({ limit: z.number().int().min(1).max(30).optional() })
          .parse(args);
        const recalled = await memory.recall(roomId, parsed.limit ?? 10);
        return {
          chunks: recalled.chunks.map(formatChunk),
          pinnedFacts: recalled.pinnedFacts,
          members: recalled.members,
        };
      },
    },
    {
      name: 'search_channel_memory',
      description:
        'Keyword-search the compacted summary chunks for the current group room. Use to find earlier discussions of a topic, decisions, names, dates. Returns matching chunks with their summaries.',
      visibility: 'always',
      effect: 'read',
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
        const memory = requireMemory(rtCtx);
        const parsed = z
          .object({
            query: z.string().min(1),
            limit: z.number().int().min(1).max(30).optional(),
          })
          .parse(args);
        const chunks = await memory.search(
          roomId,
          parsed.query,
          parsed.limit ?? 10,
        );
        if (chunks.length === 0)
          return { chunks: [], note: 'No matching chunks.' };
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
        const memory = requireMemory(rtCtx);
        const parsed = z
          .object({
            fact: z.string().min(3).max(500),
            sourceEventId: z.string().optional(),
          })
          .parse(args);
        const trimmed = parsed.fact.trim();
        if (!trimmed) throw new Error('Pinned fact must not be empty.');
        const pinned = await memory.pin({
          roomId,
          fact: trimmed.slice(0, 500),
          pinnedByDid: rtCtx.user.did,
          ...(parsed.sourceEventId
            ? { sourceEventId: parsed.sourceEventId }
            : {}),
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
        const memory = requireMemory(rtCtx);
        const parsed = z.object({ factId: z.string().min(1) }).parse(args);
        return { ok: await memory.unpin(roomId, parsed.factId) };
      },
    },
  ];
}
