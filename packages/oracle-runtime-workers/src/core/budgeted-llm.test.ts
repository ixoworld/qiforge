import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter } from './runtime-context';
import { budgetedLlm } from './budgeted-llm';
import { estimateContentTokens } from './context-budget';
import { HarnessLimitError, TurnBudget } from './turn-budget';

/** A model whose every call fails the way a rejected provider request does. */
class FailingChatModel extends FakeListChatModel {
  override async _generate(): Promise<never> {
    throw new Error("400 This model's maximum context length is 131072 tokens");
  }
}

function adapterOf(model: FakeListChatModel): LlmAdapter {
  return { get: () => model };
}

describe('budgetedLlm', () => {
  it('reserves every model call the adapter hands out and settles reported usage', async () => {
    const budget = new TurnBudget(
      { tokens: 10_000, tools: 10, durationMs: 60_000 },
      () => 0,
    );
    const metered = budgetedLlm(
      adapterOf(new FakeListChatModel({ responses: ['hi'] })),
      {
        budget,
        outputReserveTokens: 100,
      },
    );
    const model = metered.get('routing');
    await model.invoke([new HumanMessage('a'.repeat(400))]);
    // ~100 tokens of input (chars/4) + 4 + the 100 reserved for the reply.
    const afterStart = budget.snapshot();
    expect(afterStart.modelCalls).toBe(1);
    expect(afterStart.tokens).toBeGreaterThanOrEqual(200);
    expect(afterStart.tokens).toBeLessThan(230);
    // The fake model reports no usage; a provider result settles the reservation.
    const handler = metered.callback;
    handler.handleChatModelStart?.(
      {} as never,
      [[new HumanMessage('x')]],
      'run-2',
    );
    handler.handleLLMEnd?.(
      { generations: [], llmOutput: { tokenUsage: { totalTokens: 42 } } },
      'run-2',
    );
    const settled = budget.snapshot();
    expect(settled.modelCalls).toBe(2);
    expect(settled.reportedTokens).toBe(42);
    expect(settled.tokens).toBe(afterStart.tokens + 42);
  });

  it('counts a call reported through both registrations once', async () => {
    const budget = new TurnBudget(
      { tokens: 10_000, tools: 10, durationMs: 60_000 },
      () => 0,
    );
    const metered = budgetedLlm(
      adapterOf(new FakeListChatModel({ responses: ['hi'] })),
      {
        budget,
        outputReserveTokens: 10,
      },
    );
    const model = metered.get('main');
    await model.invoke([new HumanMessage('hello')], {
      callbacks: [metered.callback],
    });
    expect(budget.snapshot().modelCalls).toBe(1);
  });

  it('fails the call that would pass the token limit before the provider is contacted', async () => {
    const budget = new TurnBudget(
      { tokens: 150, tools: 10, durationMs: 60_000 },
      () => 0,
    );
    const metered = budgetedLlm(
      adapterOf(new FakeListChatModel({ responses: ['hi'] })),
      {
        budget,
        outputReserveTokens: 100,
      },
    );
    const model = metered.get('main');
    await model.invoke([new HumanMessage('short')]);
    await expect(model.invoke([new HumanMessage('again')])).rejects.toThrow(
      HarnessLimitError,
    );
    expect(budget.snapshot().modelCalls).toBe(1);
  });

  it('refuses a call once the turn is aborted', async () => {
    const budget = new TurnBudget(
      { tokens: 10_000, tools: 10, durationMs: 60_000 },
      () => 0,
    );
    const controller = new AbortController();
    const metered = budgetedLlm(
      adapterOf(new FakeListChatModel({ responses: ['hi'] })),
      {
        budget,
        outputReserveTokens: 10,
        signal: controller.signal,
      },
    );
    const model = metered.get('main');
    controller.abort(new Error('superseded'));
    await expect(model.invoke([new HumanMessage('x')])).rejects.toThrow(
      'superseded',
    );
  });

  it('gives back the reservation of a failed summary, and keeps that of any other failed call', async () => {
    const budget = new TurnBudget(
      { tokens: 100_000, tools: 10, durationMs: 60_000 },
      () => 0,
    );
    const metered = budgetedLlm(
      adapterOf(new FailingChatModel({ responses: [] })),
      { budget, outputReserveTokens: 100 },
    );
    const model = metered.get('routing');
    const history = [new HumanMessage('h'.repeat(40_000))];
    await expect(
      model.invoke(history, { metadata: { lc_source: 'summarization' } }),
    ).rejects.toThrow('maximum context length');
    expect(budget.snapshot()).toMatchObject({ tokens: 0, modelCalls: 1 });

    await expect(model.invoke(history)).rejects.toThrow(
      'maximum context length',
    );
    expect(budget.snapshot().tokens).toBe(10_000 + 4 + 100);
  });

  it('never settles to a negative or non-finite reported usage', () => {
    const budget = new TurnBudget(
      { tokens: 10_000, tools: 10, durationMs: 60_000 },
      () => 0,
    );
    const handler = budgetedLlm(
      adapterOf(new FakeListChatModel({ responses: ['hi'] })),
      { budget, outputReserveTokens: 100 },
    ).callback;
    handler.handleChatModelStart?.(
      {} as never,
      [[new HumanMessage('a'.repeat(400))]],
      'run-1',
    );
    const reserved = budget.snapshot().tokens;
    handler.handleLLMEnd?.(
      {
        generations: [],
        llmOutput: { tokenUsage: { promptTokens: -50, completionTokens: 3 } },
      },
      'run-1',
    );
    handler.handleChatModelStart?.(
      [] as never,
      [[new HumanMessage('b')]],
      'run-2',
    );
    handler.handleLLMEnd?.(
      {
        generations: [],
        llmOutput: { tokenUsage: { totalTokens: Number.NaN } },
      },
      'run-2',
    );
    const snapshot = budget.snapshot();
    expect(snapshot.reportedTokens).toBe(0);
    expect(snapshot.tokens).toBeGreaterThan(reserved);
    expect(Number.isFinite(snapshot.tokens)).toBe(true);
  });

  it('estimates a tool list once per turn and charges the same as before', () => {
    const budget = new TurnBudget(
      { tokens: 1_000_000, tools: 10, durationMs: 60_000 },
      () => 0,
    );
    const handler = budgetedLlm(
      adapterOf(new FakeListChatModel({ responses: ['hi'] })),
      { budget, outputReserveTokens: 0 },
    ).callback;
    let serialised = 0;
    /** What the provider adapter builds for each call: a fresh array every time. */
    const toolsOf = () =>
      ['get_weather', 'send_email'].map((name) => ({
        type: 'function',
        function: {
          name,
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
        toJSON() {
          serialised += 1;
          return { type: 'function', function: { name } };
        },
      }));
    const message = new HumanMessage('m'.repeat(80));
    const expected =
      estimateContentTokens(message.content) +
      4 +
      estimateContentTokens(toolsOf());
    serialised = 0;
    let before = budget.snapshot().tokens;
    for (let step = 0; step < 5; step += 1) {
      handler.handleChatModelStart?.(
        [] as never,
        [[message]],
        `run-${step}`,
        undefined,
        {
          invocation_params: { tools: toolsOf() },
        },
      );
      const after = budget.snapshot().tokens;
      expect(after - before).toBe(expected);
      before = after;
    }
    // Two tools, serialised in the first step only.
    expect(serialised).toBe(2);
  });
});
