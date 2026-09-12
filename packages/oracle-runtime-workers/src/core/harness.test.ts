import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { FakeToolCallingModel, createAgent } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TURN_LIMITS, TurnBudget } from './turn-budget';
import { executeTool, ToolScheduler } from './tool-execution';
import type { HarnessStore } from './harness-store';
import { createRequestBudgetMiddleware } from './middlewares/request-budget';
import { budgetedLlm } from './budgeted-llm';
import { createSubagentAsTool } from './subagent-as-tool';

function store(): HarnessStore {
  const pending = new Set<string>();
  const operations = new Map<string, string>();
  const results = new Map<string, string>();
  return {
    async startOperation(_session, key, id) {
      if (pending.has(key)) return false;
      pending.add(key);
      operations.set(id, key);
      return true;
    },
    async completeOperation(id) {
      const key = operations.get(id);
      if (key) pending.delete(key);
    },
    async putResult(_session, content) {
      const id = crypto.randomUUID();
      results.set(id, content);
      return id;
    },
    async readResult(_session, id, offset) {
      return results.get(id)?.slice(offset, offset + 4000) ?? null;
    },
  };
}

describe('Workers execution boundaries', () => {
  it('blocks a later write after losing its receipt, without preventing safe reads', async () => {
    const context = {
      budget: new TurnBudget(),
      scheduler: new ToolScheduler(),
      store: store(),
      sessionId: 's',
    };
    const write = vi.fn(async () => {
      throw new Error('response lost after write');
    });
    await expect(
      executeTool(context, 'send', { body: 'hello' }, 'write', write),
    ).rejects.toThrow('response lost');
    await expect(
      executeTool(context, 'send', { body: 'hello' }, 'write', write),
    ).rejects.toThrow('outcome');
    expect(write).toHaveBeenCalledTimes(1);
    await expect(
      executeTool(context, 'lookup', {}, 'read', async () => 'receipt'),
    ).resolves.toBe('receipt');
  });
  it('allows an intentional later write after a confirmed result', async () => {
    const context = {
      budget: new TurnBudget(),
      scheduler: new ToolScheduler(),
      store: store(),
      sessionId: 's',
    };
    const write = vi.fn(async () => 'confirmed');
    await executeTool(context, 'send', {}, 'write', write);
    await executeTool(context, 'send', {}, 'write', write);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('serializes writes and bounds read concurrency', async () => {
    const scheduler = new ToolScheduler();
    let active = 0;
    let peak = 0;
    const work = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    };
    await Promise.all(
      Array.from({ length: 10 }, () => scheduler.run('write', work)),
    );
    expect(peak).toBe(1);
    peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () => scheduler.run('read', work)),
    );
    expect(peak).toBe(4);
  });
  it('checks cancellation after waiting for a write slot', async () => {
    const controller = new AbortController();
    const context = {
      budget: new TurnBudget(),
      scheduler: new ToolScheduler(),
      sessionId: 's',
      signal: controller.signal,
    };
    controller.abort();
    const work = vi.fn();
    await expect(
      executeTool(context, 'write', {}, 'write', work),
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });
  it('shares token reservations between model roles and stops before the next provider call', async () => {
    const budget = new TurnBudget({ ...DEFAULT_TURN_LIMITS, tokens: 8500 });
    const adapter = budgetedLlm(
      { get: () => new FakeToolCallingModel({ toolCalls: [] }) },
      budget,
      new AbortController().signal,
    );
    await adapter.get('main').invoke('hello');
    await expect(adapter.get('routing').invoke('summary')).rejects.toThrow(
      'token limit',
    );
  });
  it('enforces time and tool budgets without resetting for child work', () => {
    let now = 0;
    const budget = new TurnBudget(
      { ...DEFAULT_TURN_LIMITS, tools: 1, durationMs: 10 },
      () => now,
    );
    budget.reserveTool();
    expect(() => budget.reserveTool()).toThrow('tool-call limit');
    now = 10;
    expect(() => budget.check()).toThrow('time limit');
  });
});

