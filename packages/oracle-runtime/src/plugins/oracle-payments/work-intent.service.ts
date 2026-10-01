import { Logger as NestLogger } from '@nestjs/common';
import type {
  CommerceEngagementStart,
  CommerceEngagementStartResult,
} from '../../modules/messages/commerce-router-port.js';
import type { CommerceEngagement, Logger } from '../../plugin-api/types.js';
import {
  defaultIntentChainClient,
  isInsufficientFundsFailure,
  type ClaimCoin,
  type IntentChainClient,
  type SubmitClaimResult,
} from './claim-lane.js';
import type {
  EngagementService,
  EngagementStartData,
} from './engagement.service.js';
import {
  creditsInChainText,
  errorMessage,
  formatCredits,
  grantedDenom,
  priceToCoin,
  priceToCredits,
  retry,
} from './util.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/**
 * Outcome of one on-chain reservation. The failure carries the chain's own
 * words rather than collapsing to a null: "reserving the payment failed" with
 * nothing after it is the one thing the agent cannot explain to the user, and
 * every caller of this turns its failure into something the user reads.
 *
 * `insufficientFunds` marks the one failure the user can act on themselves —
 * their balance is short, so the honest instruction is "top up" rather than the
 * "try again shortly" every other failure earns.
 */
export type ReservationResult =
  | { ok: true; intent: NonNullable<CommerceEngagement['intent']> }
  | { ok: false; detail: string; insufficientFunds?: true };

export interface WorkIntentServiceDeps {
  engagement: EngagementService;
  chain?: IntentChainClient;
  clock?: () => Date;
  /** Sleep seam for the engagement-persist retry; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/**
 * Starts a work engagement, escrow first.
 *
 * Work is always escrow-backed: the service price is reserved on-chain
 * (`MsgClaimIntent`) BEFORE the engagement is written, and the tx hash plus the
 * derived expiry are stamped on it. A failed reservation starts nothing: the
 * router surfaces `intent_failed` together with the chain's own reason, so the
 * agent explains what happened instead of working unpaid. The delivery lane
 * then settles the claim against that reservation
 * with `useIntent: true` — the two halves are meaningless apart, so neither is
 * conditional.
 *
 * Deployment prerequisite: the evaluation engine that pulls these claims must
 * accept `useIntent: true` agent-work claims, and the collection's
 * `SubmitClaimAuthorization` grant must carry an `intentDurationNs` wide enough
 * for a realistic engagement. Without both, reservations lock funds that never
 * settle.
 *
 * This is the plugin side of the router's `startEngagement` port call: chain
 * writes stay in the plugin, the core router only learns pass or fail.
 */
export class WorkIntentService {
  private readonly engagement: EngagementService;
  private readonly chain: IntentChainClient;
  private readonly clock: () => Date;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(deps: WorkIntentServiceDeps) {
    this.engagement = deps.engagement;
    this.chain = deps.chain ?? defaultIntentChainClient;
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep;
    this.logger = deps.logger ?? new NestLogger(WorkIntentService.name);
  }

  async startEngagement(
    roomId: string,
    threadId: string,
    start: CommerceEngagementStart,
  ): Promise<CommerceEngagementStartResult> {
    // R1 (uPay spec §5): the granted denom the gate carried on the start is
    // stamped onto the engagement, so the release lane can later price its
    // claim in the exact coin this reservation locks — no record lookup, no
    // guess. `reserve` below fails closed when the start carries none.
    const denom = grantedDenom(start);
    const data: EngagementStartData = {
      serviceId: start.serviceId,
      serviceName: start.serviceName,
      priceUsd: start.priceUsd,
      collectionId: start.collectionId,
      adminAddress: start.adminAddress,
      ...(start.userDid !== undefined && { userDid: start.userDid }),
      ...(denom !== undefined && { denom }),
    };

    const reservation = await this.reserve(start);
    if (!reservation.ok) {
      return {
        ok: false,
        // A balance the user can top up is not the same failure as a chain
        // that would not take the write, and it gets its own reason so the
        // agent asks them to add credits instead of telling them to try again
        // shortly — which, for an empty account, is advice to fail again.
        reason: reservation.insufficientFunds
          ? 'insufficient_funds'
          : 'intent_failed',
        detail: reservation.detail,
      };
    }
    const intent = reservation.intent;

    // The engagement record IS the persisted "this user is in work mode"
    // state: the router reads it before anything else, so a reservation whose
    // engagement never landed routes the very next message back to support
    // while the escrow stays locked on-chain. Worth a bounded retry, and worth
    // an error line naming the tx when it still fails — the turn then reports
    // a failed start instead of quietly proceeding as if nothing happened.
    let engagement: CommerceEngagement;
    try {
      engagement = await retry(
        () => this.engagement.start(roomId, threadId, { ...data, intent }),
        {
          attempts: 3,
          delayMs: 500,
          ...(this.sleep !== undefined && { sleep: this.sleep }),
          onRetry: (error, attempt) => {
            this.logger.warn(
              `[oracle-payments] could not persist the engagement for thread ${threadId} (attempt ${attempt}), retrying: ${errorMessage(error)}`,
            );
          },
        },
      );
    } catch (error) {
      this.logger.error(
        `[oracle-payments] escrow ${intent.txHash} is reserved on-chain for collection ` +
          `${start.collectionId} but the engagement for thread ${threadId} could not be persisted ` +
          `(${errorMessage(error)}). The user holds a live reservation with no job record: they ` +
          'cannot start new paid work until it lapses, and cancel_work has nothing to release.',
      );
      return {
        ok: false,
        reason: 'intent_failed',
        // Deliberately distinct from a reservation failure: the payment IS
        // reserved here, so the user is holding one and cannot start anything
        // else until it lapses. Telling them "try again shortly" would be a
        // lie, and only this text distinguishes the two.
        detail:
          `the payment was reserved on-chain (tx ${intent.txHash}) but the job record could not be ` +
          `saved (${errorMessage(error)}), so the job did not open and the reservation is stranded ` +
          'until it expires on its own',
      };
    }

    return { ok: true, engagement };
  }

