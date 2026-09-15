import { describe, expect, it } from 'vitest';
import {
  contextBudgetFor,
  contextKnobs,
  DEFAULT_CONTEXT_KNOBS,
  estimateContentTokens,
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
