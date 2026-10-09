import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TURN_LIMITS,
  HarnessLimitError,
  TurnBudget,
  harnessLimitOf,
  isHarnessLimitError,
  turnLimitsFromEnv,
} from './turn-budget';

describe('turnLimitsFromEnv', () => {
  it('keeps the defaults for missing or unusable values', () => {
    expect(turnLimitsFromEnv({})).toEqual(DEFAULT_TURN_LIMITS);
    expect(
      turnLimitsFromEnv({
        TURN_MAX_TOOL_CALLS: -3,
        TURN_TIMEOUT_MS: '',
      }),
    ).toEqual(DEFAULT_TURN_LIMITS);
  });

  it('accepts numbers and numeric strings', () => {
    expect(
      turnLimitsFromEnv({
        TURN_MAX_TOOL_CALLS: '7',
        TURN_TIMEOUT_MS: '2500.9',
      }),
    ).toEqual({ tools: 7, durationMs: 2500 });
  });

  it('has no token limit, whatever a deployment still sets', () => {
    const env: Record<string, string> = {
      TURN_MAX_TOKENS: '1000',
      TURN_MAX_TOOL_CALLS: '7',
    };
    const limits = turnLimitsFromEnv(env);
    expect(limits).toEqual({
      tools: 7,
      durationMs: DEFAULT_TURN_LIMITS.durationMs,
    });
    expect(Object.keys(limits)).not.toContain('tokens');
  });
});

describe('TurnBudget', () => {
  const limits = { tools: 2, durationMs: 5_000 };

  it('reserves an estimate for a model call and settles it to the reported usage', () => {
    const budget = new TurnBudget(limits, () => 0);
    const reservation = budget.reserveModel(300, 100);
    expect(reservation).toBe(400);
    expect(budget.snapshot()).toMatchObject({
      tokens: 400,
      reportedTokens: 0,
      modelCalls: 1,
    });
    budget.settleModel(reservation, 250);
    expect(budget.snapshot()).toMatchObject({
      tokens: 250,
      reportedTokens: 250,
    });
  });

  it('never refuses a model call on its token count, however large, and still reports every token', () => {
    const budget = new TurnBudget(limits, () => 0);
    // Far beyond the 500,000 a turn was once capped at: a long thread
    // re-sends its whole history on every call.
    const calls = 40;
    const perCall = 989_500;
    for (let i = 0; i < calls; i += 1) {
      const reservation = budget.reserveModel(perCall, 8_000);
      expect(reservation).toBe(perCall + 8_000);
      budget.settleModel(reservation, perCall + 1_000);
    }
    expect(budget.snapshot()).toMatchObject({
      tokens: calls * (perCall + 1_000),
      reportedTokens: calls * (perCall + 1_000),
      modelCalls: calls,
    });
    // Unsettled reservations of any size are admitted too.
    expect(() =>
      budget.reserveModel(Number.MAX_SAFE_INTEGER, 8_000),
    ).not.toThrow();
    expect(budget.snapshot().modelCalls).toBe(calls + 1);
    expect(budget.snapshot().limits).toEqual(limits);
  });

  it('ignores unusable provider usage and gives back only what was reserved', () => {
    const budget = new TurnBudget(limits, () => 0);
    const reservation = budget.reserveModel(300, 100);
    for (const usage of [Number.NaN, -1, Number.POSITIVE_INFINITY])
      budget.settleModel(reservation, usage);
    expect(budget.snapshot()).toMatchObject({ tokens: 400, reportedTokens: 0 });
    // A negative or non-finite estimate reserves nothing for it.
    expect(budget.reserveModel(-50, Number.NaN)).toBe(0);
    budget.releaseModel(reservation);
    expect(budget.snapshot()).toMatchObject({ tokens: 0, modelCalls: 2 });
    // Nothing to give back below zero, and nonsense is ignored.
    budget.releaseModel(400);
    budget.releaseModel(Number.NaN);
    budget.releaseModel(-10);
    expect(budget.snapshot().tokens).toBe(0);
  });

  it('counts tool attempts and refuses the one past the limit', () => {
    const budget = new TurnBudget(limits, () => 0);
    budget.reserveTool();
    budget.reserveTool();
    expect(() => budget.reserveTool()).toThrow(/tool-call limit/);
    expect(budget.snapshot().toolAttempts).toBe(2);
  });

  it('fails every reservation once the deadline passed', () => {
    let now = 0;
    const budget = new TurnBudget(limits, () => now);
    budget.reserveTool();
    now = 5_000;
    expect(() => budget.check()).toThrow(/time limit/);
    expect(() => budget.reserveModel(1, 1)).toThrow(/time limit/);
    expect(budget.snapshot().elapsedMs).toBe(5_000);
  });

  it('throws the abort reason of an aborted turn before any limit', () => {
    const budget = new TurnBudget(limits, () => 0);
    const controller = new AbortController();
    const reason = new Error('superseded');
    controller.abort(reason);
    expect(() => budget.reserveTool(controller.signal)).toThrow(reason);
    expect(budget.snapshot().toolAttempts).toBe(0);
  });
});

describe('harnessLimitOf', () => {
  it('finds the original through LangChain’s middleware wrapping', () => {
    const original = new HarnessLimitError('budget_exhausted', 'tools', 'hit');
    // What `MiddlewareError` does, once per layer: same name and message,
    // no fields, the error as `cause`.
    const wrap = (inner: Error): Error => {
      const outer = new Error(inner.message, { cause: inner });
      outer.name = inner.name;
      return outer;
    };
    const wrapped = wrap(wrap(original));
    expect(harnessLimitOf(wrapped)).toBe(original);
    expect(isHarnessLimitError(wrapped)).toBe(true);
  });

  it('recognizes a copy of the class by name and fields, and nothing else', () => {
    const copy = Object.assign(new Error('hit'), {
      name: 'HarnessLimitError',
      limit: 'time',
    });
    expect(harnessLimitOf(copy)).toMatchObject({
      kind: 'budget_exhausted',
      limit: 'time',
      message: 'hit',
    });
    const nameOnly = Object.assign(new Error('x'), {
      name: 'HarnessLimitError',
    });
    expect(harnessLimitOf(nameOnly)).toBeUndefined();
    expect(isHarnessLimitError(new Error('fetch failed'))).toBe(false);
    expect(isHarnessLimitError('HarnessLimitError')).toBe(false);
  });
});
