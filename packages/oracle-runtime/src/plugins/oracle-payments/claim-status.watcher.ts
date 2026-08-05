import { MatrixManager } from '@ixo/matrix';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { postOracleComponent } from '../../matrix/oracle-component-event.js';
import type {
  CommerceEngagement,
  CommercePaymentOutcome,
} from '../../plugin-api/types.js';
import {
  defaultEvaluationChainClient,
  type EvaluationChainClient,
} from './claim-lane.js';
import {
  EngagementService,
  type PendingClaimRef,
} from './engagement.service.js';
import {
  claimDeepLink,
  DEFAULT_CURRENCY,
  errorMessage,
  resolvePortalUrl,
  retry,
} from './util.js';

/** Injection token for the watcher's test seams (chain, Matrix, clock). */
export const CLAIM_STATUS_WATCHER_DEPS = Symbol.for('ClaimStatusWatcherDeps');

/**
 * Every 2 minutes: the engine evaluates within about a minute, and the poll is
 * a single Blocksync read per engagement awaiting an outcome.
 */
const CLAIM_POLL_CRON = '*/2 * * * *';

/**
 * `EvaluationStatus` from the chain's `ixo/claims/v1beta1` codegen (read from
 * `@ixo/impactxclient-sdk`'s generated `claims` module). Mirrored as literals
 * rather than imported, because the SDK is a transitive dependency here.
 */
const EVALUATION_STATUS = {
  PENDING: 0,
  APPROVED: 1,
  REJECTED: 2,
  DISPUTED: 3,
  INVALIDATED: 4,
  FLAGGED: 5,
} as const;

/**
 * How each on-chain status reads to the user. `INVALIDATED` joins `REJECTED`
 * — in both cases no payment fires and the escrow goes back. `PENDING` is
 * absent on purpose: nothing has happened yet, so nothing is reported.
 */
const OUTCOME_BY_STATUS = new Map<number, CommercePaymentOutcome>([
  [EVALUATION_STATUS.APPROVED, 'approved'],
  [EVALUATION_STATUS.REJECTED, 'rejected'],
  [EVALUATION_STATUS.DISPUTED, 'disputed'],
  [EVALUATION_STATUS.INVALIDATED, 'rejected'],
  [EVALUATION_STATUS.FLAGGED, 'under_review'],
]);

/**
 * Statuses that end the engagement. `FLAGGED` is deliberately not one: the
 * chain documents it as a non-terminal "declining to decide", re-evaluable to
 * a terminal status later — so the user is told once and the claim stays
 * watched.
 */
const TERMINAL_STATUSES: ReadonlySet<number> = new Set([
  EVALUATION_STATUS.APPROVED,
  EVALUATION_STATUS.REJECTED,
  EVALUATION_STATUS.DISPUTED,
  EVALUATION_STATUS.INVALIDATED,
]);

/**
 * Stop watching a claim that has gone this long without an evaluation — the
 * index is room state, and an evaluation that never comes must not grow it
 * forever.
 */
const MAX_WATCH_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Which claim lane an engagement's claim came from. */
type ClaimLane = 'delivery' | 'cancellation';

export interface ClaimStatusWatcherDeps {
  chain?: EvaluationChainClient;
  /** Event poster. Defaults to `MatrixManager.getInstance().sendMatrixEvent`. */
  postEvent?: (
    roomId: string,
    eventType: string,
    content: object,
  ) => Promise<string>;
  clock?: () => Date;
  /** Sleep seam for the chain-read retry — tests skip the backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Closes the payment loop in chat. `deliver_work` and `cancel_work` submit a
 * claim and go quiet; the engine evaluates it within about a minute and the
 * chain either releases the escrow to the oracle or returns it to the user.
 * This cron polls Blocksync for each submitted claim's evaluation and posts a
 * `payment_update` card into the engagement's thread, then closes the
 * engagement.
 *
 * Two lanes settle through the same claim mechanism and must never be worded
 * alike: a rejected DELIVERY means the work was judged not to meet the
 * contract, while a rejected CANCELLATION release claim is the expected
 * outcome — it is what completes the refund.
 *
 * Idempotent by construction: the reported status is persisted on the
 * engagement, so a restart never re-posts a card, and a re-evaluated (flagged
 * then resolved) claim posts exactly one more. Nothing here throws out of the
 * cron — a chain read failure, a missing claim, or a failed post leaves the
 * engagement indexed and is retried next tick.
 */
@Injectable()
export class ClaimStatusWatcher {
  private readonly logger = new Logger(ClaimStatusWatcher.name);
  private readonly chain: EvaluationChainClient;
  private readonly postEvent: NonNullable<ClaimStatusWatcherDeps['postEvent']>;
  private readonly clock: () => Date;
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(
    private readonly engagement: EngagementService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(CLAIM_STATUS_WATCHER_DEPS)
    deps: ClaimStatusWatcherDeps = {},
  ) {
    this.chain = deps.chain ?? defaultEvaluationChainClient;
    this.postEvent =
      deps.postEvent ??
      ((roomId, eventType, content) =>
        MatrixManager.getInstance().sendMatrixEvent(
          roomId,
          eventType,
          content,
        ));
    this.clock = deps.clock ?? (() => new Date());
    this.sleep = deps.sleep;
  }

