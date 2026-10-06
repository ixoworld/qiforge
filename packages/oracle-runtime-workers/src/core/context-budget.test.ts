import { describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  contextBudgetFor,
  contextKnobs,
  DEFAULT_CONTEXT_KNOBS,
  describeBudget,
  estimateContentTokens,
  messageContentTokens,
  messageToolCallTokens,
} from './context-budget';

const silent = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('contextKnobs', () => {
  it('uses the defaults and only accepts sane values', () => {
    expect(contextKnobs({})).toEqual(DEFAULT_CONTEXT_KNOBS);
    const knobs = contextKnobs(
      {
        CONTEXT_SUMMARIZE_FRACTION: '0.6',
        CONTEXT_PRUNE_FRACTION: '1.5',
        CONTEXT_RESULT_CAP_FRACTION: '0.1',
        CONTEXT_OUTPUT_RESERVE_TOKENS: '4000',
        CONTEXT_SUMMARIZE_MESSAGES: '40',
        CONTEXT_KEEP_MESSAGES: '1',
      },
      silent,
    );
    expect(knobs).toEqual({
      ...DEFAULT_CONTEXT_KNOBS,
      summarizeFraction: 0.6,
      resultCapFraction: 0.1,
      outputReserveTokens: 4000,
      summarizeTriggerMessages: 40,
    });
  });
});