describe('full request budgets', () => {
  it('offloads an oversized retained result without breaking tool-call IDs or changing stored history', async () => {
    const saved = store();
    const put = vi.spyOn(saved, 'putResult');
    const budget = new TurnBudget({
      ...DEFAULT_TURN_LIMITS,
      contextTokens: 16_000,
    });
    const original = new ToolMessage({
      id: 'result',
      name: 'read',
      tool_call_id: 'call',
      content: 'x'.repeat(80_000),
    });
    const model = new FakeToolCallingModel({ toolCalls: [] });
    const agent = createAgent({
      model,
      tools: [],
      middleware: [
        createRequestBudgetMiddleware({ budget, store: saved, sessionId: 's' }),
      ],
    });
    await agent.invoke({
      messages: [
        new HumanMessage('review'),
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call', name: 'read', args: {} }],
        }),
        original,
      ],
    });
    expect(put).toHaveBeenCalledWith('s', 'x'.repeat(80_000));
    expect(original.content).toHaveLength(80_000);
  });
  it('fails irreducible overhead before invoking the model', async () => {
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [] }),
      systemPrompt: 'x'.repeat(50_000),
      tools: [],
      middleware: [
        createRequestBudgetMiddleware({
          budget: new TurnBudget({
            ...DEFAULT_TURN_LIMITS,
            contextTokens: 16_000,
          }),
          sessionId: 's',
        }),
      ],
    });
    await expect(
      agent.invoke({ messages: [new HumanMessage('hello')] }),
    ).rejects.toThrow('context budget');
  });
  it('never fabricates authority after a subagent refusal', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [] });
    vi.spyOn(model, 'bindTools').mockReturnValue(model);
    const invoke = vi.spyOn(model, '_generate').mockResolvedValue({
      generations: [
        {
          text: 'I cannot comply',
          message: new AIMessage('I cannot comply'),
        },
      ],
    });
    const child = createSubagentAsTool({
      name: 'worker',
      description: 'worker',
      systemPrompt: 'work',
      model,
      tools: [
        tool(async () => 'sent', {
          name: 'send',
          description: 'send',
          schema: z.object({}),
        }),
      ],
      userDid: 'u',
      sessionId: 's',
    });
    expect(await child.invoke({ task: 'send' })).toContain('cannot comply');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('bounded recovery', () => {
  it('retries only a safe transient read once and charges both attempts', async () => {
    const budget = new TurnBudget();
    const read = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('temporary'), { status: 503 }),
      )
      .mockResolvedValue('ok');
    await expect(
      executeTool(
        { budget, scheduler: new ToolScheduler(), sessionId: 's' },
        'lookup',
        {},
        'read',
        read,
      ),
    ).resolves.toBe('ok');
    expect(read).toHaveBeenCalledTimes(2);
    expect(budget.snapshot().toolAttempts).toBe(2);
  });
  it('permits only one strictly smaller provider-overflow recovery request', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [] });
    vi.spyOn(model, 'bindTools').mockReturnValue(model);
    const invoke = vi
      .spyOn(model, '_generate')
      .mockRejectedValue(new Error('context_length_exceeded'));
    const agent = createAgent({
      model,
      tools: [],
      middleware: [
        createRequestBudgetMiddleware({
          budget: new TurnBudget(),
          store: store(),
          sessionId: 's',
        }),
      ],
    });
    await expect(
      agent.invoke({
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'c', name: 'read', args: {} }],
          }),
          new ToolMessage({ content: 'x'.repeat(30_000), tool_call_id: 'c' }),
        ],
      }),
    ).rejects.toThrow('No further retry');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(invoke.mock.calls[1]?.[0]).length).toBeLessThan(
      JSON.stringify(invoke.mock.calls[0]?.[0]).length,
    );
  });
  it('enforces model budgets through the graph callback channel, including cloned models', async () => {
    const budget = new TurnBudget({ ...DEFAULT_TURN_LIMITS, tokens: 8500 });
    const llm = budgetedLlm(
      { get: () => new FakeToolCallingModel({ toolCalls: [] }) },
      budget,
      new AbortController().signal,
    );
    const agent = createAgent({ model: llm.get('main'), tools: [] });
    await agent.invoke(
      { messages: [new HumanMessage('hello')] },
      { callbacks: [llm.callback] },
    );
    await expect(
      agent.invoke(
        { messages: [new HumanMessage('again')] },
        { callbacks: [llm.callback] },
      ),
    ).rejects.toThrow('token limit');
  });
});
