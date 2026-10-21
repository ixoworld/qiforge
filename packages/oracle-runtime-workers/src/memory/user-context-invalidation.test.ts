/**
 * The prefetch-cache invalidation middleware on a real `createAgent` loop:
 * a successful memory write invalidates the turn's room once; an error
 * result, a thrown tool and an unrelated tool do not.
 */
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent, FakeToolCallingModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MEMORY_ADD_MCP_NAME,
  MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
  MEMORY_DELETE_EDGE_MCP_NAME,
  MEMORY_DELETE_EPISODE_MCP_NAME,
  MEMORY_SEARCH_MCP_NAME,
} from '../plugins/memory/memory-tools';
import {
  createUserContextInvalidationMiddleware,
  MEMORY_WRITE_TOOL_NAMES,
} from './user-context-invalidation';

const ROOM = '!room:x';

type Behaviour = 'ok' | 'error-result' | 'throw';

function stubTool(name: string, behaviour: Behaviour, ran: string[]) {
  return tool(
    async (_input, config) => {
      ran.push(name);
      if (behaviour === 'throw') throw new Error('upstream refused');
      if (behaviour === 'error-result') {
        return new ToolMessage({
          tool_call_id: config.toolCall?.id ?? '',
          name,
          content: 'memory engine answered 500',
          status: 'error',
        });
      }
      return 'done';
    },
    { name, description: `Stub of ${name}.`, schema: z.object({}) },
  );
}

/** One model step calling `name`, then a final answer. */
async function runCall(
  name: string,
  behaviour: Behaviour,
  options: { toolNames?: string[] } = {},
): Promise<{ invalidated: string[]; logs: string[]; ran: string[] }> {
  const invalidated: string[] = [];
  const logs: string[] = [];
  const ran: string[] = [];
  const agent = createAgent({
    model: new FakeToolCallingModel({
      toolCalls: [[{ name, id: 'c1', args: {} }], []],
    }),
    tools: [stubTool(name, behaviour, ran)],
    middleware: [
      createUserContextInvalidationMiddleware({
        roomId: ROOM,
        invalidate: (roomId) => invalidated.push(roomId),
        ...(options.toolNames ? { toolNames: options.toolNames } : {}),
        logger: {
          log: (m: unknown) => logs.push(String(m)),
          warn: (m: unknown) => logs.push(String(m)),
          error: (m: unknown) => logs.push(String(m)),
        },
      }),
    ],
  });
  await agent
    .invoke({ messages: [new HumanMessage('go')] })
    .catch(() => undefined);
  return { invalidated, logs, ran };
}

describe('createUserContextInvalidationMiddleware', () => {
  it('covers every memory write and delete tool, and only those', () => {
    expect([...MEMORY_WRITE_TOOL_NAMES].sort()).toEqual(
      [
        MEMORY_ADD_MCP_NAME,
        MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
        MEMORY_CLEAR_MCP_NAME,
        MEMORY_DELETE_EDGE_MCP_NAME,
        MEMORY_DELETE_EPISODE_MCP_NAME,
      ].sort(),
    );
    expect(MEMORY_WRITE_TOOL_NAMES).not.toContain(MEMORY_SEARCH_MCP_NAME);
  });

  it.each(MEMORY_WRITE_TOOL_NAMES.map((name) => [name]))(
    'a successful %s call invalidates the room once',
    async (name) => {
      const { invalidated, logs } = await runCall(name, 'ok');
      expect(invalidated).toEqual([ROOM]);
      expect(logs).toContain(
        `[user-context] invalidated room=${ROOM} after ${name}`,
      );
    },
  );

  it('an error result does not invalidate', async () => {
    const { invalidated, ran } = await runCall(
      MEMORY_ADD_MCP_NAME,
      'error-result',
    );
    expect(ran).toEqual([MEMORY_ADD_MCP_NAME]);
    expect(invalidated).toEqual([]);
  });

  it('a thrown tool does not invalidate', async () => {
    const { invalidated, ran } = await runCall(MEMORY_ADD_MCP_NAME, 'throw');
    expect(ran).toEqual([MEMORY_ADD_MCP_NAME]);
    expect(invalidated).toEqual([]);
  });

  it('a read or an unrelated tool does not invalidate', async () => {
    expect((await runCall(MEMORY_SEARCH_MCP_NAME, 'ok')).invalidated).toEqual(
      [],
    );
    expect((await runCall('get_weather', 'ok')).invalidated).toEqual([]);
  });

  it('takes an explicit list of tool names', async () => {
    expect(
      (await runCall('custom_write', 'ok', { toolNames: ['custom_write'] }))
        .invalidated,
    ).toEqual([ROOM]);
    expect(
      (
        await runCall(MEMORY_ADD_MCP_NAME, 'ok', {
          toolNames: ['custom_write'],
        })
      ).invalidated,
    ).toEqual([]);
  });
});
