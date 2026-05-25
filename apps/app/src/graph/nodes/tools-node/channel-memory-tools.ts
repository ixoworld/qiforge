import { MatrixManager } from '@ixo/matrix';
import { tool } from '@langchain/core/tools';
import { Logger } from '@nestjs/common';
import z from 'zod';
import { type ChannelMemoryService } from '../../../channel-memory/channel-memory.service';
import { type ChannelMemoryChunk } from '../../../channel-memory/channel-memory.types';

const logger = new Logger('ChannelMemoryTools');

/**
 * Build the agent tools that read/write channel memory for a specific group room.
 *
 * Tools are scoped to a single roomId per agent invocation — the room is
 * captured in closure rather than passed as an argument so the model can't
 * accidentally read another room's memory.
 *
 * These tools should only be registered when the current session is in a
 * group room. DMs don't see them.
 */
export interface ChannelMemoryToolDeps {
  channelMemory: ChannelMemoryService;
  roomId: string;
  /** DID used to attribute pin/unpin actions; usually the session-owner DID. */
  pinnedByDid: string;
}

const formatChunk = (chunk: ChannelMemoryChunk) => ({
  id: chunk.id,
  fromTimestamp: new Date(chunk.fromTimestamp).toISOString(),
  toTimestamp: new Date(chunk.toTimestamp).toISOString(),
  messageCount: chunk.messageCount,
  participants: chunk.participants,
  threadIds: chunk.threadIds,
  summary: chunk.summary,
});

export function createRecallChannelMemoryTool(deps: ChannelMemoryToolDeps) {
  return tool(
    async ({ limit }) => {
      const cap = Math.min(Math.max(limit ?? 10, 1), 30);
      try {
        const [chunks, facts, members] = await Promise.all([
          deps.channelMemory.recentChunks(deps.roomId, cap),
          deps.channelMemory.listPinnedFacts(deps.roomId),
          deps.channelMemory.getMembers(deps.roomId),
        ]);
        return JSON.stringify(
          {
            chunks: chunks.map(formatChunk),
            pinnedFacts: facts,
            members,
          },
          null,
          2,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`recall_channel_memory failed: ${msg}`);
        return `[Error reading channel memory: ${msg}]`;
      }
    },
    {
      name: 'recall_channel_memory',
      description:
        'Read recent channel memory: most recent compacted summary chunks, pinned facts, and the member roster for the current group room. Use this to understand what has been happening in this channel before responding.',
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
    },
  );
}

export function createSearchChannelMemoryTool(deps: ChannelMemoryToolDeps) {
  return tool(
    async ({ query, limit }) => {
      const cap = Math.min(Math.max(limit ?? 10, 1), 30);
      try {
        const chunks = await deps.channelMemory.search(deps.roomId, query, cap);
        if (chunks.length === 0) {
          return JSON.stringify({ chunks: [], note: 'No matching chunks.' });
        }
        return JSON.stringify({ chunks: chunks.map(formatChunk) }, null, 2);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`search_channel_memory failed: ${msg}`);
        return `[Error searching channel memory: ${msg}]`;
      }
    },
    {
      name: 'search_channel_memory',
      description:
        'Keyword-search the compacted summary chunks for the current group room. Use to find earlier discussions of a topic, decisions, names, dates. Returns matching chunks with their summaries.',
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
          .describe(
            'Maximum number of matching chunks to return (default 10).',
          ),
      }),
    },
  );
}

export function createPinRoomFactTool(deps: ChannelMemoryToolDeps) {
  return tool(
    async ({ fact, sourceEventId }) => {
      try {
        const trimmed = fact.trim();
        if (!trimmed) return '[Error: fact is empty]';
        const pinned = await deps.channelMemory.pinFact({
          roomId: deps.roomId,
          fact: trimmed.slice(0, 500),
          pinnedByDid: deps.pinnedByDid,
          sourceEventId,
        });
        return JSON.stringify({ factId: pinned.id, fact: pinned.fact });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`pin_room_fact failed: ${msg}`);
        return `[Error pinning fact: ${msg}]`;
      }
    },
    {
      name: 'pin_room_fact',
      description:
        "Save a durable fact to the current group room's memory — survives across threads and sessions. Use for decisions, deadlines, member roles, project context. Surface in your reply so users know it has been saved (e.g., \"I'll remember that for the group: '…'\").",
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
    },
  );
}

export function createUnpinRoomFactTool(deps: ChannelMemoryToolDeps) {
  return tool(
    async ({ factId }) => {
      try {
        const ok = await deps.channelMemory.unpinFact(deps.roomId, factId);
        return JSON.stringify({ ok });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`unpin_room_fact failed: ${msg}`);
        return `[Error unpinning fact: ${msg}]`;
      }
    },
    {
      name: 'unpin_room_fact',
      description:
        "Remove a previously pinned fact from this group room's memory by its factId.",
      schema: z.object({
        factId: z.string().min(1).describe('The id of the fact to remove.'),
      }),
    },
  );
}

export function createGetRoomMessagesRangeTool(roomId: string) {
  return tool(
    async ({ limit, paginationToken, threadId }) => {
      const cap = Math.min(Math.max(limit ?? 50, 1), 200);
      try {
        const matrixManager = MatrixManager.getInstance();
        const { messages, paginationToken: nextToken } =
          await matrixManager.getRecentRoomMessages(roomId, {
            limit: cap,
            from: paginationToken,
          });
        const filtered = threadId
          ? messages.filter((m) => m.threadId === threadId)
          : messages;
        const result = await Promise.all(
          filtered.map(async (m) => ({
            eventId: m.eventId,
            sender: m.sender,
            displayName: await matrixManager
              .getCachedDisplayName(m.sender, roomId)
              .catch(() => m.sender),
            body: m.body,
            timestamp: new Date(m.timestamp).toISOString(),
            threadId: m.threadId,
          })),
        );
        return JSON.stringify(
          { messages: result, nextPaginationToken: nextToken },
          null,
          2,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`get_room_messages_range failed: ${msg}`);
        return `[Error reading room messages: ${msg}]`;
      }
    },
    {
      name: 'get_room_messages_range',
      description:
        'Fetch raw recent messages from the current Matrix room. Use when channel memory and search are not enough and you need verbatim text. Returns messages in chronological order (oldest first). Pass nextPaginationToken from a previous response as paginationToken to page further back in history.',
      schema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Max messages to return (default 50, max 200).'),
        paginationToken: z
          .string()
          .optional()
          .describe(
            'Opaque pagination token from a previous call (nextPaginationToken). Do NOT pass Matrix event IDs here.',
          ),
        threadId: z
          .string()
          .optional()
          .describe('Filter to messages in a specific thread root id.'),
      }),
    },
  );
}

export function createChannelMemoryTools(deps: ChannelMemoryToolDeps) {
  return [
    createRecallChannelMemoryTool(deps),
    createSearchChannelMemoryTool(deps),
    createPinRoomFactTool(deps),
    createUnpinRoomFactTool(deps),
    createGetRoomMessagesRangeTool(deps.roomId),
  ];
}