  @Cron(CLAIM_POLL_CRON)
  async pollSubmittedClaims(): Promise<void> {
    let pending: PendingClaimRef[];
    try {
      pending = await this.engagement.listPendingClaims();
    } catch (error) {
      this.logger.warn(
        `[oracle-payments] could not read the pending-claim index: ${errorMessage(error)}`,
      );
      return;
    }
    if (pending.length === 0) return;

    for (const ref of pending) {
      try {
        await this.check(ref);
      } catch (error) {
        // Never lose the engagement over one bad tick — it stays indexed.
        this.logger.warn(
          `[oracle-payments] claim status check failed for ${ref.threadId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** One engagement's poll: read, report if new, close if terminal. */
  private async check(ref: PendingClaimRef): Promise<void> {
    const { roomId, threadId } = ref;
    const engagement = await this.engagement.get(roomId, threadId);
    const claimId = engagement?.claim?.cid;
    if (!engagement || !claimId) {
      this.logger.warn(
        `[oracle-payments] dropping ${threadId} from the claim index — no submitted claim on the engagement.`,
      );
      await this.engagement.untrackPendingClaim(roomId, threadId);
      return;
    }

    if (this.isStale(engagement)) {
      this.logger.warn(
        `[oracle-payments] claim ${claimId} has gone unevaluated past the watch window — no longer polling it.`,
      );
      await this.engagement.untrackPendingClaim(roomId, threadId);
      return;
    }

    const evaluation = await retry(() => this.chain.getEvaluation(claimId), {
      attempts: 2,
      ...(this.sleep !== undefined && { sleep: this.sleep }),
    });
    const status = evaluation?.status;
    if (status === undefined) return;

    const outcome = OUTCOME_BY_STATUS.get(status);
    if (!outcome) return;

    if (engagement.paymentOutcome?.status !== status) {
      await this.postUpdate(roomId, threadId, engagement, claimId, outcome);
      await this.engagement.recordPaymentOutcome(roomId, threadId, {
        status,
        outcome,
        reportedAt: this.clock().toISOString(),
      });
    }

    if (TERMINAL_STATUSES.has(status)) {
      await this.engagement.transition(roomId, threadId, 'closed');
      await this.engagement.untrackPendingClaim(roomId, threadId);
    }
  }

  private async postUpdate(
    roomId: string,
    threadId: string,
    engagement: CommerceEngagement,
    claimId: string,
    outcome: CommercePaymentOutcome,
  ): Promise<void> {
    const lane: ClaimLane =
      engagement.cancelledAt !== undefined ? 'cancellation' : 'delivery';
    const claimUrl = claimDeepLink(
      resolvePortalUrl(
        this.config.get<string>('PORTAL_URL'),
        this.config.get<string>('NETWORK'),
      ),
      claimId,
    );

    await postOracleComponent({ postEvent: this.postEvent }, roomId, {
      component: 'payment_update',
      props: {
        claimId,
        outcome,
        lane,
        service: {
          id: engagement.serviceId,
          name: engagement.serviceName,
          price: { amount: engagement.priceUsd, currency: DEFAULT_CURRENCY },
        },
        claimUrl,
      },
      body: paymentUpdateBody(engagement, claimId, outcome, lane),
      sessionId: threadId,
      // Deterministic: the same claim at the same status renders one card.
      requestId: `payment-update:${claimId}`,
      threadId,
    });
  }

  /** `true` once the claim has waited longer than the watch window. */
  private isStale(engagement: CommerceEngagement): boolean {
    const submittedAt = engagement.claim?.submittedAt;
    if (!submittedAt) return false;
    const submitted = Date.parse(submittedAt);
    if (!Number.isFinite(submitted)) return false;
    return this.clock().getTime() - submitted > MAX_WATCH_AGE_MS;
  }
}

/**
 * The plain-text fallback shown by clients without a component renderer. The
 * cancellation lane never says the work was rejected: its claim is a release,
 * and a rejection there IS the refund completing.
 */
function paymentUpdateBody(
  engagement: CommerceEngagement,
  claimId: string,
  outcome: CommercePaymentOutcome,
  lane: ClaimLane,
): string {
  const price = `${engagement.priceUsd} ${DEFAULT_CURRENCY}`;
  const name = engagement.serviceName;
  const suffix = ` (claim ${claimId}).`;

  if (lane === 'cancellation') {
    switch (outcome) {
      case 'rejected':
        return `Refund complete: the ${price} held for the cancelled "${name}" job is back with you${suffix}`;
      case 'under_review':
        return `Refund pending: the release record for the cancelled "${name}" job is under review${suffix}`;
      case 'disputed':
        return `Refund on hold: the release record for the cancelled "${name}" job is disputed${suffix}`;
      case 'approved':
        return `Cancelled job settled: the release record for "${name}" was approved on-chain${suffix}`;
    }
  }

  switch (outcome) {
    case 'approved':
      return `Payment settled: ${name} — ${price}${suffix}`;
    case 'rejected':
      return `Payment not released: the evaluation found "${name}" did not meet the contract, so the ${price} held for it went back to you${suffix}`;
    case 'under_review':
      return `Still under review: the claim for "${name}" was flagged for another look before payment${suffix}`;
    case 'disputed':
      return `Payment on hold: the claim for "${name}" is disputed${suffix}`;
  }
}
