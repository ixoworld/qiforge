import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { LlmAdapter } from './runtime-context';
import { budgetedLlm } from './budgeted-llm';
import { HarnessLimitError, TurnBudget } from './turn-budget';

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
});
