import { z } from 'zod';

/**
 * Per-turn resource ceilings. One recursion number is not a resource model:
 * a turn can be cheap in steps and ruinous in wall time or output volume.
 * The tracker enforces each ceiling where the runtime can observe it — tool
 * calls and wall time in the execution broker, model calls in the budget
 * middleware, output size on tool results.
 *
 * `maxConcurrency` is declared for forward compatibility and currently
 * logged as unenforced — in-process tool fan-out is bounded by the model's
 * parallel tool calls today.
 */
export interface TurnBudget {
  /** Wall-clock ceiling for one turn, main agent + sub-agents combined. */
  wallMs: number;
  /** Model invocations per turn (main + sub-agent loops). */
  maxModelCalls: number;
  /** Tool executions per turn (main + sub-agent loops). */
  maxToolCalls: number;
  /** Ceiling on a single tool result's serialized size. */
  maxOutputBytes: number;
  /** Per-tool execution timeout applied by the broker. */
  perToolTimeoutMs: number;
  /** Declared but not yet enforced in-process. */
  maxConcurrency: number;
}

export const turnBudgetSchema: z.ZodType<Partial<TurnBudget>> = z.object({
  wallMs: z.number().int().positive().optional(),
  maxModelCalls: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  perToolTimeoutMs: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
});

/**
 * Generous defaults: bound runaway turns without touching legitimate long
 * flows (the sandbox MCP call alone can take 3 minutes). Operators tighten
 * per oracle via `TURN_BUDGET_JSON` today and the config document later.
 */
export const DEFAULT_TURN_BUDGET: TurnBudget = {
  wallMs: 30 * 60 * 1000,
  maxModelCalls: 128,
  maxToolCalls: 256,
  maxOutputBytes: 4 * 1024 * 1024,
  perToolTimeoutMs: 5 * 60 * 1000,
  maxConcurrency: 16,
};

export class BudgetExceededError extends Error {
  constructor(
    readonly ceiling: keyof TurnBudget,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(
      `Turn budget exceeded: ${ceiling} limit ${limit}, observed ${observed}.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** Live counters for one turn. Shared across the main agent and every
 * sub-agent invocation in the same request, so nesting cannot escape it. */
export interface TurnBudgetTracker {
  readonly budget: TurnBudget;
  /** Throws `BudgetExceededError` when the next tool call would exceed a ceiling. */
  beforeToolCall(): void;
  /** Throws `BudgetExceededError` when the next model call would exceed a ceiling. */
  beforeModelCall(): void;
  /** Validates one tool result's size. Throws on breach. */
  checkOutputSize(serializedLength: number): void;
  snapshot(): { toolCalls: number; modelCalls: number; elapsedMs: number };
}

export function resolveTurnBudget(overrides?: Partial<TurnBudget>): TurnBudget {
  return { ...DEFAULT_TURN_BUDGET, ...(overrides ?? {}) };
}

/** Parse the `TURN_BUDGET_JSON` env value; invalid JSON fails loudly at boot. */
export function parseTurnBudgetEnv(
  raw: unknown,
): Partial<TurnBudget> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return turnBudgetSchema.parse(parsed);
}

export function createTurnBudgetTracker(
  budget: TurnBudget,
  now: () => number = () => Date.now(),
): TurnBudgetTracker {
  const startedAt = now();
  let toolCalls = 0;
  let modelCalls = 0;

  const checkWall = (): void => {
    const elapsed = now() - startedAt;
    if (elapsed > budget.wallMs) {
      throw new BudgetExceededError('wallMs', budget.wallMs, elapsed);
    }
  };

  return {
    budget,
    beforeToolCall() {
      checkWall();
      toolCalls += 1;
      if (toolCalls > budget.maxToolCalls) {
        throw new BudgetExceededError(
          'maxToolCalls',
          budget.maxToolCalls,
          toolCalls,
        );
      }
    },
    beforeModelCall() {
      checkWall();
      modelCalls += 1;
      if (modelCalls > budget.maxModelCalls) {
        throw new BudgetExceededError(
          'maxModelCalls',
          budget.maxModelCalls,
          modelCalls,
        );
      }
    },
    checkOutputSize(serializedLength) {
      if (serializedLength > budget.maxOutputBytes) {
        throw new BudgetExceededError(
          'maxOutputBytes',
          budget.maxOutputBytes,
          serializedLength,
        );
      }
    },
    snapshot() {
      return { toolCalls, modelCalls, elapsedMs: now() - startedAt };
    },
  };
}
