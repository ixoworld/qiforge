import { ToolMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import type { AgentMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSubagentAsTool,
  scopeToolCallIds,
  type AgentSpec,
} from './subagent-as-tool';

const noop = tool(async () => 'ok', {
  name: 'noop',
  description: 'does nothing',
  schema: z.object({}),
});

function specWith(
  model: FakeListChatModel,
  extra: Partial<AgentSpec> = {},
): AgentSpec {
  return {
    name: 'Research Agent',
    description: 'researches',
    systemPrompt: 'You research.',
    model,
    tools: [noop],
    userDid: 'did:ixo:user',
    sessionId: 'session-1',
    ...extra,
  };
}

describe('createSubagentAsTool', () => {
  it('returns a refusal as the sub-agent’s answer, without a second attempt', async () => {
    // The fake model answers in order: a second attempt would have returned
    // the second response as the sub-agent's result.
    const model = new FakeListChatModel({
      responses: ["I'm sorry, but I can't do that.", 'second attempt reply'],
    });
    const subagent = createSubagentAsTool(specWith(model));
    const result = await subagent.invoke({ task: 'do the thing' });
    expect(result).toBe("I'm sorry, but I can't do that.");
  });

  it('awaits onComplete before the result reaches the parent', async () => {
    const model = new FakeListChatModel({ responses: ['done'] });
    const seen: string[] = [];
    const subagent = createSubagentAsTool(specWith(model), {
      onComplete: async (messages, task) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push(`${task}:${messages.length}`);
      },
    });
    const result = await subagent.invoke({ task: 'summarize' });
    expect(seen).toEqual(['summarize:2']);
    expect(result).toBe('done');
  });

  it('reports a failing onComplete hook without failing the tool call', async () => {
    const model = new FakeListChatModel({ responses: ['done'] });
    const warnings: string[] = [];
    const subagent = createSubagentAsTool(
      specWith(model, {
        logger: {
          log: () => undefined,
          warn: (message: string) => warnings.push(message),
          error: () => undefined,
        },
      }),
      {
        onComplete: async () => {
          throw new Error('persist failed');
        },
      },
    );
    expect(await subagent.invoke({ task: 'x' })).toBe('done');
    expect(warnings.join('\n')).toContain('persist failed');
  });

  it('propagates an aborted turn instead of reporting it as the sub-agent’s error', async () => {
    const model = new FakeListChatModel({ responses: ['never'], sleep: 50 });
    const subagent = createSubagentAsTool(specWith(model));
    const controller = new AbortController();
    const pending = subagent.invoke(
      { task: 'x' },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("scopes the call id a tool middleware sees to the dispatch, and hands results back under the model's id", async () => {
    const seen: string[] = [];
    const recorder: AgentMiddleware = {
      name: 'Recorder',
      wrapToolCall: async (request, handler) => {
        seen.push(String(request.toolCall.id));
        if (request.toolCall.name === 'blocked')
          return new ToolMessage({
            content: 'not run',
            tool_call_id: String(request.toolCall.id),
            status: 'error',
          });
        return handler(request);
      },
    };
    const scoped = scopeToolCallIds(recorder, 'p1');
    const wrap = scoped.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');
    const inner: string[] = [];
    const handler = async (request: { toolCall: { id?: string } }) => {
      inner.push(String(request.toolCall.id));
      return new ToolMessage({
        content: 'ran',
        tool_call_id: String(request.toolCall.id),
      });
    };
    const ran = (await wrap(
      {
        toolCall: { id: 's1', name: 'send', args: {} },
        tool: undefined,
        state: { messages: [] },
        runtime: {},
      } as never,
      handler as never,
    )) as ToolMessage;
    expect(seen).toEqual(['p1/s1']);
    expect(inner).toEqual(['s1']);
    expect(ran.tool_call_id).toBe('s1');
    const blocked = (await wrap(
      {
        toolCall: { id: 's1', name: 'blocked', args: {} },
        tool: undefined,
        state: { messages: [] },
        runtime: {},
      } as never,
      handler as never,
    )) as ToolMessage;
    expect(blocked.tool_call_id).toBe('s1');
    expect(blocked.content).toBe('not run');
    // A middleware without a tool hook is passed through as it is.
    const plain: AgentMiddleware = { name: 'Plain' };
    expect(scopeToolCallIds(plain, 'p1')).toBe(plain);
  });
});
