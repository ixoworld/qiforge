/**
 * One turn's resource budget, shared by the main agent, every sub-agent it
 * dispatches and the helper models (summarizer, attachment extraction) the
 * turn's LLM adapter hands out. Three limits:
 *
 *   - `tokens`     — cumulative model tokens. A call reserves an estimate
 *                    (chars/4 of what it sends plus the output reserve) before
 *                    it starts and settles to the provider's reported usage
 *                    when the call ends, so the counter is an estimate only
 *                    while a call is in flight.
 *   - `tools`      — tool attempts, counting a sub-agent dispatch and each
 *                    retry of a read.
 *   - `durationMs` — wall clock since the budget was created (the turn's
 *                    deadline; the host aborts the run when it passes).
 *
 * Exhaustion is terminal for the turn: `HarnessLimitError` is not retryable
 * and the work already done (checkpoints, tool results) is kept.
 *
 * Token counts are estimates reconciled against provider usage, never a
 * billing figure; `TURN_RECURSION_LIMIT` stays the separate guard against a
 * runaway graph.
 */
export class HarnessLimitError extends Error {
  readonly retryable = false;

  constructor(
    readonly kind: 'budget_exhausted',
    readonly limit: 'tokens' | 'tools' | 'time',
    message: string,
  ) {
    super(message);
    this.name = 'HarnessLimitError';
  }
}

const LIMITS: ReadonlySet<string> = new Set(['tokens', 'tools', 'time']);

function limitOf(error: Error): HarnessLimitError['limit'] | undefined {
  const value: unknown = Reflect.get(error, 'limit');
  return value === 'tokens' || value === 'tools' || value === 'time'
    ? value
    : undefined;
}

/**
 * The `HarnessLimitError` behind `error`, if there is one. LangChain wraps an
 * error thrown from a middleware in a `MiddlewareError` — same name and
 * message, the original as `cause`, once per middleware layer — so the
 * original (with `kind` and `limit`) is found by walking the causes. A copy
 * of the class from another bundle is recognized by name and fields.
 */
export function harnessLimitOf(error: unknown): HarnessLimitError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 32 && current instanceof Error; depth += 1) {
    if (current instanceof HarnessLimitError) return current;
    const limit = limitOf(current);
    if (current.name === 'HarnessLimitError' && limit && LIMITS.has(limit))
      return new HarnessLimitError('budget_exhausted', limit, current.message);
    current = current.cause;
  }
  return undefined;
}

/** `true` when `error` is, or wraps, a turn-budget exhaustion. */
export function isHarnessLimitError(error: unknown): boolean {
  return harnessLimitOf(error) !== undefined;
}

export interface TurnLimits {
  /** Cumulative model tokens (estimated input + reserved output, settled to usage). */
  tokens: number;
  /** Tool attempts, sub-agent dispatches included. */
  tools: number;
  /** Wall-clock deadline for the turn. */
  durationMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  tokens: 500_000,
  tools: 120,
  durationMs: 600_000,
};

/** Parse the `TURN_*` env knobs; anything unusable keeps its default. */
export function turnLimitsFromEnv(env: {
  TURN_MAX_TOKENS?: number | string;
  TURN_MAX_TOOL_CALLS?: number | string;
  TURN_TIMEOUT_MS?: number | string;
}): TurnLimits {
  const positive = (raw: number | string | undefined, fallback: number) => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    tokens: positive(env.TURN_MAX_TOKENS, DEFAULT_TURN_LIMITS.tokens),
    tools: positive(env.TURN_MAX_TOOL_CALLS, DEFAULT_TURN_LIMITS.tools),
    durationMs: positive(env.TURN_TIMEOUT_MS, DEFAULT_TURN_LIMITS.durationMs),
  };
}

export interface TurnUsage {
  /** Tokens counted so far: settled usage plus in-flight reservations. */
  tokens: number;
  /** Tokens the provider reported (the settled part of `tokens`). */
  reportedTokens: number;
  modelCalls: number;
  toolAttempts: number;
  elapsedMs: number;
  limits: TurnLimits;
}

export class TurnBudget {
  private tokens = 0;
  private reportedTokens = 0;
  private modelCalls = 0;
  private tools = 0;
  private readonly startedAt: number;

  constructor(
    readonly limits: TurnLimits = DEFAULT_TURN_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Throws when the turn was aborted or its deadline passed. */
  check(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? abortError();
    if (this.now() - this.startedAt >= this.limits.durationMs)
      this.fail('time', 'time');
  }

  /**
   * Reserve a model call before it starts. Returns the reservation so the
   * caller can settle it against the provider's usage once the call ends.
   */
  reserveModel(
    estimatedInputTokens: number,
    outputReserveTokens: number,
    signal?: AbortSignal,
  ): number {
    this.check(signal);
    const reservation =
      Math.max(0, estimatedInputTokens) + Math.max(0, outputReserveTokens);
    if (this.tokens + reservation > this.limits.tokens)
      this.fail('tokens', 'token');
    this.tokens += reservation;
    this.modelCalls += 1;
    return reservation;
  }

  /** Replace a reservation with what the provider reported. */
  settleModel(reservation: number, reportedTotalTokens: number): void {
    if (!Number.isFinite(reportedTotalTokens) || reportedTotalTokens < 0)
      return;
    this.tokens += reportedTotalTokens - reservation;
    this.reportedTokens += reportedTotalTokens;
  }

  reserveTool(signal?: AbortSignal): void {
    this.check(signal);
    if (this.tools >= this.limits.tools) this.fail('tools', 'tool-call');
    this.tools += 1;
  }

  snapshot(): TurnUsage {
    return {
      tokens: this.tokens,
      reportedTokens: this.reportedTokens,
      modelCalls: this.modelCalls,
      toolAttempts: this.tools,
      elapsedMs: this.now() - this.startedAt,
      limits: this.limits,
    };
  }

  private fail(limit: HarnessLimitError['limit'], label: string): never {
    throw new HarnessLimitError(
      'budget_exhausted',
      limit,
      `The turn reached its ${label} limit. Completed work is preserved; no further work was started.`,
    );
  }
}

function abortError(): Error {
  const error = new Error('The turn was aborted.');
  error.name = 'AbortError';
  return error;
}