  /**
   * Lock the service price on-chain. A thrown transport error and a non-zero tx
   * code both mean nothing is reserved, and both come back as a failure
   * carrying the chain's own wording — logging it and returning a bare "no" is
   * what leaves the agent with nothing to tell the user.
   *
   * Public because the delivery lane reserves again on its own account: a job
   * that outran its window needs a fresh intent before its claim can settle,
   * and that must be the same chain write with the same failure handling, not
   * a second copy of it.
   */
  async reserve(start: CommerceEngagementStart): Promise<ReservationResult> {
    // Fail closed on a start with no granted denom: reserving in a guessed
    // one would lock escrow the grant never covers and read back to the user
    // as "max amount too low" (uPay spec §5 R1). The gate always supplies it,
    // so this refusal only ever names a wiring fault, not a user's contract.
    const denom = grantedDenom(start);
    if (denom === undefined) {
      return {
        ok: false,
        detail:
          'the job carries no granted payment denom to price the reservation in — the contract ' +
          'gate supplies it, so this is a fault on our side, and nothing was reserved',
      };
    }
    const price = priceToCoin(start.priceUsd, denom);
    const amount: ClaimCoin[] = [
      { denom: price.denom, amount: String(price.amount) },
    ];

    let result: SubmitClaimResult;
    try {
      result = await this.chain.sendIntent({
        collectionId: start.collectionId,
        amount,
      });
    } catch (error) {
      return this.refuseReservation(errorMessage(error), start, denom);
    }

    if (result.code !== 0) {
      return this.refuseReservation(
        result.rawLog || 'unknown chain error',
        start,
        denom,
        result.code,
      );
    }

    const submittedAt = this.clock();
    const expiresAt = expiryFrom(submittedAt, start.intentDurationNs);
    return {
      ok: true,
      intent: {
        txHash: result.transactionHash,
        submittedAt: submittedAt.toISOString(),
        ...(expiresAt !== undefined && { expiresAt }),
      },
    };
  }

  /**
   * Turn a chain refusal into a reservation failure the agent can relay, with
   * the raw text kept for the log line and never for the user.
   *
   * Two jobs, both about what the user ends up reading. A refusal for want of
   * funds is told apart and answered in the user's own money, because the
   * chain states that one as micro-unit arithmetic in an internal denom —
   * precisely what must not reach them. Every other refusal keeps the chain's
   * own wording, with any amounts in it rewritten as credits.
   */
  private refuseReservation(
    chainText: string,
    start: CommerceEngagementStart,
    denom: string,
    code?: number,
  ): ReservationResult {
    const at = code !== undefined ? ` (code ${code})` : '';
    this.logger.warn(
      `[oracle-payments] claim intent failed for collection ${start.collectionId}${at}: ${chainText}`,
    );

    if (isInsufficientFundsFailure(chainText)) {
      return {
        ok: false,
        insufficientFunds: true,
        detail:
          `their account does not hold enough credits to reserve the ` +
          `${formatCredits(priceToCredits(start.priceUsd))} this job costs, so nothing was ` +
          'reserved and nothing was charged — they need to top up their account before it can start',
      };
    }

    return {
      ok: false,
      detail: `the chain rejected the payment reservation${at}: ${creditsInChainText(chainText, denom)}`,
    };
  }
}

/**
 * The deadline the escrow auto-releases at, stamped once at start so later
 * checks read the engagement instead of re-querying the contract. Undefined
 * when the AuthZ snapshot carried no usable duration — an unknown window is
 * left unbounded rather than guessed at.
 */
export function expiryFrom(
  startedAt: Date,
  intentDurationNs: string | number | undefined,
): string | undefined {
  if (intentDurationNs === undefined) return undefined;
  const durationNs = Number(intentDurationNs);
  if (!Number.isFinite(durationNs) || durationNs <= 0) return undefined;
  return new Date(
    startedAt.getTime() + durationNs / NANOSECONDS_PER_MILLISECOND,
  ).toISOString();
}
