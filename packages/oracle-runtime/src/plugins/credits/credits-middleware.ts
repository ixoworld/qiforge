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
  /**
   * Credits reserved atomically BEFORE each model call and settled against
   * the actual cost afterwards. Closes the check-then-charge-later gap:
   * concurrent calls racing one balance cannot all pass, and a user who
   * cannot cover the estimate never starts the call.
   */
  reserveEstimateCredits?: number;
}

/** Default per-call reservation (settled to actual cost afterwards). */
export const DEFAULT_RESERVE_ESTIMATE_CREDITS = 20;

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

/** Extract `session.requestId` the same narrowing way (reservation pairing key). */
function extractRequestId(context: unknown): string {
  if (!context || typeof context !== 'object' || !('session' in context)) {
    return 'unknown';
  }
  const { session } = context;
  if (!session || typeof session !== 'object' || !('requestId' in session)) {
    return 'unknown';
  }
  const { requestId } = session;
  return typeof requestId === 'string' && requestId.length > 0
    ? requestId
    : 'unknown';
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
 * Per-user credit metering with reservation semantics. Runs on every model
 * call — in the main agent AND inside sub-agent loops (the plugin registers
 * the same instance through both middleware hooks):
 *
 *   - `beforeModel` atomically RESERVES the estimated cost. A user who
 *     cannot cover the estimate gets a polite message instead of a call,
 *     and concurrent calls racing one balance cannot all pass.
 *   - `afterModel` settles the reservation against the actual cost of the
 *     completion (3-priority fallback: provider USD cost → per-model
 *     pricing → flat rate): shortfalls are charged, surpluses refunded,
 *     and a call that produced nothing billable releases in full.
 *
 * Reservations pair strictly per request (model calls within one request
 * are sequential), keyed by `did:requestId`.
 *
 * Silently passes through when `limiter` is `null` — that's how the credits
 * plugin signals "disabled or no Redis" without breaking the graph.
 */
export const createCreditsMiddleware = (
  options: CreditsMiddlewareOptions,
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const { limiter } = options;
  const estimate =
    options.reserveEstimateCredits ?? DEFAULT_RESERVE_ESTIMATE_CREDITS;

  /** Open reservations per `did:requestId` (LIFO; calls are sequential). */
  const openReservations = new Map<string, number[]>();

  const reservationKey = (context: unknown): string =>
    `${extractUserDid(context) ?? 'unknown'}:${extractRequestId(context)}`;

  const pushReservation = (key: string, amount: number): void => {
    const stack = openReservations.get(key) ?? [];
    stack.push(amount);
    openReservations.set(key, stack);
  };

  const popReservation = (key: string): number => {
    const stack = openReservations.get(key);
    if (!stack || stack.length === 0) return 0;
    const amount = stack.pop() ?? 0;
    if (stack.length === 0) openReservations.delete(key);
    return amount;
  };

  return createMiddleware({
    name: 'TokenLimiterMiddleware',
    beforeModel: async (state, runtime) => {
      if (!limiter) {
        logger.debug?.(
          'Credits middleware skipped (limiter unavailable — credits disabled or no Redis)',
        );
        return;
      }

      const userDid = extractUserDid(runtime.context);
      if (!userDid) {
        throw new Error('User DID is required for credit limiting');
      }

      try {
        await limiter.reserve(userDid, estimate);
        pushReservation(reservationKey(runtime.context), estimate);
        return;
      } catch (error) {
        if (error instanceof TokenLimiterError) {
          // Nothing was deducted (the script rolled back). Record a zero
          // reservation so afterModel settlement stays paired.
          pushReservation(reservationKey(runtime.context), 0);
          logger.warn(
            `[Credits] reservation declined for ${userDid}: ${error.message}`,
          );
          return {
            messages: [
              ...state.messages,
              new AIMessageChunk({
                content: `Looks like you have run out of tokens. Please upgrade your plan or topup your balance. You have ${error.currentBalance?.toFixed(2) ?? '0'} tokens remaining.`,
              }),
            ],
          };
        }
        throw error;
      }
    },

    afterModel: async (state, runtime) => {
      if (!limiter) return;

      try {
        const userDid = extractUserDid(runtime.context);
        if (!userDid) {
          throw new Error('User DID is required for credit limiting');
        }

        const reserved = popReservation(reservationKey(runtime.context));

        const lastMessage = state.messages.at(-1);
        const usage = extractUsageMetadata(lastMessage);
        if (!usage) {
          // No AI response with usage metadata — the call was declined or
          // the graph resumed on a non-AI message. Return the unused
          // reservation and stop.
          if (reserved > 0) await limiter.release(userDid, reserved);
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
          `[Credits] input=${usage.input_tokens} output=${usage.output_tokens} total=${usage.total_tokens} | reserved=${reserved} actual=${credits}`,
        );

        await limiter.commit(userDid, reserved, credits);
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
