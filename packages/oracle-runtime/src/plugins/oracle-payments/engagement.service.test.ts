import { MatrixError } from '@ixo/matrix';
import { describe, expect, it, vi } from 'vitest';
import type { CommerceEngagement } from '../../plugin-api/types.js';
import {
  ACTIVE_ENGAGEMENT_INDEX_STATE_KEY,
  engagementStateKey,
  EngagementService,
  PENDING_CLAIMS_STATE_KEY,
  type EngagementStateStore,
} from './engagement.service.js';

const ROOM_ID = '!room:home.server';
const THREAD_ID = 'evt-thread-root';
const OTHER_THREAD_ID = 'evt-other-thread-root';

const START_DATA = {
  serviceId: 'tax-report',
  serviceName: 'Tax report',
  priceUsd: 20,
  collectionId: '42',
  adminAddress: 'ixo1admin',
};

const NOW = new Date('2026-07-22T12:00:00.000Z');

function notFound(): MatrixError {
  return new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Not found' }, 404);
}

function makeService(initial?: Record<string, unknown>): {
  service: EngagementService;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  stored: Map<string, unknown>;
} {
  const stored = new Map<string, unknown>(Object.entries(initial ?? {}));
  const getState = vi.fn(async (roomId: string, stateKey: string) => {
    void roomId;
    if (!stored.has(stateKey)) throw notFound();
    return stored.get(stateKey);
  });
  const setState = vi.fn(
    async (payload: { roomId: string; stateKey: string; data: unknown }) => {
      stored.set(payload.stateKey, payload.data);
    },
  );
  const store: EngagementStateStore = {
    getState: async (roomId, stateKey) => getState(roomId, stateKey),
    setState: async (payload) => setState(payload),
  };
  const service = new EngagementService({
    stateStore: () => store,
    clock: () => NOW,
  });
  return { service, getState, setState, stored };
}

