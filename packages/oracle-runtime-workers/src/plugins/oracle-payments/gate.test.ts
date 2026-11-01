import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkContract } from './gate';
import {
  BUYER,
  COLLECTION,
  ORACLE,
  OTHER,
  PAYMENTS_ENV,
  buyerCtx,
  devnetState,
  grant,
  stubDevnetFetch,
} from './test-fixtures';

const check = (serviceId = 'mrv-plan') =>
  checkContract({
    ctx: buyerCtx(),
    env: PAYMENTS_ENV,
    oracleAddress: ORACLE,
    senderDid: `did:ixo:${BUYER}`,
    serviceId,
  });

describe('checkContract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes a subscriber whose agreement lists the service, escrowing the agreed price', async () => {
    stubDevnetFetch(devnetState());
    expect(await check()).toMatchObject({
      ok: true,
      collectionId: COLLECTION,
      amount: { denom: 'upay', amount: '2000000000' },
      homeServer: 'https://devmx.ixo.earth',
    });
  });

  it('refuses when the deed belongs to someone else', async () => {
    stubDevnetFetch(devnetState({ linkedUsers: [OTHER] }));
    expect(await check()).toMatchObject({
      ok: false,
      reason: 'not_contracted',
    });
  });

  it('refuses a service the agreement does not cover', async () => {
    stubDevnetFetch(devnetState());
    expect(await check('tax-return')).toMatchObject({
      ok: false,
      reason: 'service_not_contracted',
    });
  });

  it('refuses when the grant caps a job below the agreed price', async () => {
    stubDevnetFetch(
      devnetState({
        grants: [grant({ max_amount: [{ denom: 'upay', amount: '1000000' }] })],
      }),
    );
    expect(await check()).toMatchObject({
      ok: false,
      reason: 'max_amount_too_low',
    });
  });

  it('refuses when the grant has no submissions left', async () => {
    stubDevnetFetch(devnetState({ grants: [grant({ agent_quota: '0' })] }));
    expect(await check()).toMatchObject({
      ok: false,
      reason: 'quota_exhausted',
    });
  });

  it('refuses a grant that has no intent window to reserve the escrow in', async () => {
    stubDevnetFetch(
      devnetState({ grants: [grant({ intent_duration_ns: '0s' })] }),
    );
    expect(await check()).toMatchObject({
      ok: false,
      reason: 'intents_not_allowed',
    });
  });

  it('treats a missing agreement as not contracted', async () => {
    stubDevnetFetch(devnetState({ agreement: null }));
    expect(await check()).toMatchObject({
      ok: false,
      reason: 'not_contracted',
    });
  });

  it('never throws: a lookup failure is contract_check_failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    expect(await check()).toMatchObject({
      ok: false,
      reason: 'contract_check_failed',
      detail: 'network down',
    });
  });
});
