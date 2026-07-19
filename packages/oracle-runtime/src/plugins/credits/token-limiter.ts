import { type GetMySubscriptionsResponseDto } from '@ixo/common';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { LedgerPort } from '../../kernel/ledger.js';
import type { Logger } from '../../plugin-api/types.js';

/** Network tier — drives the credits-per-USD multiplier. */
export type CreditsNetwork = 'mainnet' | 'testnet' | 'devnet';

/** Look up per-model pricing. Returns `null` to fall through to flat-rate. */
export interface ModelPricing {
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
}
export type ModelPricingLookup = (modelId: string) => ModelPricing | null;

/** Constructor options for `TokenLimiter`. */
export interface TokenLimiterOptions {
  redis: Redis;
  network: CreditsNetwork;
  /** Whether `DISABLE_CREDITS` is set — relaxes the overdraft guard. */
  disableCredits?: boolean;
  /** Optional per-model pricing lookup; defaults to flat-rate fallback. */
  modelPricingLookup?: ModelPricingLookup;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/** Insufficient-balance error raised by `limit()`. */
export class TokenLimiterError extends Error {
  readonly type: 'token' | 'request';
  readonly limit?: number;
  readonly currentBalance?: number;
  readonly reset?: number;

  constructor(
    message: string,
    type: 'token' | 'request',
    limit?: number,
    reset?: number,
    currentBalance?: number,
  ) {
    super(message);
    this.type = type;
    this.limit = limit;
    this.reset = reset;
    this.currentBalance = currentBalance;
  }
}

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const KEY_PREFIX = 'token_limit:';
const KEY_BALANCE = 'balance';
const KEY_HELD_AMOUNTS = 'held_amounts';
const KEY_SUBSCRIPTION_PAYLOAD = 'subscription_payload';
const KEY_PENDING_CLAIM = 'pending_claim';

// Atomic balance decrement + held-amount increment, with rollback on overdraft.
const LIMIT_TOKENS_SCRIPT = `
    local balanceKey = KEYS[1]
    local heldAmountsKey = KEYS[2]
    local userDid = ARGV[1]
    local tokenCount = tonumber(ARGV[2])

    local newBalance = tonumber(redis.call('INCRBYFLOAT', balanceKey, -tokenCount))

    if newBalance < 0 then
      redis.call('INCRBYFLOAT', balanceKey, tokenCount)
      return {0, newBalance + tokenCount, 'INSUFFICIENT_BALANCE'}
    end

    redis.call('ZINCRBY', heldAmountsKey, tokenCount, userDid)

    return {1, newBalance, 'SUCCESS'}
  `;

/**
 * Per-user credit budget enforced against Redis. The runtime instantiates
 * one `TokenLimiter` per oracle and shares it between the middleware (live
 * deduction on the LLM hot path) and the subscription middleware (which
 * mirrors the chain-side balance into Redis on every authenticated request).
 *
 * Costs are computed in three priority tiers:
 *   1. provider-supplied USD cost (e.g. OpenRouter `usage.cost`)
 *   2. cached per-model pricing × tokens
 *   3. flat-rate `$0.75 / 1M tokens` fallback
 */
export class TokenLimiter implements LedgerPort {
  private readonly redis: Redis;
  private readonly network: CreditsNetwork;
  private readonly disableCredits: boolean;
  private readonly lookupModelPricing: ModelPricingLookup;
  private readonly logger: Logger;

  static getSubscriptionPayloadKey(userDid: string): string {
    return `${KEY_PREFIX}${userDid}:${KEY_SUBSCRIPTION_PAYLOAD}`;
  }

  static getUserBalanceKey(userDid: string): string {
    return `${KEY_PREFIX}${userDid}:${KEY_BALANCE}`;
  }

  static getPendingClaimKey(userDid: string): string {
    return `${KEY_PREFIX}${userDid}:${KEY_PENDING_CLAIM}`;
  }

  static getHeldAmountsKey(): string {
    return KEY_HELD_AMOUNTS;
  }

