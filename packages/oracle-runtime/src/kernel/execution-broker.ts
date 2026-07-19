import { sha256Hex, type AuditSink } from './audit.js';
import { BudgetExceededError, type TurnBudgetTracker } from './budget.js';
import type { Logger } from '../plugin-api/types.js';

/** Identity every brokered execution is tagged with. */
export interface ExecutionTenant {
  sessionId: string;
  requestId: string;
  userDid: string;
}

/** One tool execution handed to the broker. */
export interface ToolExecutionRequest {
  /** Owning plugin, when known ('__meta__' for runtime meta-tools). */
  pluginName: string;
  toolName: string;
  tenant: ExecutionTenant;
  /** The actual handler invocation, closed over its args and context. */
  run(): Promise<unknown>;
  /** Override of the budget's per-tool timeout, e.g. from plugin metadata. */
  timeoutMs?: number;
}

/**
 * The seam every tool execution flows through. Today's implementation runs
 * in-process; an isolated implementation (sandbox / dispatched Worker) can
 * replace it per tool without re-plumbing the graph — which is the point of
 * routing execution through the broker before isolation exists.
 */
export interface ExecutionBrokerPort {
  execute(request: ToolExecutionRequest): Promise<unknown>;
}

export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool '${toolName}' exceeded its ${timeoutMs}ms execution timeout.`);
    this.name = 'ToolTimeoutError';
  }
}

export interface InProcessBrokerOptions {
  tracker: TurnBudgetTracker;
  audit?: AuditSink;
  logger: Logger;
}

function appendAudit(
  options: InProcessBrokerOptions,
  record: Parameters<AuditSink['append']>[0],
): void {
  const { audit, logger } = options;
  if (!audit) return;
  void Promise.resolve(audit.append(record)).catch((err: unknown) => {
    logger.warn(
      `[broker] audit append failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/**
 * In-process execution broker: budget gate → timed handler run → output-size
 * check → audit record. A timeout resolves the broker call with an error but
 * cannot preempt the underlying handler (single JS runtime — handlers must
 * honor `ctx.abortSignal` for cooperative cancellation); the timeout still
 * bounds what the agent loop waits on, which is the resource that matters
 * for the turn.
 */
export function createInProcessExecutionBroker(
  options: InProcessBrokerOptions,
): ExecutionBrokerPort {
  const { tracker, logger } = options;

  return {
    async execute(request) {
      const startedAt = Date.now();
      const base = {
        sessionId: request.tenant.sessionId,
        requestId: request.tenant.requestId,
      };

      try {
        tracker.beforeToolCall();
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          appendAudit(options, {
            kind: 'tool.deny',
            at: new Date().toISOString(),
            ...base,
            userDidDigest: await sha256Hex(request.tenant.userDid),
            detail: {
              plugin: request.pluginName,
              tool: request.toolName,
              reason: 'budget',
              ceiling: err.ceiling,
              limit: err.limit,
            },
          });
        }
        throw err;
      }

      const timeoutMs = request.timeoutMs ?? tracker.budget.perToolTimeoutMs;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new ToolTimeoutError(request.toolName, timeoutMs));
        }, timeoutMs);
      });

      try {
        const result = await Promise.race([request.run(), timedOut]);

        if (typeof result === 'string') {
          tracker.checkOutputSize(result.length);
        }

        appendAudit(options, {
          kind: 'tool.allow',
          at: new Date().toISOString(),
          ...base,
          userDidDigest: await sha256Hex(request.tenant.userDid),
          detail: {
            plugin: request.pluginName,
            tool: request.toolName,
            durationMs: Date.now() - startedAt,
          },
        });

        return result;
      } catch (err) {
        if (err instanceof ToolTimeoutError) {
          logger.warn(
            `[broker] ${request.pluginName}/${request.toolName} timed out after ${timeoutMs}ms`,
          );
          appendAudit(options, {
            kind: 'tool.deny',
            at: new Date().toISOString(),
            ...base,
            userDidDigest: await sha256Hex(request.tenant.userDid),
            detail: {
              plugin: request.pluginName,
              tool: request.toolName,
              reason: 'timeout',
              timeoutMs,
            },
          });
        }
        throw err;
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    },
  };
}
