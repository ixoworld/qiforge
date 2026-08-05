import { describe, expect, it, vi } from 'vitest';
import type { SubmitClaimResult } from './claim-lane.js';
import {
  COLLECTION_ID,
  makeEngagementService,
  makeEngagementStore,
  ROOM_ID,
  THREAD_ID,
} from './__test-fixtures__/oracle-payments-fixtures.js';
import type { GrantedEngagementStart } from './types.js';
import { expiryFrom, WorkIntentService } from './work-intent.service.js';

/** Seven days, the duration the contract's AuthZ snapshot reports. */
const SEVEN_DAYS_NS = '604800000000000';
const NOW = '2026-07-22T12:00:00.000Z';

const START: GrantedEngagementStart = {
  serviceId: 'tax-report',
  serviceName: 'Tax report',
  priceUsd: 20,
  denom: 'upay',
  collectionId: COLLECTION_ID,
  adminAddress: 'ixo1admin',
  intentDurationNs: SEVEN_DAYS_NS,
};

function makeService(options: {
  result?: SubmitClaimResult;
  throws?: Error;
  /** Fails the durable engagement write, as a Matrix outage would. */
  setState?: (payload: {
    roomId: string;
    stateKey: string;
    data: unknown;
  }) => Promise<void>;
  error?: ReturnType<typeof vi.fn>;
}) {
  const store = makeEngagementStore();
  const engagement = makeEngagementService(NOW, undefined, {
    getState: store.getState,
    setState: async (payload) => {
      await options.setState?.(payload);
      await store.setState(payload);
    },
  });
  const sendIntent = vi.fn(async (): Promise<SubmitClaimResult> => {
    if (options.throws) throw options.throws;
    return options.result ?? { code: 0, transactionHash: 'INTENT-TX-1' };
  });
  const service = new WorkIntentService({
    engagement,
    chain: { sendIntent },
    clock: () => new Date(NOW),
    sleep: async () => {},
    logger: {
      log: vi.fn(),
      warn: vi.fn(),
      error: options.error ?? vi.fn(),
      debug: vi.fn(),
    },
  });
  return { service, engagement, sendIntent };
}

