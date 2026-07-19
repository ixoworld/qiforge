import { AIMessageChunk } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import {
  BudgetExceededError,
  type TurnBudgetTracker,
} from '../../kernel/budget.js';
import type { Logger } from '../../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface BudgetMiddlewareOptions {
  tracker: TurnBudgetTracker;
  logger?: Logger;
}

/**
 * Kernel budget gate on model calls. The tracker is shared across the main
 * agent and every sub-agent invocation of the same turn, so nesting cannot
 * escape the ceilings. On breach the turn ends with an explanatory reply
 * instead of an opaque exception — the ceiling is a policy outcome, not a
 * crash.
 */
export const createBudgetMiddleware = (
  options: BudgetMiddlewareOptions,
): AgentMiddleware => {
  const { tracker } = options;
  const logger = options.logger ?? NOOP_LOGGER;

  return createMiddleware({
    name: 'TurnBudgetMiddleware',
    beforeModel: (state) => {
      try {
        tracker.beforeModelCall();
        return undefined;
      } catch (err) {
        if (!(err instanceof BudgetExceededError)) throw err;
        const { toolCalls, modelCalls, elapsedMs } = tracker.snapshot();
        logger.warn(
          `[budget] turn stopped: ${err.message} (toolCalls=${toolCalls}, modelCalls=${modelCalls}, elapsedMs=${elapsedMs})`,
        );
        return {
          messages: [
            ...state.messages,
            new AIMessageChunk({
              content:
                'This turn reached its configured resource budget and was stopped. ' +
                'Please continue in a new message, or ask the operator to raise the turn budget.',
            }),
          ],
        };
      }
    },
  });
};
