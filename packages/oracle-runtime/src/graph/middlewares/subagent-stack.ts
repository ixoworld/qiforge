import { toolRetryMiddleware, type AgentMiddleware } from 'langchain';
import type { TurnBudgetTracker } from '../../kernel/budget.js';
import type { Logger } from '../../plugin-api/types.js';
import { createBudgetMiddleware } from './budget-middleware.js';
import { createToolRepetitionGuardMiddleware } from './tool-repetition-guard-middleware.js';
import { createToolValidationMiddleware } from './tool-validation-middleware.js';

export interface SubAgentStackOptions {
  logger: Logger;
  /**
   * The turn's shared budget tracker. Its middleware is KERNEL policy:
   * present regardless of `inheritMiddlewares`.
   */
  tracker?: TurnBudgetTracker;
  /**
   * Plugin-contributed sub-agent middlewares (`getSubAgentMiddlewares`),
   * e.g. credits metering. Also kernel policy — a metering gate that only
   * guards the outer loop is a gate the outer loop can walk around by
   * delegating.
   */
  kernelInherited: AgentMiddleware[];
  /**
   * Convenience protections (arg validation, repetition guard, retry).
   * These are the ONLY layer `inheritMiddlewares: false` sheds.
   */
  inheritConvenience: boolean;
}

/**
 * Compose the middleware stack for a sub-agent's inner loop.
 *
 * Two layers with different opt-out rules:
 *  - kernel: budget gate + plugin sub-agent middlewares (metering). Always
 *    present — no configuration removes them.
 *  - convenience: tool validation, repetition guard, tool retry. Inherited
 *    by default; a sub-agent that manages its own failure handling sets
 *    `inheritMiddlewares: false`.
 *
 * NOT inherited by design: CapabilityGate (sub-agent tool lists are
 * explicit — no `loadedPlugins` gating applies inside), PageContext and
 * SafetyGuardrail (main-agent final-reply semantics), Summarization
 * (opt-in per sub-agent via its own `middlewares`).
 */
export function buildSubAgentMiddlewareStack(
  options: SubAgentStackOptions,
): AgentMiddleware[] {
  const { logger, tracker, kernelInherited, inheritConvenience } = options;

  const kernel: AgentMiddleware[] = [
    ...(tracker ? [createBudgetMiddleware({ tracker, logger })] : []),
    ...kernelInherited,
  ];

  if (!inheritConvenience) return kernel;

  return [
    ...kernel,
    createToolValidationMiddleware({ logger }),
    createToolRepetitionGuardMiddleware({ logger }),
    toolRetryMiddleware({ onFailure: (error) => error.message }),
  ];
}