describe('contextKnobs bounds', () => {
  it('accepts a fraction of exactly 1 and integers at their minimum, and nothing outside', () => {
    const warn = vi.fn();
    const knobs = contextKnobs(
      {
        CONTEXT_REQUEST_FRACTION: '1',
        CONTEXT_SUMMARIZE_FRACTION: '0',
        CONTEXT_PRUNE_FRACTION: 'abc',
        CONTEXT_KEEP_MESSAGES: '2',
        CONTEXT_OUTPUT_RESERVE_TOKENS: '255',
        CONTEXT_SUMMARIZE_MESSAGES: '4.5',
        CONTEXT_RESULT_CAP_MAX_CHARS: '   ',
      },
      { log: () => undefined, warn, error: () => undefined },
    );
    expect(knobs).toEqual({
      ...DEFAULT_CONTEXT_KNOBS,
      requestFraction: 1,
      keepMessages: 2,
    });
    // Every rejected value was reported; the blank one is simply unset.
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe('contextBudgetFor', () => {
  const at = (tokens: number) =>
    contextBudgetFor({ model: 'm', tokens, origin: 'catalog' });

  it('scales every limit with the window', () => {
    const small = at(32_000);
    const mid = at(128_000);
    const big = at(1_000_000);
    expect(small).toMatchObject({
      windowTokens: 32_000,
      outputReserveTokens: 8_000,
      requestCapTokens: 22_400,
      summarizeAtTokens: 16_000,
      pruneAtTokens: 11_200,
      resultCapChars: 15_360,
    });
    expect(mid).toMatchObject({
      requestCapTokens: 113_600,
      summarizeAtTokens: 64_000,
      pruneAtTokens: 44_800,
      resultCapChars: 61_440,
    });
    // The result cap stops at its ceiling: 12% of a million tokens would be
    // 480,000 chars.
    expect(big).toMatchObject({
      requestCapTokens: 942_000,
      summarizeAtTokens: 500_000,
      pruneAtTokens: 350_000,
      resultCapChars: 200_000,
    });
    expect(big.summaryInputTokens).toBe(938_000);
    expect(
      contextBudgetFor(
        { model: 'm', tokens: 1_000_000, origin: 'catalog' },
        { ...DEFAULT_CONTEXT_KNOBS, resultCapMaxChars: 1_000_000 },
      ).resultCapChars,
    ).toBe(480_000);
    expect(
      contextKnobs({ CONTEXT_RESULT_CAP_MAX_CHARS: '100000' })
        .resultCapMaxChars,
    ).toBe(100_000);
    // Below the floor the default stays.
    expect(
      contextKnobs({ CONTEXT_RESULT_CAP_MAX_CHARS: '10' }).resultCapMaxChars,
    ).toBe(200_000);
  });

  it('keeps the reply reserve from eating a tiny window and keeps the thresholds ordered', () => {
    const tiny = at(16_000);
    expect(tiny.outputReserveTokens).toBe(4_000);
    expect(tiny.pruneAtTokens).toBeLessThanOrEqual(tiny.summarizeAtTokens);
    expect(tiny.summarizeAtTokens).toBeLessThanOrEqual(tiny.requestCapTokens);
    expect(tiny.requestCapTokens).toBeGreaterThan(0);
  });

  it('carries the optional message trigger and the keep count', () => {
    const b = contextBudgetFor(
      { model: 'm', tokens: 100_000, origin: 'default' },
      {
        ...DEFAULT_CONTEXT_KNOBS,
        summarizeTriggerMessages: 30,
        keepMessages: 6,
      },
    );
    expect(b.summarizeTriggerMessages).toBe(30);
    expect(b.keepMessages).toBe(6);
    expect(at(100_000).summarizeTriggerMessages).toBeUndefined();
  });

  it('never starts summarizing above what the summarizer may read', () => {
    for (const main of [16_000, 32_000, 128_000, 400_000, 1_000_000])
      for (const summarizer of [undefined, 16_000, 131_072, 1_000_000]) {
        const b = contextBudgetFor(
          { model: 'main', tokens: main, origin: 'catalog' },
          DEFAULT_CONTEXT_KNOBS,
          summarizer === undefined
            ? undefined
            : { model: 'routing', tokens: summarizer, origin: 'catalog' },
        );
        expect(b.summarizeAtTokens).toBeLessThanOrEqual(b.summaryInputTokens);
        expect(b.pruneAtTokens).toBeLessThanOrEqual(b.summarizeAtTokens);
      }
  });

  it("bounds what the summarizer reads by the summarizing model's own window", () => {
    const main = { model: 'main', tokens: 400_000, origin: 'catalog' } as const;
    const routing = {
      model: 'routing',
      tokens: 131_072,
      origin: 'catalog',
    } as const;
    const unbounded = contextBudgetFor(main);
    // The main model's cap alone: 95% of 400k, less the reply reserve and
    // the summary prompt margin.
    expect(unbounded.summaryInputTokens).toBe(368_000);
    const bounded = contextBudgetFor(main, DEFAULT_CONTEXT_KNOBS, routing);
    // 95% of 131,072 less the same reserve and margin.
    expect(bounded.summaryInputTokens).toBe(112_518);
    expect(bounded.summaryWindowTokens).toBe(131_072);
    // The history is condensed before it outgrows what the summarizer can
    // read: summarizing (and pruning) starts no later than its input limit.
    expect(bounded.summarizeAtTokens).toBe(112_518);
    expect(bounded.pruneAtTokens).toBe(112_518);
    // The request cap, the reply reserve and the result cap are the main
    // model's.
    expect({
      ...bounded,
      summaryInputTokens: 0,
      summaryWindowTokens: 0,
      summarizeAtTokens: 0,
      pruneAtTokens: 0,
    }).toEqual({
      ...unbounded,
      summaryInputTokens: 0,
      summaryWindowTokens: 0,
      summarizeAtTokens: 0,
      pruneAtTokens: 0,
    });
    expect(describeBudget(bounded)).toContain(
      'summaryInput=112518 (summarizer window 131072)',
    );
    // A summarizer with the larger window never raises the bound.
    expect(
      contextBudgetFor(
        { ...main, tokens: 32_000 },
        DEFAULT_CONTEXT_KNOBS,
        routing,
      ).summaryInputTokens,
    ).toBe(at(32_000).summaryInputTokens);
    // A 16k summarizer: 95% less a quarter-window reserve and the margin.
    expect(
      contextBudgetFor(main, DEFAULT_CONTEXT_KNOBS, {
        ...routing,
        tokens: 16_000,
      }).summaryInputTokens,
    ).toBe(7_200);
    // The floor holds below that.
    expect(
      contextBudgetFor(main, DEFAULT_CONTEXT_KNOBS, {
        ...routing,
        tokens: 4_000,
      }).summaryInputTokens,
    ).toBe(1_000);
  });
});

describe('per-message token estimates', () => {
  it('equal the plain estimates and serialise a message once across many steps', () => {
    let serialised = 0;
    const text = 'x'.repeat(4_000);
    // A content block whose JSON serialisation is counted.
    const block = {
      type: 'text' as const,
      text,
      toJSON() {
        serialised += 1;
        return { type: 'text', text };
      },
    };
    const message = new HumanMessage({ content: [block] });
    const expected = estimateContentTokens(message.content);
    const before = serialised;
    for (let step = 0; step < 10; step += 1)
      expect(messageContentTokens(message)).toBe(expected);
    expect(serialised - before).toBe(1);

    const ai = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c1', name: 'get_x', args: { q: 'y'.repeat(400) } }],
    });
    for (let step = 0; step < 5; step += 1)
      expect(messageToolCallTokens(ai, ai.tool_calls)).toBe(
        estimateContentTokens(ai.tool_calls),
      );
  });

  it('recomputes when a message is given new content', () => {
    const message = new HumanMessage('a'.repeat(400));
    expect(messageContentTokens(message)).toBe(100);
    message.content = 'a'.repeat(800);
    expect(messageContentTokens(message)).toBe(200);
  });
});

describe('estimateContentTokens', () => {
  it('estimates strings and structured content alike', () => {
    expect(estimateContentTokens('a'.repeat(400))).toBe(100);
    expect(
      estimateContentTokens([{ type: 'text', text: 'hi' }]),
    ).toBeGreaterThan(0);
    expect(estimateContentTokens(null)).toBe(0);
  });
});