  /**
   * Deterministic claim ID derived from `userDid + batchStartTime`. Retries
   * for the same batch resolve to the same ID, preventing duplicate claims.
   */
  static generateClaimId(userDid: string, batchStartTime: number): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${userDid}:${batchStartTime}`)
      .digest('hex');
    return `claim_${hash.slice(0, 32)}`;
  }

  constructor(options: TokenLimiterOptions) {
    this.redis = options.redis;
    this.network = options.network;
    this.disableCredits = options.disableCredits ?? false;
    this.lookupModelPricing =
      options.modelPricingLookup ?? ((): ModelPricing | null => null);
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /**
   * Convert raw USD cost (e.g. OpenRouter `response_metadata.usage.cost`)
   * into credits. On mainnet 1 USD = 1000 credits; devnet uses a 10x
   * multiplier so micro-costs are visible during testing.
   */
  usdCostToCredits(usdCost: number): number {
    const isMainnet = this.network === 'mainnet';
    const creditsPerUsd = isMainnet ? 1000 : 10_000;
    const markup = isMainnet ? 1.6 : 4;
    return Math.round(usdCost * creditsPerUsd * markup);
  }

  /**
   * Cost in USD (post-markup) using the same 3-priority fallback as
   * `creditsForUsage`. Exposed for callers that bill outside the agent
   * graph (e.g. file-processing pre-flight charges).
   */
  calculateCostUsdWithMarkup(params: {
    providerCost?: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model?: string;
  }): number {
    const markup = 1.6;

    if (params.providerCost != null && params.providerCost > 0) {
      return params.providerCost * markup;
    }

    const pricing = params.model ? this.lookupModelPricing(params.model) : null;
    if (pricing) {
      const inputCost =
        (params.inputTokens / 1_000_000) * pricing.inputPricePerMillionTokens;
      const outputCost =
        (params.outputTokens / 1_000_000) * pricing.outputPricePerMillionTokens;
      return (inputCost + outputCost) * markup;
    }

    return (params.totalTokens / 1_000_000) * 0.75 * markup;
  }

  /**
   * Flat-rate fallback: $0.75 per 1M tokens, converted to credits via
   * `usdCostToCredits` (which applies the network markup and the
   * credits-per-USD rate). Converting through the shared function keeps
   * every billing path on one conversion — the previous implementation
   * rounded the raw USD amount, which deducted 0 credits for any turn
   * under ~400k tokens.
   */
  llmTokenToCredits(tokenCount: number): number {
    const tokensPerMillion = 1_000_000;
    return this.usdCostToCredits((tokenCount / tokensPerMillion) * 0.75);
  }

  /**
   * Credits using per-model pricing (separate input/output rates). Falls
   * through to the flat-rate fallback when pricing is `null`.
   */
  llmTokenToCreditsWithPricing(
    inputTokens: number,
    outputTokens: number,
    pricing: ModelPricing | null,
  ): number {
    if (!pricing) {
      this.logger.log(
        '[TokenLimiter] No pricing found, falling back to flat rate',
      );
      return this.llmTokenToCredits(inputTokens + outputTokens);
    }

    const divisor = 1_000_000;
    const inputCost =
      (inputTokens / divisor) * pricing.inputPricePerMillionTokens;
    const outputCost =
      (outputTokens / divisor) * pricing.outputPricePerMillionTokens;
    // `usdCostToCredits` applies the network markup and credits-per-USD
    // rate — the same conversion the provider-cost branch uses, so all
    // three billing paths agree on scale.
    return this.usdCostToCredits(inputCost + outputCost);
  }

  /**
   * Compute credit cost for a single completion using the standard 3-priority
   * fallback. The middleware's `afterModel` hook calls this on every LLM
   * response.
   */
  creditsForUsage(params: {
    providerCost?: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model?: string;
  }): number {
    // Post-markup USD cost via the same 3-priority fallback — logged alongside
    // credits in every branch so the source and dollar cost are both visible.
    const usdCost = this.calculateCostUsdWithMarkup(params);

    if (params.providerCost != null && params.providerCost > 0) {
      const credits = this.usdCostToCredits(params.providerCost);
      this.logger.log(
        `[TokenLimiter] source=provider-cost providerCost=$${params.providerCost} costUsd=$${usdCost.toFixed(6)} → ${credits} credits (network=${this.network})`,
      );
      return credits;
    }
    const pricing = params.model ? this.lookupModelPricing(params.model) : null;
    if (pricing) {
      const credits = this.llmTokenToCreditsWithPricing(
        params.inputTokens,
        params.outputTokens,
        pricing,
      );
      this.logger.log(
        `[TokenLimiter] source=model-pricing model=${params.model ?? 'unknown'} in=${params.inputTokens} out=${params.outputTokens} costUsd=$${usdCost.toFixed(6)} → ${credits} credits (network=${this.network})`,
      );
      return credits;
    }
    const credits = this.llmTokenToCredits(params.totalTokens);
    this.logger.log(
      `[TokenLimiter] source=flat-rate model=${params.model ?? 'unknown'} totalTokens=${params.totalTokens} costUsd=$${usdCost.toFixed(6)} → ${credits} credits (network=${this.network})`,
    );
    return credits;
  }

  async setSubscriptionPayload(
    userDid: string,
    payload: Pick<
      GetMySubscriptionsResponseDto,
      'adminAddress' | 'claimCollections' | 'totalCredits'
    >,
  ): Promise<void> {
    await this.redis.set(
      TokenLimiter.getSubscriptionPayloadKey(userDid),
      JSON.stringify({
        adminAddress: payload.adminAddress,
        claimCollections: payload.claimCollections,
        totalCredits: payload.totalCredits,
      }),
    );
  }

  async getSubscriptionPayload(
    userDid: string,
  ): Promise<Pick<
    GetMySubscriptionsResponseDto,
    'adminAddress' | 'claimCollections' | 'totalCredits'
  > | null> {
    const payload = await this.redis.get(
      TokenLimiter.getSubscriptionPayloadKey(userDid),
    );
    return payload
      ? (JSON.parse(payload) as Pick<
          GetMySubscriptionsResponseDto,
          'adminAddress' | 'claimCollections' | 'totalCredits'
        >)
      : null;
  }

  async getUserHeldAmount(userDid: string): Promise<number> {
    const result = await this.redis.zscore(KEY_HELD_AMOUNTS, userDid);
    return result ? parseFloat(result) : 0;
  }

  async incrementUserHeldAmount(
    userDid: string,
    amount: number,
  ): Promise<void> {
    await this.redis.zincrby(KEY_HELD_AMOUNTS, amount, userDid);
  }

  async deleteUserHeldAmount(userDid: string): Promise<void> {
    await this.redis.zrem(KEY_HELD_AMOUNTS, userDid);
  }

  /**
   * List users whose held amount is at or above `amount`. Result rows are
   * `[did, heldAmount]` tuples.
   */
  async listUsersWithHeldAmount(amount: number): Promise<[string, number][]> {
    const raw = await this.redis.zrangebyscore(
      KEY_HELD_AMOUNTS,
      amount,
      '+inf',
      'WITHSCORES',
    );
    const result: [string, number][] = [];
    for (let i = 0; i < raw.length; i += 2) {
      result.push([raw[i] as string, parseFloat(raw[i + 1] as string)]);
    }
    return result;
  }

  /**
   * Reconcile the Redis balance with the chain-side subscription balance.
   * Subtracts any pending held amount to surface the user's actual usable
   * balance. Throws when the held amount exceeds the chain balance (a
   * sync error) unless credits are disabled.
   */
  async overrideUserBalance(userDid: string, balance: number): Promise<string> {
    z.number().parse(balance);
    const heldAmount = await this.getUserHeldAmount(userDid);
    const newBalance = balance - heldAmount;

    if (newBalance < 0) {
      this.logger.error(
        `CRITICAL: Held amount (${heldAmount}) exceeds chain balance (${balance}) for user ${userDid}.`,
      );
      await this.redis.set(TokenLimiter.getUserBalanceKey(userDid), '0');

      if (this.disableCredits) {
        return '0';
      }
      throw new TokenLimiterError(
        `It looks like you have some usage pending that's higher than your current balance (${balance / 1000}). Please add more credits to your account to continue. If you think this is a mistake, please contact support. (Held: ${heldAmount / 1000})`,
        'token',
        undefined,
        undefined,
        balance,
      );
    }

    await this.redis.set(
      TokenLimiter.getUserBalanceKey(userDid),
      newBalance.toString(),
    );

    this.logger.debug?.(
      `Overriding balance for user ${userDid} to current balance: ${newBalance}, held amount: ${heldAmount}, subscription balance: ${balance}`,
    );

    return newBalance.toString();
  }

  async getUserBalance(userDid: string): Promise<number> {
    const balance = await this.redis.get(
      TokenLimiter.getUserBalanceKey(userDid),
    );
    return balance ? parseFloat(balance) : 0;
  }

  async getRemaining(userDid: string): Promise<number> {
    return this.getUserBalance(userDid);
  }

  /**
   * Decrement the user's balance by `credits` and add the same amount to
   * their held-amount sorted-set entry, atomically via a Lua script.
   * Throws `TokenLimiterError` when the balance would go negative.
   */
  async limit(
    userDid: string,
    credits: number,
  ): Promise<{ success: boolean; remaining: number }> {
    const balanceKey = TokenLimiter.getUserBalanceKey(userDid);
    const heldAmountsKey = KEY_HELD_AMOUNTS;

    try {
      const result = (await this.redis.eval(
        LIMIT_TOKENS_SCRIPT,
        2,
        balanceKey,
        heldAmountsKey,
        userDid,
        credits.toString(),
      )) as [number, number, string];

      const [success, balance] = result;

      if (success === 0) {
        throw new TokenLimiterError(
          `Insufficient balance. Current balance: ${balance}`,
          'token',
          credits,
          undefined,
          balance,
        );
      }

      this.logger.debug?.(
        `Limited ${credits} credits for user ${userDid}, remaining: ${balance}`,
      );
      return { success: true, remaining: balance };
    } catch (error) {
      if (error instanceof TokenLimiterError) {
        throw error;
      }
      this.logger.error(
        `Failed to limit tokens for user ${userDid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new TokenLimiterError(
        'Failed to process token limit',
        'token',
        credits,
      );
    }
  }

  /**
   * Reserve the estimated cost of a call BEFORE it runs — an atomic deduct +
   * hold through the same Lua script as `limit`. A caller that cannot cover
   * the estimate never starts; two callers racing a balance that covers only
   * one cannot both pass.
   */
  async reserve(userDid: string, estimateCredits: number): Promise<void> {
    if (estimateCredits <= 0) return;
    await this.limit(userDid, estimateCredits);
  }

  /**
   * Settle a reservation against the actual cost. The delta rides the same
   * atomic script — positive charges the shortfall, negative refunds the
   * surplus (the script's balance-floor branch only triggers on decrements,
   * so refunds always apply). An uncoverable shortfall floors at zero and is
   * logged: the spend has already happened upstream.
   */
  async commit(
    userDid: string,
    estimateCredits: number,
    actualCredits: number,
  ): Promise<void> {
    const delta = actualCredits - estimateCredits;
    if (delta === 0) return;
    try {
      await this.limit(userDid, delta);
    } catch (error) {
      if (error instanceof TokenLimiterError) {
        this.logger.warn(
          `[TokenLimiter] commit shortfall not coverable for ${userDid}: reserved=${estimateCredits}, actual=${actualCredits}`,
        );
        return;
      }
      throw error;
    }
  }

  /** Return an unused reservation in full (the call produced nothing billable). */
  async release(userDid: string, estimateCredits: number): Promise<void> {
    if (estimateCredits <= 0) return;
    await this.limit(userDid, -estimateCredits);
  }

  async setPendingClaim(
    userDid: string,
    claimId: string,
    amount: number,
    batchStartTime?: number,
  ): Promise<void> {
    const now = Date.now();
    const payload = {
      claimId,
      amount,
      timestamp: now,
      batchStartTime: batchStartTime ?? now,
    };

    await this.redis.set(
      TokenLimiter.getPendingClaimKey(userDid),
      JSON.stringify(payload),
      'EX',
      60 * 60,
    );
  }

  async getPendingClaim(userDid: string): Promise<{
    claimId: string;
    amount: number;
    timestamp: number;
    batchStartTime: number;
  } | null> {
    const data = await this.redis.get(TokenLimiter.getPendingClaimKey(userDid));
    return data
      ? (JSON.parse(data) as {
          claimId: string;
          amount: number;
          timestamp: number;
          batchStartTime: number;
        })
      : null;
  }

  async clearPendingClaim(userDid: string): Promise<void> {
    await this.redis.del(TokenLimiter.getPendingClaimKey(userDid));
  }

  async updatePendingClaimAmount(
    userDid: string,
    newAmount: number,
  ): Promise<void> {
    const pending = await this.getPendingClaim(userDid);
    if (!pending) {
      this.logger.warn(
        `Attempted to update pending claim amount for ${userDid}, but no pending claim exists`,
      );
      return;
    }

    await this.setPendingClaim(
      userDid,
      pending.claimId,
      newAmount,
      pending.batchStartTime,
    );

    this.logger.debug?.(
      `Updated pending claim ${pending.claimId} amount from ${pending.amount} to ${newAmount} for user ${userDid}`,
    );
  }

  /**
   * Return the existing pending-claim ID for `userDid`, refreshing the
   * amount if the held amount changed; otherwise create a new claim entry
   * with a deterministic ID.
   */
  async getOrCreatePendingClaim(
    userDid: string,
    currentHeldAmount: number,
  ): Promise<string> {
    const pending = await this.getPendingClaim(userDid);

    if (pending) {
      if (pending.amount !== currentHeldAmount) {
        this.logger.debug?.(
          `Held amount changed from ${pending.amount} to ${currentHeldAmount} for user ${userDid}. Updating pending claim.`,
        );
        await this.updatePendingClaimAmount(userDid, currentHeldAmount);
      }
      return pending.claimId;
    }

    const batchStartTime = Date.now();
    const claimId = TokenLimiter.generateClaimId(userDid, batchStartTime);

    await this.setPendingClaim(
      userDid,
      claimId,
      currentHeldAmount,
      batchStartTime,
    );

    this.logger.debug?.(
      `Created new pending claim ${claimId} for user ${userDid} with amount ${currentHeldAmount}`,
    );

    return claimId;
  }
}
