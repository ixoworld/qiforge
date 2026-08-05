import { describe, expect, it } from 'vitest';
import type { CommerceRoutedService } from '../../modules/messages/commerce-router-port.js';
import {
  makeContractRecord,
  makeContractRecordService,
  makeEngagement,
  makeEngagementService,
  USER_DID,
} from './__test-fixtures__/oracle-payments-fixtures.js';
import { ContractGateService } from './contract-gate.service.js';
import type { EngagementService } from './engagement.service.js';
import type { ContractRecord } from './types.js';

const ROOM_ID = '!room:home.server';
const THREAD_ID = '$thread-root:home.server';
const OTHER_THREAD_ID = '$other-thread:home.server';
const ENGINE_URL = 'https://engine.example';

const TAX_SERVICE: CommerceRoutedService = {
  id: 'tax-report',
  name: 'Tax report',
  priceUsd: 20,
};

function makeGate(
  record: ContractRecord | null,
  opts: {
    now?: () => number;
    fetchImpl?: typeof fetch;
  } = {},
): {
  gate: ContractGateService;
  fetchCalls: string[];
  engagement: EngagementService;
} {
  const { service, fetchCalls } = makeContractRecordService(
    record,
    opts.fetchImpl,
  );
  const engagement = makeEngagementService();
  const gate = new ContractGateService({
    contractRecord: service,
    engagement,
    engineUrl: ENGINE_URL,
    clock: opts.now,
  });
  return { gate, fetchCalls, engagement };
}

function check(gate: ContractGateService, service = TAX_SERVICE) {
  return gate.check({
    roomId: ROOM_ID,
    threadId: THREAD_ID,
    senderDid: USER_DID,
    service,
  });
}

