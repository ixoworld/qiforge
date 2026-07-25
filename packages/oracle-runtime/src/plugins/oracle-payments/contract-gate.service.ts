import { Logger as NestLogger } from '@nestjs/common';
import type {
  CommerceGateResult,
  CommerceRoutedService,
} from '../../modules/messages/commerce-router-port.js';
import type { Logger } from '../../plugin-api/types.js';
import type { ContractRecordService } from './contract-record.service.js';
import type { EngagementService } from './engagement.service.js';
import type { ContractRecord } from './types.js';
import { isEngagementExpired, priceToCoin } from './util.js';

/** How long a gate consults the same contract record before re-asking. */
const GATE_CACHE_TTL_MS = 60_000;

/** The engagement lookup the gate needs: the user's one live job, if any. */
export type ActiveEngagementLookup = Pick<
  EngagementService,
  'findActiveForUser'
>;

export interface ContractGateServiceDeps {
  contractRecord: ContractRecordService;
  engagement: ActiveEngagementLookup;
  /** Engine base URL (`EVAL_ENGINE_URL`) — unset disables lookups upstream. */
  engineUrl?: string;
  /** Network name for price→denom conversion (portal parity). */
  network: string;
  clock?: () => number;
  logger?: Logger;
}

interface GateCacheEntry {
  record: ContractRecord | null;
  expiresAt: number;
}

/**
 * The contract gate for work-classified turns, checked in order — no other job
 * already running for this user → engine record present and granted → quota
 * remaining → `maxAmount` covers the service price → serviceId contracted. The
 * record is cached ~60s per (roomId, senderDid) on top of the record service's
 * own cache; `invalidate` (driven by the `ixo.oracle.contracted` cache-buster)
 * drops both layers so "contract → immediately say go" works.
 *
 * Never throws — every failure lane degrades to a gate failure, and a gate
 * failure never errors the turn (the router routes to support with context).
 */
export class ContractGateService {
  private readonly contractRecord: ContractRecordService;
  private readonly engagement: ActiveEngagementLookup;
  private readonly engineUrl?: string;
  private readonly network: string;
  private readonly clock: () => number;
  private readonly logger: Logger;
  private readonly cache = new Map<string, GateCacheEntry>();

  constructor(deps: ContractGateServiceDeps) {
    this.contractRecord = deps.contractRecord;
    this.engagement = deps.engagement;
    this.engineUrl = deps.engineUrl;
    this.network = deps.network;
    this.clock = deps.clock ?? Date.now;
    this.logger = deps.logger ?? new NestLogger(ContractGateService.name);
  }

  /** The gate's clock as a `Date` — the shape the shared expiry predicate reads. */
  private now(): Date {
    return new Date(this.clock());
  }

  /** Drop a sender's cached gate record (all rooms) so the next check re-queries. */
  invalidate(senderDid: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`|${senderDid}`)) this.cache.delete(key);
    }
  }

  async check(params: {
    roomId: string;
    /** The thread the request arrived in — excluded from the conflict check. */
    threadId: string;
    senderDid: string;
    service: CommerceRoutedService;
  }): Promise<CommerceGateResult> {
    const { roomId, threadId, senderDid, service } = params;

    // The chain accepts one active claim intent per (agent, user claim
    // collection), so a second concurrent job could never reserve its payment.
    // Refuse before the chain write rather than let `sendClaimIntent` fail and
    // surface as a payment problem. Scoped to the user, not the room: the
    // reservation the check protects is the user's, wherever they opened it.
    // A cancelled job releases its reservation by claiming against it and
    // stops being active, so the only cancelled jobs still seen here are ones
    // whose release never reached the chain — the reservation really is still
    // held, and the overlay says so.
    const inProgress = await this.engagement.findActiveForUser({
      userDid: senderDid,
      roomId,
      exclude: { roomId, threadId },
    });
    // An expired reservation blocks nothing: the escrow auto-released, so the
    // chain would accept a new intent right now. The lookup closes such a job
    // on sight, but the deadline is re-read here rather than assumed — a job
    // that can no longer be delivered must never be the reason a user is told
    // to wait, which is exactly the dead end this check exists to prevent.
    if (inProgress && !isEngagementExpired(inProgress.engagement, this.now())) {
      return {
        ok: false,
        reason: 'engagement_in_progress',
        inProgress: {
          serviceId: inProgress.engagement.serviceId,
          serviceName: inProgress.engagement.serviceName,
          threadId: inProgress.threadId,
          ...(inProgress.engagement.cancelledAt !== undefined && {
            releaseFailed: true,
          }),
        },
      };
    }

    const record = await this.getRecord(roomId, senderDid);
    if (!record || !record.authz.granted) {
      return { ok: false, reason: 'not_contracted' };
    }
    if (record.authz.agentQuotaRemaining <= 0) {
      return { ok: false, reason: 'quota_exhausted' };
    }

    const price = priceToCoin(service.priceUsd, this.network);
    const max = record.authz.maxAmount;
    const maxAmount = Number(max.amount);
    const maxCovers =
      max.denom === price.denom &&
      Number.isFinite(maxAmount) &&
      maxAmount >= price.amount;
    if (!maxCovers) {
      return { ok: false, reason: 'max_amount_too_low' };
    }

    if (!record.serviceIds.includes(service.id)) {
      return { ok: false, reason: 'service_not_contracted' };
    }

    return {
      ok: true,
      start: {
        serviceId: service.id,
        serviceName: service.name,
        priceUsd: service.priceUsd,
        collectionId: record.collectionId,
        adminAddress: record.adminAddress,
        userDid: senderDid,
        intentDurationNs: record.authz.intentDurationNs,
      },
    };
  }

  private async getRecord(
    roomId: string,
    senderDid: string,
  ): Promise<ContractRecord | null> {
    const key = `${roomId}|${senderDid}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.clock()) {
      return cached.record;
    }

    let record: ContractRecord | null;
    try {
      record = await this.contractRecord.lookup({
        engineUrl: this.engineUrl,
        subscriberDid: senderDid,
      });
    } catch (error) {
      // The record service is non-throwing by contract; belt-and-braces.
      this.logger.warn(
        `[oracle-payments] contract gate lookup failed for ${senderDid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    this.cache.set(key, {
      record,
      expiresAt: this.clock() + GATE_CACHE_TTL_MS,
    });
    return record;
  }
}
