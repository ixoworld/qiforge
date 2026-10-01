import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { ORACLE_COMPONENT_EVENT_TYPE } from '../../matrix/oracle-component-event.js';
import type { ClaimEvaluation } from './claim-lane.js';
import { ClaimStatusWatcher } from './claim-status.watcher.js';
import {
  PENDING_CLAIMS_STATE_KEY,
  type EngagementService,
  type EngagementStateStore,
} from './engagement.service.js';
import {
  ADMIN_ADDRESS,
  COLLECTION_ID,
  componentContent,
  makeEngagementService,
  makeEngagementStore,
  ROOM_ID,
  THREAD_ID,
  type PostedEvent,
} from './__test-fixtures__/oracle-payments-fixtures.js';

const INDEX_ROOM = '!oracle-account:ixo.world';
const CLAIM_ID = 'bafyclaim1';
const NOW = '2026-07-22T12:00:00.000Z';

/** `EvaluationStatus` values from the chain's `ixo/claims/v1beta1` codegen. */
const PENDING = 0;
const APPROVED = 1;
const REJECTED = 2;
const DISPUTED = 3;
const FLAGGED = 5;

/** One scripted chain read: a status, "not evaluated yet", or a failure. */
type ScriptedEvaluation = ClaimEvaluation | null | Error;

interface Harness {
  watcher: ClaimStatusWatcher;
  engagement: EngagementService;
  store: EngagementStateStore;
  posted: PostedEvent[];
  getEvaluation: ReturnType<typeof vi.fn>;
  /** A watcher over a fresh service on the same state — models a restart. */
  restart: () => ClaimStatusWatcher;
}

interface HarnessOptions {
  evaluations?: ScriptedEvaluation[];
  cancelled?: boolean;
  submittedAt?: string;
  portalUrl?: string;
  /** Skip recording the on-chain claim, leaving the engagement unindexed. */
  withClaim?: boolean;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const store = makeEngagementStore();
  const engagement = makeEngagementService(NOW, INDEX_ROOM, store);
  await engagement.start(ROOM_ID, THREAD_ID, {
    serviceId: 'tax-report',
    serviceName: 'Tax report',
    priceUsd: 20,
    collectionId: COLLECTION_ID,
    adminAddress: ADMIN_ADDRESS,
  });
  if (options.cancelled) {
    await engagement.markCancelRequested(ROOM_ID, THREAD_ID, 'changed my mind');
  }
  if (options.withClaim !== false) {
    await engagement.recordClaim(ROOM_ID, THREAD_ID, {
      cid: CLAIM_ID,
      txHash: 'TX1',
      submittedAt: options.submittedAt ?? NOW,
    });
  }

  const queue = [...(options.evaluations ?? [])];
  const getEvaluation = vi.fn(async () => {
    const next = queue.shift() ?? null;
    if (next instanceof Error) throw next;
    return next;
  });

  const posted: PostedEvent[] = [];
  const config = new ConfigService(
    options.portalUrl === undefined ? {} : { PORTAL_URL: options.portalUrl },
  );
  const build = (service: EngagementService): ClaimStatusWatcher =>
    new ClaimStatusWatcher(service, config, {
      chain: { getEvaluation },
      postEvent: async (roomId, eventType, content) => {
        posted.push({ roomId, eventType, content });
        return 'evt-1';
      },
      clock: () => new Date(NOW),
      sleep: async () => undefined,
    });

  return {
    watcher: build(engagement),
    engagement,
    store,
    posted,
    getEvaluation,
    restart: () => build(makeEngagementService(NOW, INDEX_ROOM, store)),
  };
}

