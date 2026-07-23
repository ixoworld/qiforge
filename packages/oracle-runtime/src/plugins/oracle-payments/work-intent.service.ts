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
import { errorMessage, priceToCoin } from './util.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export interface WorkIntentServiceDeps {
  engagement: EngagementService;
  /** Network name for the price→denom conversion (portal parity). */
  network: string;
  chain?: IntentChainClient;
  clock?: () => Date;
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
  private readonly logger?: Logger;

  constructor(deps: WorkIntentServiceDeps) {
    this.engagement = deps.engagement;
    this.network = deps.network;
    this.chain = deps.chain ?? defaultIntentChainClient;
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger;
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
    };

    const intent = await this.reserve(start);
    if (!intent) return { ok: false, reason: 'intent_failed' };

    return {
      ok: true,
      engagement: await this.engagement.start(roomId, threadId, {
        ...data,
        intent,
      }),
    };
  }

  /**
   * Lock the service price on-chain. Returns `null` on any failure — a thrown
   * transport error and a non-zero tx code both mean nothing is reserved.
   */
  private async reserve(
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
      this.logger?.warn?.(
        `[oracle-payments] claim intent failed for collection ${start.collectionId}: ${errorMessage(error)}`,
      );
      return null;
    }

    if (result.code !== 0) {
      this.logger?.warn?.(
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
