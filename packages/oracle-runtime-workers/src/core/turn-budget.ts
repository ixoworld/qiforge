export class HarnessLimitError extends Error {
  readonly retryable = false;
  constructor(
    readonly kind: 'budget_exhausted' | 'context_overflow',
    message: string,
  ) {
    super(message);
    this.name = 'HarnessLimitError';
  }
}

export interface TurnLimits {
  tokens: number;
  tools: number;
  durationMs: number;
  contextTokens: number;
  outputTokens: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  tokens: 500_000,
  tools: 120,
  durationMs: 600_000,
  contextTokens: 100_000,
  outputTokens: 8_000,
};

/** Conservative text estimate, not provider billing or a monetary guarantee. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(
    new TextEncoder().encode(
      typeof value === 'string' ? value : (JSON.stringify(value) ?? ''),
    ).length / 3,
  );
}

/** One instance per turn, shared by the parent, children and summary model. */
export class TurnBudget {
  private tokens = 0;
  private tools = 0;
  private readonly startedAt: number;
  constructor(
    readonly limits: TurnLimits = DEFAULT_TURN_LIMITS,
    private readonly now = Date.now,
  ) {
    this.startedAt = now();
  }
  check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.now() - this.startedAt >= this.limits.durationMs)
      this.fail('time');
  }
  reserveModel(inputTokens: number, signal?: AbortSignal): void {
    this.check(signal);
    const reservation = inputTokens + this.limits.outputTokens;
    if (this.tokens + reservation > this.limits.tokens) this.fail('token');
    this.tokens += reservation;
  }
  reserveTool(signal?: AbortSignal): void {
    this.check(signal);
    if (this.tools >= this.limits.tools) this.fail('tool-call');
    this.tools++;
  }
  snapshot() {
    return {
      reservedTokens: this.tokens,
      toolAttempts: this.tools,
      elapsedMs: this.now() - this.startedAt,
    };
  }
  private fail(limit: string): never {
    throw new HarnessLimitError(
      'budget_exhausted',
      `The turn reached its ${limit} limit. Completed work is preserved; no further work was started.`,
    );
  }
}
