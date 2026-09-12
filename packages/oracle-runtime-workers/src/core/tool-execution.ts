import type { HarnessStore } from './harness-store';
import { operationKey } from './harness-store';
import type { TurnBudget } from './turn-budget';

export type ToolEffect = 'read' | 'write';

/** Shared per user object: mutations serialize even across simultaneous sessions. */
export class ToolScheduler {
  private writing: Promise<void> = Promise.resolve();
  private readers = 0;
  private readonly waiting: Array<() => void> = [];
  private children = 0;
  private readonly childWaiting: Array<() => void> = [];
  async runSubagent<T>(action: () => Promise<T>): Promise<T> {
    if (this.children >= 4)
      await new Promise<void>((resolve) => this.childWaiting.push(resolve));
    else this.children++;
    try {
      return await action();
    } finally {
      const next = this.childWaiting.shift();
      if (next) next();
      else this.children--;
    }
  }
  async run<T>(effect: ToolEffect, action: () => Promise<T>): Promise<T> {
    if (effect === 'write') {
      const previous = this.writing;
      let release!: () => void;
      this.writing = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    }
    if (this.readers >= 4)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.readers++;
    try {
      return await action();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.readers--;
    }
  }
}

export interface ToolExecutionContext {
  budget: TurnBudget;
  scheduler: ToolScheduler;
  store?: HarnessStore;
  sessionId: string;
  requestId?: string;
  signal?: AbortSignal;
}

export async function executeTool<T>(
  context: ToolExecutionContext,
  name: string,
  args: unknown,
  effect: ToolEffect,
  action: () => Promise<T>,
): Promise<T> {
  return context.scheduler.run(effect, async () => {
    context.budget.reserveTool(context.signal);
    if (context.requestId)
      await context.store?.recordUsage?.(
        context.requestId,
        context.sessionId,
        context.budget.snapshot(),
      );
    const operationId = crypto.randomUUID();
    if (effect === 'write' && context.store) {
      const acquired = await context.store.startOperation(
        context.sessionId,
        await operationKey(name, args),
        operationId,
      );
      if (!acquired)
        throw new Error(
          `The outcome of an earlier ${name} operation is unknown. Reconcile its external receipt before repeating it.`,
        );
    }
    // A thrown error/abort intentionally leaves the pending record in place.
    let result: T;
    try {
      result = await action();
    } catch (error) {
      if (effect !== 'read' || !isTransientReadError(error)) throw error;
      context.budget.check(context.signal);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 100 + Math.floor(Math.random() * 100)),
      );
      context.budget.reserveTool(context.signal);
      if (context.requestId)
        await context.store?.recordUsage?.(
          context.requestId,
          context.sessionId,
          context.budget.snapshot(),
        );
      result = await action();
    }
    if (effect === 'write' && !failedResult(result))
      await context.store?.completeOperation(operationId);
    return result;
  });
}

function isTransientReadError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') return false;
  const status = 'status' in error ? error.status : undefined;
  return (
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    /fetch failed|ECONNRESET|ETIMEDOUT/.test(error.message)
  );
}

function failedResult(result: unknown): boolean {
  if (typeof result === 'string') {
    try {
      return failedResult(JSON.parse(result));
    } catch {
      return false;
    }
  }
  return (
    !!result &&
    typeof result === 'object' &&
    (('success' in result && result.success === false) ||
      ('isError' in result && result.isError === true) ||
      ('error' in result && !!result.error))
  );
}
