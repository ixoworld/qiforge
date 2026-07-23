import { describe, expect, it, vi } from 'vitest';
import type { CommerceEngagementStart } from '../../modules/messages/commerce-router-port.js';
import type { SubmitClaimResult } from './claim-lane.js';
import {
  COLLECTION_ID,
  makeEngagementService,
  ROOM_ID,
  THREAD_ID,
} from './__test-fixtures__/oracle-payments-fixtures.js';
import { expiryFrom, WorkIntentService } from './work-intent.service.js';

/** Seven days, the duration the contract's AuthZ snapshot reports. */
const SEVEN_DAYS_NS = '604800000000000';
const NOW = '2026-07-22T12:00:00.000Z';

const START: CommerceEngagementStart = {
  serviceId: 'tax-report',
  serviceName: 'Tax report',
  priceUsd: 20,
  collectionId: COLLECTION_ID,
  adminAddress: 'ixo1admin',
  intentDurationNs: SEVEN_DAYS_NS,
};

function makeService(options: {
  result?: SubmitClaimResult;
  throws?: Error;
  network?: string;
}) {
  const engagement = makeEngagementService(NOW);
  const sendIntent = vi.fn(async (): Promise<SubmitClaimResult> => {
    if (options.throws) throw options.throws;
    return options.result ?? { code: 0, transactionHash: 'INTENT-TX-1' };
  });
  const service = new WorkIntentService({
    engagement,
    network: options.network ?? 'devnet',
    chain: { sendIntent },
    clock: () => new Date(NOW),
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
      amount: [{ denom: 'uixo', amount: '20000000' }],
    });
    expect(result).toEqual({
      ok: true,
      engagement: {
        status: 'active',
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        priceUsd: 20,
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

  it('prices the reservation in the mainnet denom on mainnet', async () => {
    const { service, sendIntent } = makeService({ network: 'mainnet' });

    await service.startEngagement(ROOM_ID, THREAD_ID, START);

    expect(sendIntent.mock.calls[0]![0].amount[0]!.denom).toMatch(/^ibc\//);
  });

  it('starts no engagement when the reservation tx is rejected', async () => {
    const { service, engagement } = makeService({
      result: { code: 5, transactionHash: '', rawLog: 'insufficient funds' },
    });

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    expect(result).toEqual({ ok: false, reason: 'intent_failed' });
    expect(await engagement.get(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('starts no engagement when the reservation throws', async () => {
    const { service, engagement } = makeService({
      throws: new Error('rpc down'),
    });

    const result = await service.startEngagement(ROOM_ID, THREAD_ID, START);

    expect(result).toEqual({ ok: false, reason: 'intent_failed' });
    expect(await engagement.get(ROOM_ID, THREAD_ID)).toBeNull();
  });

  it('leaves the deadline unset when the contract reports no usable duration', async () => {
    const { service } = makeService({});
    const noDuration: CommerceEngagementStart = {
      serviceId: START.serviceId,
      serviceName: START.serviceName,
      priceUsd: START.priceUsd,
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
