import { MatrixError, MatrixManager } from '@ixo/matrix';
import { z } from 'zod';
import type {
  CommerceEngagement,
  CommerceEngagementStatus,
  Logger,
} from '../../plugin-api/types.js';
import { errorMessage } from './util.js';

/**
 * Room-state key prefix — one state event per engagement, keyed by the thread
 * root event id, so concurrent threads never race a shared map.
 */
export const WORK_ENGAGEMENT_STATE_KEY_PREFIX = 'work_engagement.';

export function engagementStateKey(threadRootEventId: string): string {
  return `${WORK_ENGAGEMENT_STATE_KEY_PREFIX}${threadRootEventId}`;
}

/**
 * Room-state key of the pointer to the room's one active engagement. The
 * per-thread state events cannot be searched by status without paginating the
 * whole room, so the thread holding the live job is indexed explicitly — one
 * cached read answers "is this user already working with us?".
 */
export const ACTIVE_ENGAGEMENT_INDEX_STATE_KEY = `${WORK_ENGAGEMENT_STATE_KEY_PREFIX}active`;

const ActiveIndexSchema = z.object({ threadId: z.string().min(1) });

/**
 * Room-state key of the cross-room index of claims awaiting evaluation. Unlike
 * the per-thread engagement events this one lives in a single index room (the
 * oracle's own account room), because the claim-status watcher runs on a cron
 * with no room to start from — it needs the list of (room, thread) pairs that
 * have a claim on-chain.
 */
export const PENDING_CLAIMS_STATE_KEY = `${WORK_ENGAGEMENT_STATE_KEY_PREFIX}pending_claims`;

/** One engagement whose submitted claim is still awaiting its evaluation. */
export interface PendingClaimRef {
  roomId: string;
  threadId: string;
}

const PendingClaimsSchema = z.object({
  claims: z.array(
    z.object({ roomId: z.string().min(1), threadId: z.string().min(1) }),
  ),
});

/** An active engagement together with the thread it lives in. */
export interface ActiveEngagementRef {
  threadId: string;
  engagement: CommerceEngagement;
}