describe('ClaimStatusWatcher — delivery lane', () => {
  it('posts an approved payment_update card and closes the engagement', async () => {
    const { watcher, engagement, posted } = await makeHarness({
      evaluations: [{ status: APPROVED }],
      portalUrl: 'https://portal.test/',
    });

    await watcher.pollSubmittedClaims();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.roomId).toBe(ROOM_ID);
    expect(posted[0]?.eventType).toBe(ORACLE_COMPONENT_EVENT_TYPE);
    const content = componentContent(posted[0]!);
    expect(content.component).toBe('payment_update');
    expect(content.props).toMatchObject({
      claimId: CLAIM_ID,
      outcome: 'approved',
      lane: 'delivery',
      service: {
        id: 'tax-report',
        name: 'Tax report',
        price: { amount: 20, currency: 'PAY' },
      },
      claimUrl: `https://portal.test/workspace/claims?claimId=${CLAIM_ID}`,
    });
    expect(content.body).toMatch(/Payment settled/);
    expect(content['m.relates_to']).toEqual({
      rel_type: 'm.thread',
      event_id: THREAD_ID,
    });

    const stored = await engagement.get(ROOM_ID, THREAD_ID);
    expect(stored?.status).toBe('closed');
    expect(stored?.paymentOutcome).toEqual({
      status: APPROVED,
      outcome: 'approved',
      reportedAt: NOW,
    });
    expect(await engagement.listPendingClaims()).toEqual([]);
  });

  it('says the work was judged not to meet the contract when a delivery is rejected', async () => {
    const { watcher, posted } = await makeHarness({
      evaluations: [{ status: REJECTED }],
    });

    await watcher.pollSubmittedClaims();

    const content = componentContent(posted[0]!);
    expect(content.props).toMatchObject({
      outcome: 'rejected',
      lane: 'delivery',
    });
    expect(content.body).toMatch(/did not meet the contract/);
    expect(content.body).toMatch(/went back to you/);
    // Neither PORTAL_URL nor NETWORK configured — the link falls back to devnet.
    expect(content.props.claimUrl).toBe(
      `https://dev.portal.qi.space/workspace/claims?claimId=${CLAIM_ID}`,
    );
  });

  it('reports a disputed claim as disputed', async () => {
    const { watcher, posted } = await makeHarness({
      evaluations: [{ status: DISPUTED }],
    });

    await watcher.pollSubmittedClaims();

    expect(componentContent(posted[0]!).props).toMatchObject({
      outcome: 'disputed',
    });
  });

  it('posts nothing while the claim is still unevaluated', async () => {
    const { watcher, engagement, posted } = await makeHarness({
      evaluations: [null, { status: PENDING }],
    });

    await watcher.pollSubmittedClaims();
    await watcher.pollSubmittedClaims();

    expect(posted).toEqual([]);
    expect((await engagement.get(ROOM_ID, THREAD_ID))?.status).toBe('active');
    expect(await engagement.listPendingClaims()).toEqual([
      { roomId: ROOM_ID, threadId: THREAD_ID },
    ]);
  });

  it('keeps polling a flagged claim and reports the later terminal outcome once', async () => {
    const { watcher, engagement, posted } = await makeHarness({
      evaluations: [
        { status: FLAGGED },
        { status: FLAGGED },
        { status: APPROVED },
      ],
    });

    await watcher.pollSubmittedClaims();
    expect(posted).toHaveLength(1);
    expect(componentContent(posted[0]!).props).toMatchObject({
      outcome: 'under_review',
    });
    expect(await engagement.listPendingClaims()).toHaveLength(1);

    await watcher.pollSubmittedClaims();
    expect(posted).toHaveLength(1);

    await watcher.pollSubmittedClaims();
    expect(posted).toHaveLength(2);
    expect(componentContent(posted[1]!).props).toMatchObject({
      outcome: 'approved',
    });
    expect(await engagement.listPendingClaims()).toEqual([]);
  });
});

