import { AIMessageChunk } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import { mainAgentRequestContextSchema } from '../../graph/main-agent-types.js';
import type { Logger } from '../../plugin-api/types.js';
import { type TokenLimiter, TokenLimiterError } from './token-limiter.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface CreditsMiddlewareOptions {
  /** Active limiter. When `null`, the middleware skips silently. */
  limiter: TokenLimiter | null;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Extract `user.did` from the LangGraph runtime context without trusting
 * its shape. The runtime channel is typed `unknown` in plain middlewares,
 * so narrowing is the only honest way to read identity off it.
 */
function extractUserDid(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || !('user' in context)) {
    return undefined;
  }
  const { user } = context;
  if (!user || typeof user !== 'object' || !('did' in user)) {
    return undefined;
  }
  const { did } = user;
  return typeof did === 'string' && did.length > 0 ? did : undefined;
}

/** Extract `session.mode` from the runtime context with the same narrowing. */
function extractSessionMode(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || !('session' in context)) {
    return undefined;
  }
  const { session } = context;
  if (!session || typeof session !== 'object' || !('mode' in session)) {
    return undefined;
  }
  const { mode } = session;
  return typeof mode === 'string' ? mode : undefined;
}

interface UsageMetadata {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function extractUsageMetadata(message: unknown): UsageMetadata | undefined {
  if (
    !message ||
    typeof message !== 'object' ||
    !('usage_metadata' in message)
  ) {
    return undefined;
  }
  const meta = (message as { usage_metadata?: unknown }).usage_metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  if (
    typeof m.input_tokens === 'number' &&
    typeof m.output_tokens === 'number' &&
    typeof m.total_tokens === 'number'
  ) {
    return {
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      total_tokens: m.total_tokens,
    };
  }
  return undefined;
}

interface ResponseMeta {
  providerCost?: number;
  model?: string;
}

function extractResponseMeta(message: unknown): ResponseMeta {
  if (
    !message ||
    typeof message !== 'object' ||
    !('response_metadata' in message)
  ) {
    return {};
  }
  const meta = (message as { response_metadata?: unknown }).response_metadata;
  if (!meta || typeof meta !== 'object') return {};
  const m = meta as Record<string, unknown>;
  const result: ResponseMeta = {};
  const usage = m.usage;
  if (
    usage &&
    typeof usage === 'object' &&
    typeof (usage as { cost?: unknown }).cost === 'number'
  ) {
    result.providerCost = (usage as { cost: number }).cost;
  }
  if (typeof m.model === 'string') {
    result.model = m.model;
  }
  return result;
}

/**
 * Per-user credit-budget guard. Runs on every model call:
 *
 *   - `beforeModel` aborts the call with a polite message when the user
 *     has no remaining balance.
 *   - `afterModel` computes the credit cost of the completion (3-priority
 *     fallback: provider USD cost → per-model pricing → flat rate) and
 *     deducts it atomically via `TokenLimiter.limit`.
 *
 * Silently passes through when `limiter` is `null` — that's how the credits
 * plugin signals "disabled or no Redis" without breaking the graph.
 */
export const createCreditsMiddleware = (
  options: CreditsMiddlewareOptions,
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const { limiter } = options;

  return createMiddleware({
    name: 'TokenLimiterMiddleware',
    beforeModel: async (state, runtime) => {
      if (!limiter) {
        logger.debug?.(
          'Credits middleware skipped (limiter unavailable — credits disabled or no Redis)',
        );
        return;
      }

      // Concierge turns (unauthorized Matrix visitors) are unmetered: no
      // balance gate and no deduction — there is no subscription to bill.
      // The restricted concierge tool surface bounds the exposure.
      if (extractSessionMode(runtime.context) === 'concierge') {
        logger.debug?.('Credits middleware skipped (concierge turn)');
        return;
      }

      const userDid = extractUserDid(runtime.context);
      if (!userDid) {
        throw new Error('User DID is required for credit limiting');
      }

      const remaining = await limiter.getRemaining(userDid);
      logger.debug?.(`Remaining credits: ${remaining} for user ${userDid}`);

      if (remaining <= 0) {
        return {
          messages: [
            ...state.messages,
            new AIMessageChunk({
              content: `Looks like you have run out of tokens. Please upgrade your plan or topup your balance. You have ${remaining} tokens remaining.`,
            }),
          ],
        };
      }
    },

    afterModel: async (state, runtime) => {
      if (!limiter) return;
      if (extractSessionMode(runtime.context) === 'concierge') return;

      try {
        const userDid = extractUserDid(runtime.context);
        if (!userDid) {
          throw new Error('User DID is required for credit limiting');
        }

        const lastMessage = state.messages.at(-1);
        const usage = extractUsageMetadata(lastMessage);
        if (!usage) {
          // No AI response with usage metadata to deduct against — happens
          // when `beforeModel` short-circuited the call, or when the graph
          // resumed on a non-AI message. Nothing to bill, skip silently.
          return;
        }

        const { providerCost, model } = extractResponseMeta(lastMessage);

        const credits = limiter.creditsForUsage({
          providerCost,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
          model,
        });

        logger.log(
          `[Credits] input=${usage.input_tokens} output=${usage.output_tokens} total=${usage.total_tokens} | credits=${credits}`,
        );

        const result = await limiter.limit(userDid, credits);
        logger.debug?.(`Credit limit result: ${JSON.stringify(result)}`);
      } catch (error) {
        if (error instanceof TokenLimiterError) {
          logger.error(`Credit limit error: ${error.message}`);
          return {
            messages: [
              ...state.messages,
              new AIMessageChunk({
                content: `Looks like you have run out of tokens. Please upgrade your plan or topup your balance. You have ${error.currentBalance?.toFixed(2) ?? '0'} tokens remaining.`,
              }),
            ],
          };
        }
        logger.error(
          `Error in CreditsMiddleware: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    },
    contextSchema: mainAgentRequestContextSchema,
  });
};