describe('ContractGateService', () => {
  it('fails not_contracted when the engine has no record', async () => {
    const { gate } = makeGate(null);

    expect(await check(gate)).toEqual({ ok: false, reason: 'not_contracted' });
  });

  it('fails not_contracted when the AuthZ snapshot says not granted', async () => {
    const record = makeContractRecord();
    record.authz.granted = false;
    const { gate } = makeGate(record);

    expect(await check(gate)).toEqual({
      ok: false,
      reason: 'not_contracted',
      detail: expect.stringContaining('not granted'),
    });
  });

  it('fails contract_check_failed — never not_contracted — when the lookup cannot be answered', async () => {
    // The engine is unreachable, so nothing is known about this contract.
    // Reporting `not_contracted` here would send a contracted user a contract
    // card and tell them something false about their own account.
    const { gate } = makeGate(null, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    expect(await check(gate)).toEqual({
      ok: false,
      reason: 'contract_check_failed',
      detail: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('does not cache a failed lookup — the next check re-asks the engine', async () => {
    let calls = 0;
    const { gate } = makeGate(null, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error('ECONNREFUSED');
      },
    });

    await check(gate);
    await check(gate);
    expect(calls).toBe(2);
  });

  it('fails quota_exhausted when no agent quota remains', async () => {
    const record = makeContractRecord();
    record.authz.agentQuotaRemaining = 0;
    const { gate } = makeGate(record);

    expect(await check(gate)).toEqual({
      ok: false,
      reason: 'quota_exhausted',
      detail: expect.stringContaining('no runs left'),
    });
  });

  it('fails max_amount_too_low when the grant cap is under the price', async () => {
    const record = makeContractRecord();
    // 20 USD = 20_000_000 micro-units of the granted denom; cap it below.
    record.authz.maxAmount = { amount: '19999999', denom: 'upay' };
    const { gate } = makeGate(record);

    // The numbers travel: "too low" alone is not something a user can act on.
    expect(await check(gate)).toEqual({
      ok: false,
      reason: 'max_amount_too_low',
      detail: expect.stringContaining('19999999 upay'),
    });
  });

  it('follows the granted denom — a uusdc grant prices the job in uusdc', async () => {
    // The handshake fix (uPay spec §5 R1): what used to refuse as a denom
    // mismatch now proves grant-following — the job is priced in whatever
    // denom the portal granted, so old contracts keep settling in their old
    // denom across the uPay flip.
    const record = makeContractRecord();
    record.authz.maxAmount = { amount: '999999999', denom: 'uusdc' };
    const { gate } = makeGate(record);

    expect(await check(gate)).toMatchObject({
      ok: true,
      start: { denom: 'uusdc' },
    });
  });

  it('fails closed when the grant names no denom at all', async () => {
    // No denom means no job can be priced — refusing beats reserving escrow
    // in a guessed denom the grant never covers.
    const record = makeContractRecord();
    record.authz.maxAmount = { amount: '999999999', denom: '' };
    const { gate } = makeGate(record);

    expect(await check(gate)).toEqual({
      ok: false,
      reason: 'not_contracted',
      detail: expect.stringContaining('names no payment denom'),
    });
  });

  it('fails service_not_contracted when the serviceId is outside the contract', async () => {
    const { gate } = makeGate(makeContractRecord());

    const result = await check(gate, {
      id: 'quick-estimate',
      name: 'Quick estimate',
      priceUsd: 5,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'service_not_contracted',
      detail: expect.stringContaining('tax-report'),
    });
  });

  it('passes with the engagement-start data from the record, carrying the intent window', async () => {
    const { gate } = makeGate(makeContractRecord());

    expect(await check(gate)).toEqual({
      ok: true,
      start: {
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        priceUsd: 20,
        // The granted denom off the record — the denom every coin this job
        // builds is priced in (uPay spec §5 R1).
        denom: 'upay',
        collectionId: '42',
        adminAddress: 'ixo1admincollectionadmin',
        // Stamped on the engagement so the replica that keeps the user in
        // work mode can be keyed by them.
        userDid: USER_DID,
        // Carried through so the start lane stamps the escrow deadline
        // without a second lookup.
        intentDurationNs: '604800000000000',
      },
    });
  });

  it('caches the record ~60s per (room, sender); invalidate busts it', async () => {
    let now = 0;
    const { gate, fetchCalls } = makeGate(makeContractRecord(), {
      now: () => now,
    });

    await check(gate);
    await check(gate);
    expect(fetchCalls).toHaveLength(1);

    // Past the gate TTL (60s) but inside the record service's own 300s TTL —
    // the second layer answers, so still one engine round-trip.
    now = 61_000;
    await check(gate);
    expect(fetchCalls).toHaveLength(1);

    // The contracted cache-buster drops BOTH layers → fresh engine query.
    gate.invalidate(USER_DID);
    // (only the gate layer here; the listener busts the record service too)
    await check(gate);
    expect(fetchCalls).toHaveLength(1);
  });

  it('refuses engagement_in_progress when another thread already has a live job', async () => {
    const { gate, engagement, fetchCalls } = makeGate(makeContractRecord());
    await engagement.start(ROOM_ID, OTHER_THREAD_ID, makeEngagement());

    expect(await check(gate)).toEqual({
      ok: false,
      reason: 'engagement_in_progress',
      inProgress: {
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        threadId: OTHER_THREAD_ID,
      },
    });
    // Short-circuits ahead of the contract lookup — nothing else is consulted.
    expect(fetchCalls).toHaveLength(0);
  });

  it('passes once the other thread’s engagement is delivered', async () => {
    const { gate, engagement } = makeGate(makeContractRecord());
    await engagement.start(ROOM_ID, OTHER_THREAD_ID, makeEngagement());
    await engagement.transition(ROOM_ID, OTHER_THREAD_ID, 'delivered');

    expect(await check(gate)).toMatchObject({ ok: true });
  });

  it('passes once the other thread’s engagement is closed', async () => {
    const { gate, engagement } = makeGate(makeContractRecord());
    await engagement.start(ROOM_ID, OTHER_THREAD_ID, makeEngagement());
    await engagement.cancel(ROOM_ID, OTHER_THREAD_ID, 'changed my mind');

    expect(await check(gate)).toMatchObject({ ok: true });
  });

  it('flags a cancelled engagement whose release never landed as still blocking', async () => {
    const { gate, engagement } = makeGate(makeContractRecord());
    await engagement.start(ROOM_ID, OTHER_THREAD_ID, makeEngagement());
    // `cancel_work` stamped the request but its release claim never reached
    // the chain: the reservation is genuinely still held.
    await engagement.markCancelRequested(ROOM_ID, OTHER_THREAD_ID, 'stop');

    expect(await check(gate)).toEqual({
      ok: false,
      reason: 'engagement_in_progress',
      inProgress: {
        serviceId: 'tax-report',
        serviceName: 'Tax report',
        threadId: OTHER_THREAD_ID,
        releaseFailed: true,
      },
    });
  });

  it('does not block on another thread’s job once its reservation lapsed', async () => {
    // The escrow auto-released, so the chain would take a new intent right
    // now — refusing here would leave the user wedged behind a dead job.
    const now = () => Date.parse('2026-07-22T12:00:00.000Z');
    const { gate, engagement } = makeGate(makeContractRecord(), { now });
    await engagement.start(
      ROOM_ID,
      OTHER_THREAD_ID,
      makeEngagement({
        intent: {
          txHash: 'INTENT-TX-1',
          submittedAt: '2026-07-22T10:00:00.000Z',
          expiresAt: '2026-07-22T11:00:00.000Z',
        },
      }),
    );

    expect(await check(gate)).toMatchObject({ ok: true });
    // And the dead job is gone, not just ignored.
    expect(await engagement.get(ROOM_ID, OTHER_THREAD_ID)).toMatchObject({
      status: 'closed',
    });
  });

  it('still blocks on another thread’s job while its reservation holds', async () => {
    const now = () => Date.parse('2026-07-22T12:00:00.000Z');
    const { gate, engagement } = makeGate(makeContractRecord(), { now });
    await engagement.start(
      ROOM_ID,
      OTHER_THREAD_ID,
      makeEngagement({
        intent: {
          txHash: 'INTENT-TX-1',
          submittedAt: '2026-07-22T10:00:00.000Z',
          expiresAt: '2026-07-22T23:00:00.000Z',
        },
      }),
    );

    expect(await check(gate)).toMatchObject({
      ok: false,
      reason: 'engagement_in_progress',
    });
  });

  it('does not treat the requesting thread’s own engagement as a conflict', async () => {
    const { gate, engagement } = makeGate(makeContractRecord());
    // The delivery lane re-checks the gate from inside the working thread.
    await engagement.start(ROOM_ID, THREAD_ID, makeEngagement());

    expect(await check(gate)).toMatchObject({ ok: true });
  });

  it('ignores an active engagement in a different room', async () => {
    const { gate, engagement } = makeGate(makeContractRecord());
    await engagement.start(
      '!other:home.server',
      OTHER_THREAD_ID,
      makeEngagement(),
    );

    expect(await check(gate)).toMatchObject({ ok: true });
  });

  it('caches a null record too — repeat misses do not re-query inside the TTL', async () => {
    const { gate, fetchCalls } = makeGate(null);

    await check(gate);
    await check(gate);

    expect(fetchCalls).toHaveLength(1);
  });
});