describe('ClaimStatusWatcher — cancellation lane', () => {
  it('reports a rejected release claim as a completed refund, never as rejected work', async () => {
    const { watcher, engagement, posted } = await makeHarness({
      cancelled: true,
      evaluations: [{ status: REJECTED }],
    });

    await watcher.pollSubmittedClaims();

    const content = componentContent(posted[0]!);
    expect(content.props).toMatchObject({
      outcome: 'rejected',
      lane: 'cancellation',
    });
    expect(content.body).toMatch(/Refund complete/);
    expect(content.body).not.toMatch(/did not meet the contract/);
    expect((await engagement.get(ROOM_ID, THREAD_ID))?.status).toBe('closed');
  });

  it('does not crash on the impossible approved-after-cancellation case', async () => {
    const { watcher, posted } = await makeHarness({
      cancelled: true,
      evaluations: [{ status: APPROVED }],
    });

    await watcher.pollSubmittedClaims();

    const content = componentContent(posted[0]!);
    expect(content.props).toMatchObject({
      outcome: 'approved',
      lane: 'cancellation',
    });
    expect(content.body).toMatch(/Cancelled job settled/);
  });
});

describe('ClaimStatusWatcher — resilience', () => {
  it('reports a terminal outcome exactly once across two ticks', async () => {
    const { watcher, posted, getEvaluation } = await makeHarness({
      evaluations: [{ status: APPROVED }, { status: APPROVED }],
    });

    await watcher.pollSubmittedClaims();
    await watcher.pollSubmittedClaims();

    expect(posted).toHaveLength(1);
    // Untracked after the first tick — the second never reads the chain again.
    expect(getEvaluation).toHaveBeenCalledTimes(1);
  });

  it('does not re-post after a restart that lost every in-process cache', async () => {
    const { watcher, posted, restart } = await makeHarness({
      evaluations: [{ status: APPROVED }, { status: APPROVED }],
    });

    await watcher.pollSubmittedClaims();
    await restart().pollSubmittedClaims();

    expect(posted).toHaveLength(1);
  });

  it('re-posts nothing for a still-flagged claim after a restart', async () => {
    const { watcher, posted, restart } = await makeHarness({
      evaluations: [{ status: FLAGGED }, { status: FLAGGED }],
    });

    await watcher.pollSubmittedClaims();
    await restart().pollSubmittedClaims();

    expect(posted).toHaveLength(1);
  });

  it('survives a chain read failure and retries on the next tick', async () => {
    const failure = new Error('blocksync down');
    const { watcher, engagement, posted } = await makeHarness({
      evaluations: [failure, failure, { status: APPROVED }],
    });

    await expect(watcher.pollSubmittedClaims()).resolves.toBeUndefined();
    expect(posted).toEqual([]);
    expect(await engagement.listPendingClaims()).toHaveLength(1);

    await watcher.pollSubmittedClaims();
    expect(posted).toHaveLength(1);
  });

  it('drops an indexed thread that has no engagement behind it', async () => {
    const { watcher, engagement, store, posted, getEvaluation } =
      await makeHarness({ withClaim: false });
    await store.setState({
      roomId: INDEX_ROOM,
      stateKey: PENDING_CLAIMS_STATE_KEY,
      data: { claims: [{ roomId: ROOM_ID, threadId: '$ghost:ixo.world' }] },
    });

    await watcher.pollSubmittedClaims();

    expect(getEvaluation).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(await engagement.listPendingClaims()).toEqual([]);
  });

  it('stops polling a claim that has gone unevaluated past the watch window', async () => {
    const { watcher, engagement, getEvaluation } = await makeHarness({
      evaluations: [null],
      submittedAt: '2026-01-01T00:00:00.000Z',
    });

    await watcher.pollSubmittedClaims();

    expect(getEvaluation).not.toHaveBeenCalled();
    expect(await engagement.listPendingClaims()).toEqual([]);
  });

  it('does nothing when no claim has been indexed', async () => {
    const { watcher, getEvaluation } = await makeHarness({ withClaim: false });

    await watcher.pollSubmittedClaims();

    expect(getEvaluation).not.toHaveBeenCalled();
  });
});