describe('WorkIntentService.startEngagement', () => {
  it('reserves the service price before the engagement is written', async () => {
    const { service, engagement, sendIntent } = makeService({});

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    expect(sendIntent).toHaveBeenCalledWith({
      collectionId: COLLECTION_ID,
      // Same conversion the claim uses at delivery — escrow and claim agree.
      amount: [{ denom: 'upay', amount: '20000000' }],
    });
    expect(result).toEqual({
      ok: true,
      engagement: {
        status: 'active',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        priceUsd: 20,
        // The granted denom, stamped so the release lane can price its claim
        // without a record lookup (uPay spec §5 R1).
        denom: 'upay',
        collectionId: COLLECTION_ID,
        adminAddress: 'ixo1admin',
        startedAt: NOW,
        intent: {
          txHash: 'INTENT-TX-1',
          submittedAt: NOW,
          expiresAt: '2026-07-29T12:00:00.000Z',
        },
      },
    });
    // Persisted, not just returned.
    expect(await engagement.getActive(ROOM_ID, THREAD_ID)).toMatchObject({
      intent: { txHash: 'INTENT-TX-1' },
    });
  });

  it('reserves in whatever denom the grant names — nothing is network-guessed', async () => {
    // R1: a contract granted in another denom keeps settling in it, which is
    // what lets old contracts straddle the uPay flip without a flag day.
    const { service, sendIntent } = makeService({});

    await service.startEngagement(ROOM_ID, THREAD_ID, {
      ...START,
      denom: 'uusdc',
    });

    expect(sendIntent.mock.calls[0]![0].amount[0]!.denom).toBe('uusdc');
  });

  it('refuses a start that carries no granted denom — nothing is reserved', async () => {
    // Fail closed: reserving in a guessed denom would lock escrow the grant
    // never covers. Only the gate mints starts, so this names a wiring fault.
    const { service, engagement, sendIntent } = makeService({});
    const { denom: _denom, ...ungranted } = START;

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, ungranted);

    expect(result).toEqual({
      ok: false,
      reason: 'intent_failed',
      detail: expect.stringContaining('no granted payment denom'),
    });
    expect(sendIntent).not.toHaveBeenCalled();
    expect(await engagement.get(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it("starts no engagement when the reservation tx is rejected, and carries the chain's reason", async () => {
    const { service, engagement } = makeService({
      result: { code: 5, transactionHash: '', rawLog: 'insufficient funds' },
    });

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    // The rawLog is the only thing that can explain this to the user, so it
    // travels with the refusal instead of ending its life in a log line.
    expect(result).toEqual({
      ok: false,
      reason: 'intent_failed',
      detail: expect.stringContaining('insufficient funds'),
    });
    expect(result.ok === false && result.detail).toContain('code 5');
    expect(await engagement.get(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('starts no engagement when the reservation throws, and carries the thrown message', async () => {
    const { service, engagement } = makeService({
      throws: new Error('rpc down'),
    });

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    expect(result).toEqual({
      ok: false,
      reason: 'intent_failed',
      detail: expect.stringContaining('rpc down'),
    });
    expect(await engagement.get(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('leaves the deadline unset when the contract reports no usable duration', async () => {
    const { service } = makeService({});
    const noDuration: GrantedEngagementStart = {
      serviceId: START.serviceId,
      serviceName: START.serviceName,
      priceUsd: START.priceUsd,
      denom: START.denom,
      collectionId: START.collectionId,
      adminAddress: START.adminAddress,
    };

    const result = await service.startEngagement(
      ROOM_ID,
      THREAD_ID,
      noDuration,
    );

    expect(result.ok && result.engagement.intent).toEqual({
      txHash: 'INTENT-TX-1',
      submittedAt: NOW,
    });
  });

  it('retries a failed engagement write before giving up on the turn', async () => {
    // The engagement record IS the persisted "this user is in work mode"
    // state: lose it and the next message re-classifies straight back to
    // support while the escrow stays locked.
    let attempts = 0;
    const { service, engagement } = makeService({
      setState: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('matrix 502');
      },
    });

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    expect(result.ok).toBe(true);
    expect(await engagement.get(ROOM_ID, THREAD_ID)).toMatchObject({
      status: 'active',
    });
  });

  it('reports a failed start loudly when the engagement cannot be persisted', async () => {
    const error = vi.fn();
    const { service } = makeService({
      setState: async () => {
        throw new Error('matrix down');
      },
      error,
    });

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    // Never "ok" — the turn must not carry on as work with no record of it.
    // The detail says the payment IS reserved, which is what stops the agent
    // telling the user to simply try again.
    expect(result).toEqual({
      ok: false,
      reason: 'intent_failed',
      detail: expect.stringContaining('INTENT-TX-1'),
    });
    expect(result.ok === false && result.detail).toContain('matrix down');
    // And the escrow that IS locked is named, so an operator can reconcile it.
    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain('INTENT-TX-1');
    expect(logged).toContain(COLLECTION_ID);
    expect(logged).toContain('could not be persisted');
  });

  it('never persists the router-only intentDurationNs onto the engagement', async () => {
    const { service } = makeService({});

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    expect(result.ok && result.engagement).not.toHaveProperty(
      'intentDurationNs',
    );
  });
});

describe('expiryFrom', () => {
  it('converts a nanosecond duration into an ISO deadline', () => {
    expect(expiryFrom(new Date(NOW), SEVEN_DAYS_NS)).toBe(
      '2026-07-29T12:00:00.000Z',
    );
    expect(expiryFrom(new Date(NOW), 60 * 1_000_000_000)).toBe(
      '2026-07-22T12:01:00.000Z',
    );
  });

  it('is undefined for a missing, unparsable, or non-positive duration', () => {
    expect(expiryFrom(new Date(NOW), undefined)).toBeUndefined();
    expect(expiryFrom(new Date(NOW), 'not-a-number')).toBeUndefined();
    expect(expiryFrom(new Date(NOW), 0)).toBeUndefined();
    expect(expiryFrom(new Date(NOW), -5)).toBeUndefined();
  });
});
