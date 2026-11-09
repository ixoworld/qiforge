import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import type { AgentMiddleware } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSubagentAsTool,
  filterForwardedMessages,
  FORWARDED_FROM_KEY,
  scopeToolCallIds,
  SUBAGENT_FALLBACK_RESULT_CHARS,
  subAgentResultText,
  type AgentSpec,
} from './subagent-as-tool';

const noop = tool(async () => 'ok', {
  name: 'noop',
  description: 'does nothing',
  schema: z.object({}),
});

class FailingModel extends FakeListChatModel {
  override async _generate(): Promise<never> {
    throw new Error('Host not allowed');
  }
}

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

  it('adds the failure hint to the error the parent reads when the sub-agent could not run', async () => {
    const failing = new FailingModel({ responses: [] });
    const subagent = createSubagentAsTool(
      specWith(failing, { failureHint: 'Try the other capability.' }),
    );
    const result = await subagent.invoke({ task: 'x' });
    expect(String(result)).toMatch(/^Error running Research Agent: /);
    expect(String(result).endsWith(' Try the other capability.')).toBe(true);
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

  it('marks a forwarding sub-agent’s run with the parent call its forwarded calls are stored under', async () => {
    const runMetadata = async (forwardTools?: string[]) => {
      const seen: Record<string, unknown>[] = [];
      const subagent = createSubagentAsTool(
        specWith(new FakeListChatModel({ responses: ['done'] })),
        forwardTools ? { forwardTools } : undefined,
      );
      await subagent.invoke(
        {
          id: 'call_parent',
          name: subagent.name,
          args: { task: 'x' },
          type: 'tool_call',
        },
        {
          callbacks: [
            {
              handleChatModelStart: (...args: unknown[]) => {
                seen.push((args[6] as Record<string, unknown>) ?? {});
              },
            },
          ],
        },
      );
      return seen;
    };
    const forwarding = await runMetadata(['noop']);
    expect(forwarding.length).toBeGreaterThan(0);
    expect(forwarding[0]?.[FORWARDED_FROM_KEY]).toBe('call_parent');
    const plain = await runMetadata();
    expect(plain[0]?.[FORWARDED_FROM_KEY]).toBeUndefined();
  });
});

describe('subAgentResultText', () => {
  it("is the sub-agent's final reply when it has one", () => {
    expect(
      subAgentResultText(
        [new HumanMessage('task'), new AIMessage('PASS, recorded')],
        'risk',
      ),
    ).toBe('PASS, recorded');
  });

  it('is its last tool result, labelled, when it ended on an empty reply', () => {
    const messages = [
      new HumanMessage('task'),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 's1', name: 'submit_section', args: {}, type: 'tool_call' },
        ],
      }),
      new ToolMessage({
        tool_call_id: 's1',
        name: 'submit_section',
        content: '{"submitted":"risk","stage":"evaluate"}',
      }),
      new AIMessage(''),
    ];
    expect(subAgentResultText(messages, 'risk')).toBe(
      'risk finished without a reply. Its last tool call (submit_section) returned: {"submitted":"risk","stage":"evaluate"}',
    );
  });

  it(`cuts a long last tool result to ${SUBAGENT_FALLBACK_RESULT_CHARS} characters`, () => {
    const text = subAgentResultText(
      [
        new ToolMessage({
          tool_call_id: 'r',
          name: 'read',
          content: 'y'.repeat(10_000),
        }),
        new AIMessage(''),
      ],
      'reader',
    );
    expect(text.endsWith('y'.repeat(SUBAGENT_FALLBACK_RESULT_CHARS))).toBe(
      true,
    );
    expect(text).not.toContain('y'.repeat(SUBAGENT_FALLBACK_RESULT_CHARS + 1));
  });

  it('says so when there is neither a reply nor a tool result', () => {
    expect(subAgentResultText([new AIMessage('')], 'idle')).toBe(
      'idle finished without a reply.',
    );
  });
});

describe('filterForwardedMessages', () => {
  it('marks every forwarded message with the parent call it came from', () => {
    const forwarded = filterForwardedMessages(
      [
        new HumanMessage('task'),
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 's1', name: 'submit_section', args: {}, type: 'tool_call' },
            { id: 'r1', name: 'read_blueprint', args: {}, type: 'tool_call' },
          ],
        }),
        new ToolMessage({
          tool_call_id: 's1',
          name: 'submit_section',
          content: 'ok',
        }),
        new ToolMessage({
          tool_call_id: 'r1',
          name: 'read_blueprint',
          content: 'big',
        }),
      ],
      new Set(['submit_section']),
      'parent-1',
    );
    expect(
      forwarded.map((m) => [m.type, m.additional_kwargs[FORWARDED_FROM_KEY]]),
    ).toEqual([
      ['ai', 'parent-1'],
      ['tool', 'parent-1'],
    ]);
    expect((forwarded[1] as ToolMessage).tool_call_id).toBe('parent-1_s1');
  });
});
