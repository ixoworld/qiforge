import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel, type AgentMiddleware } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GraphInterrupt } from '@langchain/langgraph';
import { UNCERTAIN_WRITE_NOTE } from './middlewares/tool-error-result';
import {
  createToolExecutionMiddleware,
  uncertainWriteToolResult,
} from './middlewares/tool-execution';
import { createToolRepetitionGuardMiddleware } from './middlewares/tool-repetition-guard';
import { makeClaimStore } from './test-fixtures';
import { ToolScheduler } from './tool-scheduler';
import { isHarnessLimitError, TurnBudget } from './turn-budget';
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

/** What `@langchain/mcp-adapters` throws for an MCP `isError` result (its class is not exported). */
function toolException(message: string): Error {
  const error = new Error(message);
  error.name = 'ToolException';
  return error;
}

class FailingModel extends FakeListChatModel {
  override async _generate(): Promise<never> {
    throw new Error('Host not allowed');
  }
}

function specWith(
  model: NonNullable<AgentSpec['model']>,
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

  describe('a tool that throws inside the sub-agent', () => {
    const blockedError =
      "MCP tool 'firecrawl_scrape' on server 'firecrawl' returned an error: Request failed with status code 403";
    const fetchPage = (onCall?: () => void) =>
      tool(
        async ({ url }: { url: string }) => {
          onCall?.();
          if (url.includes('blocked')) throw toolException(blockedError);
          return `content of ${url}`;
        },
        {
          name: 'fetch_page',
          description: 'fetches a page',
          schema: z.object({ url: z.string() }),
        },
      );
    const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

    it('hands the error to the sub-agent as the call’s result; it carries on and answers', async () => {
      const model = new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: 'fetch_page',
              args: { url: 'https://blocked.example' },
              id: 'c1',
            },
          ],
          [
            {
              name: 'fetch_page',
              args: { url: 'https://open.example' },
              id: 'c2',
            },
          ],
          [],
        ],
      });
      const log = logger();
      let seen: BaseMessage[] = [];
      // An inner layer (as the execution middleware is) still sees the
      // thrown error itself.
      const innerSaw: unknown[] = [];
      const inner: AgentMiddleware = {
        name: 'Inner',
        wrapToolCall: async (request, handler) => {
          try {
            return await handler(request);
          } catch (error) {
            innerSaw.push(error);
            throw error;
          }
        },
      };
      const subagent = createSubagentAsTool(
        specWith(model, {
          tools: [fetchPage()],
          logger: log,
          dispatchMiddleware: () => [inner],
        }),
        {
          onComplete: (messages) => {
            seen = messages;
          },
        },
      );
      const result = String(await subagent.invoke({ task: 'read both' }));
      expect(result).not.toMatch(/^Error running/);
      expect(result).toContain('content of https://open.example');
      const results = seen.filter((m): m is ToolMessage =>
        ToolMessage.isInstance(m),
      );
      expect(results.map((m) => [m.tool_call_id, m.status])).toEqual([
        ['c1', 'error'],
        ['c2', 'success'],
      ]);
      expect(results[0]?.content).toBe(`fetch_page failed: ${blockedError}`);
      expect(innerSaw).toHaveLength(1);
      expect(innerSaw[0]).toHaveProperty('name', 'ToolException');
      expect(log.log).toHaveBeenCalledWith(
        `[tool-error] Research Agent: fetch_page (c1) threw; the error is its result: ${blockedError}`,
      );
    });

    it('lets the repetition guard refuse the identical call that already failed', async () => {
      let calls = 0;
      const model = new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: 'fetch_page',
              args: { url: 'https://blocked.example' },
              id: 'c1',
            },
          ],
          [
            {
              name: 'fetch_page',
              args: { url: 'https://blocked.example' },
              id: 'c2',
            },
          ],
          [],
        ],
      });
      let seen: BaseMessage[] = [];
      const subagent = createSubagentAsTool(
        specWith(model, {
          tools: [fetchPage(() => (calls += 1))],
          dispatchMiddleware: () => [createToolRepetitionGuardMiddleware()],
        }),
        {
          onComplete: (messages) => {
            seen = messages;
          },
        },
      );
      await subagent.invoke({ task: 'read it' });
      expect(calls).toBe(1);
      const second = seen.find(
        (m): m is ToolMessage =>
          ToolMessage.isInstance(m) && m.tool_call_id === 'c2',
      );
      expect(second?.status).toBe('error');
      expect(String(second?.content)).toContain(
        'You already called `fetch_page` with these exact arguments',
      );
    });

    it('still ends the turn when the tool aborted it, without handing the abort to the model', async () => {
      const controller = new AbortController();
      const aborting = tool(
        async () => {
          controller.abort();
          throw new DOMException('The operation was aborted', 'AbortError');
        },
        {
          name: 'fetch_page',
          description: 'fetches a page',
          schema: z.object({}),
        },
      );
      const model = new FakeToolCallingModel({
        toolCalls: [[{ name: 'fetch_page', args: {}, id: 'c1' }], []],
      });
      const log = logger();
      const onComplete = vi.fn();
      const subagent = createSubagentAsTool(
        specWith(model, { tools: [aborting], logger: log }),
        { onComplete },
      );
      await expect(
        subagent.invoke({ task: 'x' }, { signal: controller.signal }),
      ).rejects.toThrow();
      expect(onComplete).not.toHaveBeenCalled();
      expect(log.log).not.toHaveBeenCalledWith(
        expect.stringContaining('[tool-error]'),
      );
    });

    it('still ends the turn when the execution middleware finds it out of budget', async () => {
      let ran = 0;
      const model = new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: 'fetch_page',
              args: { url: 'https://a.example' },
              id: 'c1',
            },
          ],
          [
            {
              name: 'fetch_page',
              args: { url: 'https://b.example' },
              id: 'c2',
            },
          ],
          [],
        ],
      });
      // One tool attempt allowed: the second call's reserve throws inside
      // the execution middleware, so it arrives wrapped in a MiddlewareError.
      const execution = createToolExecutionMiddleware({
        budget: new TurnBudget({ tools: 1, durationMs: 60_000 }, () => 0),
        scheduler: new ToolScheduler(),
        laneOf: () => 'read',
        effectOf: () => 'read',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      const onComplete = vi.fn();
      const subagent = createSubagentAsTool(
        specWith(model, {
          tools: [fetchPage(() => (ran += 1))],
          dispatchMiddleware: () => [execution],
        }),
        { onComplete },
      );
      await expect(subagent.invoke({ task: 'x' })).rejects.toSatisfy(
        (error: unknown) => isHarnessLimitError(error),
      );
      expect(ran).toBe(1);
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('never hands a LangGraph interrupt from an inner tool to the model', async () => {
      const interrupting = tool(
        async () => {
          throw new GraphInterrupt([]);
        },
        {
          name: 'fetch_page',
          description: 'fetches a page',
          schema: z.object({}),
        },
      );
      const model = new FakeToolCallingModel({
        toolCalls: [[{ name: 'fetch_page', args: {}, id: 'c1' }], []],
      });
      const log = logger();
      let seen: BaseMessage[] = [];
      const subagent = createSubagentAsTool(
        specWith(model, { tools: [interrupting], logger: log }),
        {
          onComplete: (messages) => {
            seen = messages;
          },
        },
      );
      // Standalone (no parent run), LangGraph ends the graph at the
      // interrupt; nested in a parent run it throws out of the dispatch,
      // which re-throws graph bubble-ups. Either way the call gets no result
      // and the model is not asked again.
      await subagent.invoke({ task: 'x' });
      expect(seen.some((m) => ToolMessage.isInstance(m))).toBe(false);
      expect(seen.filter((m) => AIMessage.isInstance(m))).toHaveLength(1);
      expect(log.log).not.toHaveBeenCalledWith(
        expect.stringContaining('[tool-error]'),
      );
    });

    it('reports a schema rejection to the sub-agent, which carries on', async () => {
      const model = new FakeToolCallingModel({
        toolCalls: [
          [{ name: 'fetch_page', args: { url: 42 }, id: 'c1' }],
          [
            {
              name: 'fetch_page',
              args: { url: 'https://open.example' },
              id: 'c2',
            },
          ],
          [],
        ],
      });
      let seen: BaseMessage[] = [];
      const subagent = createSubagentAsTool(
        specWith(model, {
          tools: [fetchPage()],
          dispatchMiddleware: () => [createToolRepetitionGuardMiddleware()],
        }),
        {
          onComplete: (messages) => {
            seen = messages;
          },
        },
      );
      const result = String(await subagent.invoke({ task: 'x' }));
      expect(result).not.toMatch(/^Error running/);
      const first = seen.find(
        (m): m is ToolMessage =>
          ToolMessage.isInstance(m) && m.tool_call_id === 'c1',
      );
      expect(first?.status).toBe('error');
      expect(String(first?.content)).toMatch(
        /^Invalid arguments for fetch_page: /,
      );
      expect(String(first?.content)).not.toMatch(/\n\s+at |kwargs/);
      expect(result).toContain('content of https://open.example');
    });

    it('keeps the claim of a write whose outcome is unknown and refuses the identical write', async () => {
      let sent = 0;
      const send = tool(
        async () => {
          sent += 1;
          throw new TypeError('fetch failed');
        },
        {
          name: 'send_payment',
          description: 'sends a payment',
          schema: z.object({ to: z.string() }),
        },
      );
      const model = new FakeToolCallingModel({
        toolCalls: [
          [{ name: 'send_payment', args: { to: 'bob' }, id: 'c1' }],
          [{ name: 'send_payment', args: { to: 'bob' }, id: 'c2' }],
          [],
        ],
      });
      const claims = makeClaimStore();
      const execution = createToolExecutionMiddleware({
        budget: new TurnBudget({ tools: 5, durationMs: 60_000 }, () => 0),
        scheduler: new ToolScheduler(),
        laneOf: () => 'write',
        effectOf: () => 'write',
        runId: 'run-1',
        sessionId: 'session-1',
        claims: claims.store,
      });
      let seen: BaseMessage[] = [];
      const subagent = createSubagentAsTool(
        specWith(model, {
          tools: [send],
          effectOf: () => 'write',
          dispatchMiddleware: (dispatch) => [
            scopeToolCallIds(execution, dispatch),
          ],
        }),
        {
          onComplete: (messages) => {
            seen = messages;
          },
        },
      );
      await subagent.invoke({ task: 'pay bob' });
      expect(sent).toBe(1);
      const [first, second] = seen.filter((m): m is ToolMessage =>
        ToolMessage.isInstance(m),
      );
      expect(first?.status).toBe('error');
      expect(first?.content).toBe(
        `send_payment failed: fetch failed\n\n${UNCERTAIN_WRITE_NOTE}`,
      );
      expect(second?.status).toBe('error');
      expect(second?.content).toBe(uncertainWriteToolResult('send_payment'));
      expect(claims.rows.size).toBe(1);
    });
  });

  it('warns when the sub-agent itself fails', async () => {
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const subagent = createSubagentAsTool(
      specWith(new FailingModel({ responses: [] }), { logger: log }),
    );
    expect(String(await subagent.invoke({ task: 'x' }))).toMatch(
      /^Error running Research Agent: /,
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Research Agent: the sub-agent failed: /),
    );
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

  it('keeps a failed call failed', () => {
    const [, result] = filterForwardedMessages(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 's1', name: 'submit_section', args: {}, type: 'tool_call' },
          ],
        }),
        new ToolMessage({
          tool_call_id: 's1',
          name: 'submit_section',
          content: 'submit_section failed: section too long',
          status: 'error',
        }),
      ],
      new Set(['submit_section']),
      'parent-1',
    );
    expect(ToolMessage.isInstance(result) && result.status).toBe('error');
  });
});
