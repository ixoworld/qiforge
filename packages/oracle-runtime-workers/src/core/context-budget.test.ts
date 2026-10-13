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
        CONTEXT_SUMMARIZE_FRACTION: '0.7',
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
      summarizeFraction: 0.7,
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
      // 60% would be 19,200: clamped to what the summarizer reads.
      summarizeAtTokens: 18_400,
      pruneAtTokens: 11_200,
      resultCapChars: 15_360,
    });
    expect(mid).toMatchObject({
      requestCapTokens: 113_600,
      summarizeAtTokens: 76_800,
      pruneAtTokens: 44_800,
      resultCapChars: 61_440,
    });
    // The result cap stops at its ceiling: 12% of a million tokens would be
    // 480,000 chars.
    expect(big).toMatchObject({
      requestCapTokens: 942_000,
      summarizeAtTokens: 600_000,
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

  it("summarizes at 60% of the main model's window, whatever its size", () => {
    // The mainnet default model: 1,050,000 tokens.
    const large = at(1_050_000);
    expect(large).toMatchObject({
      windowTokens: 1_050_000,
      outputReserveTokens: 8_000,
      requestCapTokens: 989_500,
      summarizeAtTokens: 630_000,
      pruneAtTokens: 367_500,
      summaryInputTokens: 985_500,
    });
    expect(describeBudget(large)).toBe(
      'model=m window=1050000 (catalog) summarizeAt=630000 pruneAt=367500 resultCap=200000c requestCap=989500 reserve=8000 summaryInput=985500',
    );
    const small = at(64_000);
    expect(small).toMatchObject({
      requestCapTokens: 52_800,
      summarizeAtTokens: 38_400,
      pruneAtTokens: 22_400,
      summaryInputTokens: 48_800,
    });
    for (const window of [64_000, 131_072, 400_000, 1_050_000])
      expect(at(window).summarizeAtTokens).toBe(Math.floor(window * 0.6));
  });

  it('never starts summarizing above what the summarizer may read', () => {
    const windows = [
      4_000, 16_000, 24_000, 32_000, 34_000, 34_300, 35_000, 64_000, 128_000,
      131_072, 400_000, 1_000_000, 1_050_000,
    ];
    for (const window of windows) {
      const b = at(window);
      expect(b.summarizeAtTokens).toBeLessThanOrEqual(b.summaryInputTokens);
      expect(b.summarizeAtTokens).toBeLessThanOrEqual(b.requestCapTokens);
      expect(b.pruneAtTokens).toBeLessThanOrEqual(b.summarizeAtTokens);
    }
    // Also with a raised fraction: the trigger stops at the summary input.
    for (const window of windows) {
      const b = contextBudgetFor(
        { model: 'm', tokens: window, origin: 'catalog' },
        { ...DEFAULT_CONTEXT_KNOBS, summarizeFraction: 1 },
      );
      expect(b.summarizeAtTokens).toBe(b.summaryInputTokens);
    }
  });

  it('clamps the trigger to the summary input only below a ~34.3k window', () => {
    // 60% of the window is above 95% of it less the reply reserve and the
    // summary prompt margin: the clamp holds the earlier summary in what
    // the summarizer reads.
    expect(at(16_000)).toMatchObject({
      outputReserveTokens: 4_000,
      requestCapTokens: 11_200,
      summaryInputTokens: 7_200,
      summarizeAtTokens: 7_200,
    });
    expect(at(32_000)).toMatchObject({
      requestCapTokens: 22_400,
      summaryInputTokens: 18_400,
      summarizeAtTokens: 18_400,
    });
    // From ~34.3k up the plain fraction applies.
    for (const window of [34_300, 35_000, 64_000, 128_000, 1_050_000])
      expect(at(window).summarizeAtTokens).toBe(Math.floor(window * 0.6));
    // The summarizer's input floor holds for the smallest windows.
    expect(at(4_000).summaryInputTokens).toBe(1_000);
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
