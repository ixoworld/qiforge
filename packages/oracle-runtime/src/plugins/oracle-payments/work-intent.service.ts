import { Logger as NestLogger } from '@nestjs/common';
import type {
  CommerceEngagementStart,
  CommerceEngagementStartResult,
} from '../../modules/messages/commerce-router-port.js';
import type { CommerceEngagement, Logger } from '../../plugin-api/types.js';
import {
  defaultIntentChainClient,
  type ClaimCoin,
  type IntentChainClient,
  type SubmitClaimResult,
} from './claim-lane.js';
import type {
  EngagementService,
  EngagementStartData,
} from './engagement.service.js';
import { errorMessage, priceToCoin, retry } from './util.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export interface WorkIntentServiceDeps {
  engagement: EngagementService;
  /** Network name for the price→denom conversion (portal parity). */
  network: string;
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
 * router surfaces `intent_failed` and the agent explains instead of working
 * unpaid. The delivery lane then settles the claim against that reservation
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
  private readonly network: string;
  private readonly chain: IntentChainClient;
  private readonly clock: () => Date;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(deps: WorkIntentServiceDeps) {
    this.engagement = deps.engagement;
    this.network = deps.network;
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
    const data: EngagementStartData = {
      serviceId: start.serviceId,
      serviceName: start.serviceName,
      priceUsd: start.priceUsd,
      collectionId: start.collectionId,
      adminAddress: start.adminAddress,
      ...(start.userDid !== undefined && { userDid: start.userDid }),
    };

    const intent = await this.reserve(start);
    if (!intent) return { ok: false, reason: 'intent_failed' };

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
      return { ok: false, reason: 'intent_failed' };
    }

    return { ok: true, engagement };
  }

  /**
   * Lock the service price on-chain. Returns `null` on any failure — a thrown
   * transport error and a non-zero tx code both mean nothing is reserved.
   *
   * Public because the delivery lane reserves again on its own account: a job
   * that outran its window needs a fresh intent before its claim can settle,
   * and that must be the same chain write with the same failure handling, not
   * a second copy of it.
   */
  async reserve(
    start: CommerceEngagementStart,
  ): Promise<CommerceEngagement['intent'] | null> {
    const price = priceToCoin(start.priceUsd, this.network);
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
      this.logger.warn(
        `[oracle-payments] claim intent failed for collection ${start.collectionId}: ${errorMessage(error)}`,
      );
      return null;
    }

    if (result.code !== 0) {
      this.logger.warn(
        `[oracle-payments] claim intent rejected for collection ${start.collectionId} (code ${result.code}): ${
          result.rawLog || 'unknown chain error'
        }`,
      );
      return null;
    }

    const submittedAt = this.clock();
    const expiresAt = expiryFrom(submittedAt, start.intentDurationNs);
    return {
      txHash: result.transactionHash,
      submittedAt: submittedAt.toISOString(),
      ...(expiresAt !== undefined && { expiresAt }),
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
