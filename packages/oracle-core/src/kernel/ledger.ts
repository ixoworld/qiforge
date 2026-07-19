/**
 * Reservation-style billing ledger. The contract closes the
 * check-then-charge-later gap: a model call RESERVES its estimated cost
 * atomically before it runs (a caller that cannot cover the estimate never
 * starts), then COMMITS the actual cost (settling the delta) or RELEASES
 * the reservation when nothing billable happened.
 *
 * Implementations must make `reserve` atomic against concurrent reserves
 * for the same user — two calls racing a balance that covers only one must
 * not both pass.
 */
export interface LedgerPort {
  /** Remaining spendable balance. */
  getRemaining(userDid: string): Promise<number>;
  /**
   * Atomically deduct + hold the estimate. Throws the implementation's
   * insufficient-balance error when the user cannot cover it.
   */
  reserve(userDid: string, estimateCredits: number): Promise<void>;
  /**
   * Settle a reservation against the actual cost: charges the shortfall
   * when actual exceeds the estimate, refunds the surplus when it ran
   * cheaper. A shortfall the balance cannot cover is logged by the
   * implementation and floors at zero — the spend has already happened.
   */
  commit(
    userDid: string,
    estimateCredits: number,
    actualCredits: number,
  ): Promise<void>;
  /** Return an unused reservation in full (the call never produced billable usage). */
  release(userDid: string, estimateCredits: number): Promise<void>;
  /** Convert observed usage into credits (pricing policy lives with the ledger). */
  creditsForUsage(usage: {
    providerCost?: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model?: string;
  }): number;
}