function activeEngagement(): CommerceEngagement {
  return {
    ...START_DATA,
    status: 'active',
    startedAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('EngagementService', () => {
  it('reads null when the thread has no engagement state (M_NOT_FOUND)', async () => {
    const { service } = makeService();

    expect(await service.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('reads null for an invalid/overwritten payload', async () => {
    const { service } = makeService({
      [engagementStateKey(THREAD_ID)]: {},
    });

    expect(await service.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('start writes an active engagement under work_engagement.<threadRoot>', async () => {
    const { service, setState, stored } = makeService();

    const engagement = await service.start(ROOM_ID, THREAD_ID, START_DATA);

    expect(engagement).toEqual({
      ...START_DATA,
      status: 'active',
      startedAt: NOW.toISOString(),
    });
    expect(setState).toHaveBeenCalledWith({
      roomId: ROOM_ID,
      stateKey: `work_engagement.${THREAD_ID}`,
      data: engagement,
    });
    expect(stored.get(engagementStateKey(THREAD_ID))).toEqual(engagement);
  });

  it('serves reads from the cache after a write — no state round-trip', async () => {
    const { service, getState } = makeService();

    await service.start(ROOM_ID, THREAD_ID, START_DATA);
    const active = await service.getActive(ROOM_ID, THREAD_ID);

    expect(active?.serviceId).toBe('tax-report');
    expect(getState).not.toHaveBeenCalled();
  });

  it('caches a state read so repeated gets hit Matrix once', async () => {
    const { service, getState } = makeService({
      [engagementStateKey(THREAD_ID)]: activeEngagement(),
    });

    await service.getActive(ROOM_ID, THREAD_ID);
    await service.getActive(ROOM_ID, THREAD_ID);

    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('transition updates the status and refreshes the cache', async () => {
    const { service, stored, getState } = makeService({
      [engagementStateKey(THREAD_ID)]: activeEngagement(),
    });

    const closed = await service.transition(ROOM_ID, THREAD_ID, 'closed');

    expect(closed?.status).toBe('closed');
    const persisted = stored.get(engagementStateKey(THREAD_ID));
    expect(persisted).toMatchObject({ status: 'closed' });
    // A closed engagement is no longer active — and read from cache.
    getState.mockClear();
    expect(await service.getActive(ROOM_ID, THREAD_ID)).toBeNull();
    expect(getState).not.toHaveBeenCalled();
  });

  it('cancel closes the engagement recording cancelledAt and the reason', async () => {
    const { service, stored } = makeService({
      [engagementStateKey(THREAD_ID)]: activeEngagement(),
    });

    const cancelled = await service.cancel(
      ROOM_ID,
      THREAD_ID,
      'found an accountant',
    );

    expect(cancelled).toMatchObject({
      status: 'closed',
      cancelledAt: NOW.toISOString(),
      cancelReason: 'found an accountant',
    });
    expect(stored.get(engagementStateKey(THREAD_ID))).toMatchObject({
      status: 'closed',
      cancelReason: 'found an accountant',
    });
    expect(await service.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('cancel without a reason records only the timestamp', async () => {
    const { service } = makeService({
      [engagementStateKey(THREAD_ID)]: activeEngagement(),
    });

    const cancelled = await service.cancel(ROOM_ID, THREAD_ID);

    expect(cancelled?.cancelledAt).toBe(NOW.toISOString());
    expect(cancelled?.cancelReason).toBeUndefined();
  });

  it('markCancelRequested stamps the cancellation but keeps the job blocking', async () => {
    const { service, stored } = makeService({
      [engagementStateKey(THREAD_ID)]: activeEngagement(),
    });

    const marked = await service.markCancelRequested(
      ROOM_ID,
      THREAD_ID,
      'found an accountant',
    );

    // The escrow is only freed by a claim, so the engagement has to keep
    // blocking new work until that claim lands.
    expect(marked).toMatchObject({
      status: 'active',
      cancelledAt: NOW.toISOString(),
      cancelReason: 'found an accountant',
    });
    expect(stored.get(engagementStateKey(THREAD_ID))).toMatchObject({
      status: 'active',
      cancelledAt: NOW.toISOString(),
    });
    expect(await service.getActive(ROOM_ID, THREAD_ID)).not.toBeNull();
  });

  it('cancel keeps the time and reason a pending cancellation already recorded', async () => {
    const { service } = makeService({
      [engagementStateKey(THREAD_ID)]: {
        ...activeEngagement(),
        cancelledAt: '2026-07-22T11:00:00.000Z',
        cancelReason: 'found an accountant',
      },
    });

    const cancelled = await service.cancel(ROOM_ID, THREAD_ID);

    expect(cancelled).toMatchObject({
      status: 'closed',
      cancelledAt: '2026-07-22T11:00:00.000Z',
      cancelReason: 'found an accountant',
    });
  });

  it('markCancelRequested returns null when the thread has no engagement', async () => {
    const { service, setState } = makeService();

    expect(await service.markCancelRequested(ROOM_ID, THREAD_ID)).toBeNull();
    expect(setState).not.toHaveBeenCalled();
  });

  it('cancel returns null when the thread has no engagement', async () => {
    const { service, setState } = makeService();

    expect(await service.cancel(ROOM_ID, THREAD_ID)).toBeNull();
    expect(setState).not.toHaveBeenCalled();
  });

  it('transition returns null when the thread has no engagement', async () => {
    const { service, setState } = makeService();

    expect(await service.transition(ROOM_ID, THREAD_ID, 'closed')).toBeNull();
    expect(setState).not.toHaveBeenCalled();
  });

  it('getActive filters non-active engagements', async () => {
    const { service } = makeService({
      [engagementStateKey(THREAD_ID)]: {
        ...activeEngagement(),
        status: 'delivered',
      },
    });

    expect(await service.getActive(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('does NOT cache a transient (non-404) read failure', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('matrix unreachable'))
      .mockResolvedValueOnce(activeEngagement());
    const store: EngagementStateStore = {
      getState: async (roomId, stateKey) => getState(roomId, stateKey),
      setState: vi.fn(),
    };
    const service = new EngagementService({
      stateStore: () => store,
      logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    });

    // Outage read: none — but not cached as none.
    expect(await service.getActive(ROOM_ID, THREAD_ID)).toBeNull();
    // Recovered read: the live engagement surfaces again.
    const recovered = await service.getActive(ROOM_ID, THREAD_ID);
    expect(recovered?.status).toBe('active');
  });

  it('start indexes the room’s active thread before writing the engagement', async () => {
    const { service, setState, stored } = makeService();

    await service.start(ROOM_ID, THREAD_ID, START_DATA);

    expect(stored.get(ACTIVE_ENGAGEMENT_INDEX_STATE_KEY)).toEqual({
      threadId: THREAD_ID,
    });
    const keys = setState.mock.calls.map(
      ([payload]: [{ stateKey: string }]) => payload.stateKey,
    );
    expect(keys).toEqual([
      ACTIVE_ENGAGEMENT_INDEX_STATE_KEY,
      engagementStateKey(THREAD_ID),
    ]);
  });

  it('findActive reports another thread’s live engagement, from the index alone', async () => {
    const { service } = makeService({
      [ACTIVE_ENGAGEMENT_INDEX_STATE_KEY]: { threadId: OTHER_THREAD_ID },
      [engagementStateKey(OTHER_THREAD_ID)]: activeEngagement(),
    });

    expect(await service.findActive(ROOM_ID)).toEqual({
      threadId: OTHER_THREAD_ID,
      engagement: activeEngagement(),
    });
  });

  it('findActive excludes the caller’s own thread', async () => {
    const { service } = makeService();
    await service.start(ROOM_ID, THREAD_ID, START_DATA);

    expect(await service.findActive(ROOM_ID, THREAD_ID)).toBeNull();
    expect(await service.findActive(ROOM_ID, OTHER_THREAD_ID)).toMatchObject({
      threadId: THREAD_ID,
    });
  });

  it('findActive is null once the indexed engagement is delivered, and the index is cleared', async () => {
    const { service, stored } = makeService();
    await service.start(ROOM_ID, THREAD_ID, START_DATA);
    await service.transition(ROOM_ID, THREAD_ID, 'delivered');

    expect(await service.findActive(ROOM_ID)).toBeNull();
    expect(stored.get(ACTIVE_ENGAGEMENT_INDEX_STATE_KEY)).toEqual({});
  });

  it('findActive is null once the indexed engagement is cancelled', async () => {
    const { service } = makeService();
    await service.start(ROOM_ID, THREAD_ID, START_DATA);
    await service.cancel(ROOM_ID, THREAD_ID, 'changed my mind');

    expect(await service.findActive(ROOM_ID)).toBeNull();
  });

  it('findActive reads null through a stale index pointing at no engagement', async () => {
    const { service } = makeService({
      [ACTIVE_ENGAGEMENT_INDEX_STATE_KEY]: { threadId: OTHER_THREAD_ID },
    });

    expect(await service.findActive(ROOM_ID)).toBeNull();
  });

  it('findActive is null with no index at all', async () => {
    const { service } = makeService();

    expect(await service.findActive(ROOM_ID)).toBeNull();
  });

  it('findActive answers repeat calls without re-reading the index', async () => {
    const { service, getState } = makeService({
      [ACTIVE_ENGAGEMENT_INDEX_STATE_KEY]: { threadId: OTHER_THREAD_ID },
      [engagementStateKey(OTHER_THREAD_ID)]: activeEngagement(),
    });

    await service.findActive(ROOM_ID);
    getState.mockClear();
    expect(await service.findActive(ROOM_ID)).not.toBeNull();
    expect(getState).not.toHaveBeenCalled();
  });

  it('start propagates write failures (the router fails open on them)', async () => {
    const store: EngagementStateStore = {
      getState: vi.fn(),
      setState: vi.fn().mockRejectedValue(new Error('state write failed')),
    };
    const service = new EngagementService({ stateStore: () => store });

    await expect(service.start(ROOM_ID, THREAD_ID, START_DATA)).rejects.toThrow(
      'state write failed',
    );
  });
});

describe('EngagementService — pending-claim index', () => {
  const INDEX_ROOM = '!oracle-account:home.server';

  async function withClaim(txHash?: string) {
    const { service, stored } = makeService();
    service.setClaimIndexRoom(INDEX_ROOM);
    await service.start(ROOM_ID, THREAD_ID, START_DATA);
    await service.recordClaim(ROOM_ID, THREAD_ID, {
      cid: 'bafyclaim',
      submittedAt: NOW.toISOString(),
      ...(txHash !== undefined && { txHash }),
    });
    return { service, stored };
  }

  it('indexes a claim only once the chain accepted it', async () => {
    const { service } = await withClaim();
    expect(await service.listPendingClaims()).toEqual([]);

    const onChain = await withClaim('TX1');
    expect(await onChain.service.listPendingClaims()).toEqual([
      { roomId: ROOM_ID, threadId: THREAD_ID },
    ]);
  });

  it('does not index the same thread twice', async () => {
    const { service } = await withClaim('TX1');
    await service.recordClaim(ROOM_ID, THREAD_ID, {
      cid: 'bafyclaim',
      txHash: 'TX1',
      submittedAt: NOW.toISOString(),
    });

    expect(await service.listPendingClaims()).toHaveLength(1);
  });

  it('untracks a thread and persists the shortened index', async () => {
    const { service, stored } = await withClaim('TX1');

    await service.untrackPendingClaim(ROOM_ID, THREAD_ID);

    expect(await service.listPendingClaims()).toEqual([]);
    expect(stored.get(PENDING_CLAIMS_STATE_KEY)).toEqual({ claims: [] });
  });

  it('stays inert until an index room is set', async () => {
    const { service, stored } = makeService();
    await service.start(ROOM_ID, THREAD_ID, START_DATA);
    await service.recordClaim(ROOM_ID, THREAD_ID, {
      cid: 'bafyclaim',
      txHash: 'TX1',
      submittedAt: NOW.toISOString(),
    });

    expect(await service.listPendingClaims()).toEqual([]);
    expect(stored.has(PENDING_CLAIMS_STATE_KEY)).toBe(false);
  });

  it('records the reported payment outcome on the engagement', async () => {
    const { service } = await withClaim('TX1');

    const updated = await service.recordPaymentOutcome(ROOM_ID, THREAD_ID, {
      status: 1,
      outcome: 'approved',
      reportedAt: NOW.toISOString(),
    });

    expect(updated?.paymentOutcome).toEqual({
      status: 1,
      outcome: 'approved',
      reportedAt: NOW.toISOString(),
    });
    expect(
      (await service.get(ROOM_ID, THREAD_ID))?.paymentOutcome,
    ).toBeDefined();
  });
});