const EngagementSchema: z.ZodType<CommerceEngagement> = z.object({
  status: z.enum(['active', 'delivered', 'closed']),
  serviceId: z.string(),
  serviceName: z.string(),
  priceUsd: z.number(),
  collectionId: z.string(),
  adminAddress: z.string(),
  startedAt: z.string(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
  intent: z
    .object({
      txHash: z.string(),
      submittedAt: z.string(),
      expiresAt: z.string().optional(),
    })
    .optional(),
  claim: z
    .object({
      cid: z.string(),
      txHash: z.string().optional(),
      submittedAt: z.string(),
    })
    .optional(),
  paymentOutcome: z
    .object({
      status: z.number(),
      outcome: z.enum(['approved', 'rejected', 'under_review', 'disputed']),
      reportedAt: z.string(),
    })
    .optional(),
});

/** The data an engagement starts from — the rest is stamped by `start`. */
export interface EngagementStartData {
  serviceId: string;
  serviceName: string;
  priceUsd: number;
  collectionId: string;
  adminAddress: string;
  /** The escrow reserved for this job, when the engagement is intent-backed. */
  intent?: CommerceEngagement['intent'];
}

/**
 * Narrow view over `MatrixStateManager` — injectable for tests. `getState`
 * returns `unknown` because the payload is validated on the way in, not
 * trusted from the caller's type argument.
 */
export interface EngagementStateStore {
  getState(roomId: string, stateKey: string): Promise<unknown>;
  setState<C>(payload: {
    roomId: string;
    stateKey: string;
    data: C;
  }): Promise<void>;
}

export interface EngagementServiceDeps {
  /** Defaults to `MatrixManager.getInstance().stateManager`, resolved lazily. */
  stateStore?: () => EngagementStateStore;
  clock?: () => Date;
  logger?: Logger;
  /**
   * Room holding the cross-room pending-claim index — the oracle's own account
   * room. Without it the index is inert and the claim watcher has nothing to
   * poll; set at boot via {@link EngagementService.setClaimIndexRoom}.
   */
  claimIndexRoomId?: string;
}

/**
 * Thread-scoped work engagements — one per Matrix thread, stored as room
 * state (`ixo.room.state` / `work_engagement.<threadRootEventId>`) following
 * the delegation-store pattern: durable across restarts, portal-readable,
 * zero new infra. An in-process cache in front avoids a state read per
 * message; every write refreshes the cache.
 *
 * Engagements stay thread-keyed, but only ONE may be active in a room at a
 * time: the chain accepts a single active claim intent per (agent, user claim
 * collection), and a room is one user's channel with one oracle. The active
 * thread is indexed under {@link ACTIVE_ENGAGEMENT_INDEX_STATE_KEY} so
 * {@link EngagementService.findActive} answers that question without walking
 * the room's state.
 *
 * Reads never break a turn: a missing state event, an invalid payload, and
 * transport errors all read as "no engagement". Writes throw — the router
 * fails open to support mode when a start cannot be persisted.
 */
export class EngagementService {
  private readonly stateStore: () => EngagementStateStore;
  private readonly clock: () => Date;
  private readonly logger?: Logger;
  private readonly cache = new Map<string, CommerceEngagement | null>();
  /** roomId → thread id of the room's active engagement, or `null` for none. */
  private readonly activeIndexCache = new Map<string, string | null>();
  private claimIndexRoomId?: string;
  /** In-process mirror of the pending-claim index; `undefined` until read. */
  private pendingClaimsCache?: PendingClaimRef[];

  constructor(deps: EngagementServiceDeps = {}) {
    this.stateStore =
      deps.stateStore ?? (() => MatrixManager.getInstance().stateManager);
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger;
    this.claimIndexRoomId = deps.claimIndexRoomId;
  }

  /**
   * Point the pending-claim index at the oracle's account room. Called at boot,
   * where the validated config is known; before it the index is inert.
   */
  setClaimIndexRoom(roomId: string): void {
    this.claimIndexRoomId = roomId;
  }

  /** The thread's engagement in any status, or `null`. */
  async get(
    roomId: string,
    threadId: string,
  ): Promise<CommerceEngagement | null> {
    const cacheKey = this.cacheKey(roomId, threadId);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let raw: unknown;
    try {
      raw = await this.stateStore().getState(
        roomId,
        engagementStateKey(threadId),
      );
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
        this.cache.set(cacheKey, null);
        return null;
      }
      // Transient read failure: report "none" but do NOT cache — a live
      // engagement must not be masked past the outage.
      this.logger?.warn(
        `[oracle-payments] engagement read failed for ${threadId}: ${errorMessage(error)}`,
      );
      return null;
    }

    const parsed = EngagementSchema.safeParse(raw);
    if (!parsed.success) {
      // Empty/overwritten state (the Matrix "delete") or a corrupt payload —
      // both mean no engagement.
      this.cache.set(cacheKey, null);
      return null;
    }

    this.cache.set(cacheKey, parsed.data);
    return parsed.data;
  }

  /** The thread's engagement only while `active`, or `null`. */
  async getActive(
    roomId: string,
    threadId: string,
  ): Promise<CommerceEngagement | null> {
    const engagement = await this.get(roomId, threadId);
    return engagement?.status === 'active' ? engagement : null;
  }

  /**
   * The room's active engagement in ANY thread, or `null`. `excludeThreadId`
   * drops the caller's own thread, so a delivery-time gate check does not read
   * as a conflict with itself.
   *
   * Answered from the in-process cache whenever a live engagement has already
   * been seen in this room; otherwise from the room's active-thread index (one
   * cached state read). A pointer left behind by a crashed write resolves to a
   * non-active engagement and reads as "none".
   */
  async findActive(
    roomId: string,
    excludeThreadId?: string,
  ): Promise<ActiveEngagementRef | null> {
    for (const [key, cached] of this.cache) {
      if (!cached || cached.status !== 'active') continue;
      const threadId = this.threadIdFromCacheKey(key, roomId);
      if (threadId === undefined || threadId === excludeThreadId) continue;
      return { threadId, engagement: cached };
    }

    const indexed = await this.readActiveIndex(roomId);
    if (!indexed || indexed === excludeThreadId) return null;

    const engagement = await this.get(roomId, indexed);
    if (engagement?.status !== 'active') return null;
    return { threadId: indexed, engagement };
  }

  /** Persist a new `active` engagement for the thread. Throws on write failure. */
  async start(
    roomId: string,
    threadId: string,
    data: EngagementStartData,
  ): Promise<CommerceEngagement> {
    const { intent, ...rest } = data;
    const engagement: CommerceEngagement = {
      ...rest,
      status: 'active',
      startedAt: this.clock().toISOString(),
      ...(intent !== undefined && { intent }),
    };
    // Index first: a pointer to a thread whose engagement never landed reads
    // as "none", whereas an engagement no pointer knows about would hide a
    // live job from every other thread.
    await this.writeActiveIndex(roomId, threadId);
    await this.write(roomId, threadId, engagement);
    return engagement;
  }

  /**
   * Move the thread's engagement to `status`. Returns the updated engagement,
   * or `null` when the thread has none. Throws on write failure — a
   * transition the store rejected must not be reported as done.
   */
  async transition(
    roomId: string,
    threadId: string,
    status: CommerceEngagementStatus,
  ): Promise<CommerceEngagement | null> {
    const current = await this.get(roomId, threadId);
    if (!current) return null;
    const updated: CommerceEngagement = { ...current, status };
    await this.write(roomId, threadId, updated);
    return updated;
  }

  /**
   * Record the work claim on the thread's engagement. Called twice by the
   * delivery lane: once with the signed claim's cid BEFORE the chain call (so
   * a failed submit resumes instead of re-signing), then again with the tx
   * hash once the chain accepts it. Returns `null` when the thread has no
   * engagement. Throws on write failure — an unrecorded cid would re-sign.
   */
  async recordClaim(
    roomId: string,
    threadId: string,
    claim: { cid: string; txHash?: string; submittedAt: string },
  ): Promise<CommerceEngagement | null> {
    const current = await this.get(roomId, threadId);
    if (!current) return null;
    const updated: CommerceEngagement = {
      ...current,
      claim: {
        cid: claim.cid,
        submittedAt: claim.submittedAt,
        ...(claim.txHash !== undefined && { txHash: claim.txHash }),
      },
    };
    await this.write(roomId, threadId, updated);

    // Only a claim the chain accepted is worth watching: a cid persisted
    // before the submit may never reach the chain, and polling for its
    // evaluation would never terminate.
    if (claim.txHash !== undefined) {
      await this.trackPendingClaim(roomId, threadId);
    }
    return updated;
  }

  /**
   * Record the evaluation outcome the user has been told about, so a restart
   * never re-posts a card for a claim already reported. Returns `null` when
   * the thread has no engagement.
   */
  async recordPaymentOutcome(
    roomId: string,
    threadId: string,
    outcome: NonNullable<CommerceEngagement['paymentOutcome']>,
  ): Promise<CommerceEngagement | null> {
    const current = await this.get(roomId, threadId);
    if (!current) return null;
    const updated: CommerceEngagement = { ...current, paymentOutcome: outcome };
    await this.write(roomId, threadId, updated);
    return updated;
  }

  /** The engagements whose submitted claims are still awaiting evaluation. */
  async listPendingClaims(): Promise<PendingClaimRef[]> {
    const indexRoomId = this.claimIndexRoomId;
    if (!indexRoomId) return [];
    if (this.pendingClaimsCache !== undefined) {
      return [...this.pendingClaimsCache];
    }

    let raw: unknown;
    try {
      raw = await this.stateStore().getState(
        indexRoomId,
        PENDING_CLAIMS_STATE_KEY,
      );
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
        this.pendingClaimsCache = [];
        return [];
      }
      // Transient read failure: report "none" but do NOT cache — the next
      // tick retries rather than dropping every watched claim.
      this.logger?.warn(
        `[oracle-payments] pending-claim index read failed: ${errorMessage(error)}`,
      );
      return [];
    }

    const parsed = PendingClaimsSchema.safeParse(raw);
    this.pendingClaimsCache = parsed.success ? parsed.data.claims : [];
    return [...this.pendingClaimsCache];
  }

  /** Drop a thread from the pending-claim index. Best-effort. */
  async untrackPendingClaim(roomId: string, threadId: string): Promise<void> {
    const claims = await this.listPendingClaims();
    const remaining = claims.filter(
      (c) => c.roomId !== roomId || c.threadId !== threadId,
    );
    if (remaining.length === claims.length) return;
    await this.writePendingClaims(remaining);
  }

  /**
   * Add a thread to the pending-claim index. Best-effort: the claim is already
   * on-chain, so a failed index write must not fail the delivery — it only
   * costs the user their payment card.
   */
  private async trackPendingClaim(
    roomId: string,
    threadId: string,
  ): Promise<void> {
    try {
      const claims = await this.listPendingClaims();
      if (claims.some((c) => c.roomId === roomId && c.threadId === threadId)) {
        return;
      }
      await this.writePendingClaims([...claims, { roomId, threadId }]);
    } catch (error) {
      this.logger?.warn(
        `[oracle-payments] could not index the pending claim for ${threadId}: ${errorMessage(error)}`,
      );
    }
  }

  private async writePendingClaims(claims: PendingClaimRef[]): Promise<void> {
    const indexRoomId = this.claimIndexRoomId;
    if (!indexRoomId) return;
    await this.stateStore().setState<{ claims: PendingClaimRef[] }>({
      roomId: indexRoomId,
      stateKey: PENDING_CLAIMS_STATE_KEY,
      data: { claims },
    });
    this.pendingClaimsCache = claims;
  }

  /**
   * Stamp a user cancellation on the thread's engagement WITHOUT ending it.
   * The escrow reserved at start is only freed by a claim, so the engagement
   * has to keep blocking new work until the release claim lands; an engagement
   * that reads `active` while carrying `cancelledAt` is a release that failed
   * and can be retried. Returns `null` when the thread has no engagement.
   */
  async markCancelRequested(
    roomId: string,
    threadId: string,
    reason?: string,
  ): Promise<CommerceEngagement | null> {
    const current = await this.get(roomId, threadId);
    if (!current) return null;
    const updated: CommerceEngagement = {
      ...current,
      cancelledAt: current.cancelledAt ?? this.clock().toISOString(),
      ...cancelReasonPatch(current, reason),
    };
    await this.write(roomId, threadId, updated);
    return updated;
  }

  /**
   * Close the thread's engagement as a user cancellation (`cancel_work`),
   * recording when and — if given — why. Returns `null` when the thread has
   * no engagement to cancel. The on-chain release is the caller's job (the
   * release claim `cancel_work` submits); an already-stamped `cancelledAt` is
   * kept, so the recorded time is when the user asked, not when the chain
   * caught up.
   */
  async cancel(
    roomId: string,
    threadId: string,
    reason?: string,
  ): Promise<CommerceEngagement | null> {
    const current = await this.get(roomId, threadId);
    if (!current) return null;
    const updated: CommerceEngagement = {
      ...current,
      status: 'closed',
      cancelledAt: current.cancelledAt ?? this.clock().toISOString(),
      ...cancelReasonPatch(current, reason),
    };
    await this.write(roomId, threadId, updated);
    return updated;
  }

  private async write(
    roomId: string,
    threadId: string,
    engagement: CommerceEngagement,
  ): Promise<void> {
    await this.stateStore().setState<CommerceEngagement>({
      roomId,
      stateKey: engagementStateKey(threadId),
      data: engagement,
    });
    this.cache.set(this.cacheKey(roomId, threadId), engagement);

    if (engagement.status !== 'active') {
      await this.releaseActiveIndex(roomId, threadId);
    }
  }

  /**
   * Drop the room's active-thread pointer once this thread's engagement ends.
   * Best-effort on purpose: the engagement itself is already persisted, and a
   * pointer left behind resolves to a non-active engagement on the next read,
   * so a failure here must not report an applied transition as failed.
   */
  private async releaseActiveIndex(
    roomId: string,
    threadId: string,
  ): Promise<void> {
    if ((await this.readActiveIndex(roomId)) !== threadId) return;
    try {
      await this.writeActiveIndex(roomId, null);
    } catch (error) {
      this.logger?.warn(
        `[oracle-payments] could not clear the active-engagement index for ${roomId}: ${errorMessage(error)}`,
      );
    }
  }

  private async readActiveIndex(roomId: string): Promise<string | null> {
    const cached = this.activeIndexCache.get(roomId);
    if (cached !== undefined) return cached;

    let raw: unknown;
    try {
      raw = await this.stateStore().getState(
        roomId,
        ACTIVE_ENGAGEMENT_INDEX_STATE_KEY,
      );
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
        this.activeIndexCache.set(roomId, null);
        return null;
      }
      // Transient read failure: report "none" but do NOT cache it — the chain
      // still refuses a second reservation, so nothing is lost by retrying.
      this.logger?.warn(
        `[oracle-payments] active-engagement index read failed for ${roomId}: ${errorMessage(error)}`,
      );
      return null;
    }

    const parsed = ActiveIndexSchema.safeParse(raw);
    const threadId = parsed.success ? parsed.data.threadId : null;
    this.activeIndexCache.set(roomId, threadId);
    return threadId;
  }

  private async writeActiveIndex(
    roomId: string,
    threadId: string | null,
  ): Promise<void> {
    // An empty payload is the Matrix "delete" — `readActiveIndex` parses it as
    // no pointer.
    await this.stateStore().setState<{ threadId?: string }>({
      roomId,
      stateKey: ACTIVE_ENGAGEMENT_INDEX_STATE_KEY,
      data: threadId === null ? {} : { threadId },
    });
    this.activeIndexCache.set(roomId, threadId);
  }

  private cacheKey(roomId: string, threadId: string): string {
    return `${roomId}|${threadId}`;
  }

  /** The thread half of a cache key, or `undefined` when it is another room's. */
  private threadIdFromCacheKey(
    key: string,
    roomId: string,
  ): string | undefined {
    const prefix = `${roomId}|`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
  }
}

/**
 * The `cancelReason` patch for a cancellation write. A later call that carries
 * no reason (a retried release, the close after one) must not erase the one the
 * user actually gave.
 */
function cancelReasonPatch(
  current: CommerceEngagement,
  reason?: string,
): { cancelReason?: string } {
  const next =
    reason !== undefined && reason.length > 0 ? reason : current.cancelReason;
  return next !== undefined ? { cancelReason: next } : {};
}
