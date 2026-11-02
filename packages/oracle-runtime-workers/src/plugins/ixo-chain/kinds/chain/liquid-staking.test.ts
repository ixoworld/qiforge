import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import balanceUpay from './fixtures/balance-upay.json';
import balanceUzero from './fixtures/balance-uzero.json';
import {
  HTTP_500_FAILURE,
  MICHAEL,
  chainFetch,
  contextOf,
  pathsOf,
  refusal,
  reply,
  resetChainState,
  run,
  upayRoute,
} from './fixtures/context';
import params from './fixtures/liquidstake-params.json';
import pools from './fixtures/liquidstake-pools.json';
import statesPay from './fixtures/liquidstake-states-pay.json';
import statesZero from './fixtures/liquidstake-states-zero.json';
import uzeroMetadata from './fixtures/metadata-uzero.json';
import { LIQUIDSTAKE_TTL_MS, liquidStakingKind } from './liquid-staking';

const POOLS = '/ixo/liquidstake/v1beta1/pools?pagination.limit=10';
const PARAMS = '/ixo/liquidstake/v1beta1/module_params';
const states = (pool: string) =>
  `/ixo/liquidstake/v1beta1/pools/${pool}/states`;
const balance = (denom: string) =>
  `/cosmos/bank/v1beta1/balances/${MICHAEL}/by_denom?denom=${denom}`;

const routes = (overrides: Record<string, unknown> = {}) => ({
  [POOLS]: pools,
  [PARAMS]: params,
  [states('pay')]: statesPay,
  [states('zero')]: statesZero,
  [balance('upay')]: balanceUpay,
  [balance('uzero')]: balanceUzero,
  ...upayRoute,
  '/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=uzero':
    uzeroMetadata,
  ...overrides,
});

const coin = (
  symbol: string,
  denom: string,
  amount: string,
  amountBaseUnits: string,
) => ({ amount, symbol, denom, amountBaseUnits, verified: true });

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('liquid_staking', () => {
  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(liquidStakingKind, {}, ctx)).toBeNull();
    expect(refusal(liquidStakingKind, { pool: 'pay' }, ctx)).toMatch(
      /^Invalid args for kind "liquid_staking"/,
    );
  });

  it("shows what each pool's token is worth and the user's PAY in IXO (recorded mainnet answers)", async () => {
    const fetcher = chainFetch(routes());
    const result = await run(liquidStakingKind, {}, contextOf(fetcher));
    for (const path of [
      POOLS,
      PARAMS,
      states('pay'),
      states('zero'),
      balance('upay'),
      balance('uzero'),
    ])
      expect(pathsOf(fetcher)).toContain(path);
    expect(result).toEqual({
      ok: true,
      subject: 'user',
      data: {
        address: MICHAEL,
        module: {
          minStake: coin('IXO', 'uixo', '1', '1000000'),
          paused: false,
        },
        pools: [
          {
            id: 'pay',
            lst: { symbol: 'PAY', denom: 'upay' },
            paused: false,
            unstakeFee: '10%',
            // 10,313,590,143 uixo behind 10,000,000,000 upay; the chain's
            // own rates are truncated to 1.
            rate: '1.031359',
            chainStakeRate: '1',
            chainUnstakeRate: '1',
            totalStaked: coin('IXO', 'uixo', '10313.590143', '10313590143'),
            lstSupply: coin('PAY', 'upay', '10000', '10000000000'),
            yourBalance: coin('PAY', 'upay', '5.74', '5740000'),
            // 5,740,000 × 10,313,590,143 ÷ 10,000,000,000 = 5,920,000.74.
            valueInIxo: coin('IXO', 'uixo', '5.92', '5920000'),
            // Unstaking deducts the pool's 10% fee: 5,920,000 × 0.9.
            unstakeReceivesIxo: coin('IXO', 'uixo', '5.328', '5328000'),
          },
          {
            // No LST minted: no rate and no value.
            id: 'zero',
            lst: { symbol: 'ZERO', denom: 'uzero' },
            paused: false,
            unstakeFee: '0%',
            rate: null,
            chainStakeRate: '1',
            chainUnstakeRate: '0',
            totalStaked: coin('IXO', 'uixo', '0', '0'),
            lstSupply: coin('ZERO', 'uzero', '0', '0'),
            yourBalance: coin('ZERO', 'uzero', '0', '0'),
          },
        ],
      },
    });
  });

  it("values the holding by the keeper's unstake arithmetic, never by the truncated chain rate", async () => {
    const valued = (held: string, net: string, supply: string) => {
      resetChainState();
      return run(
        liquidStakingKind,
        {},
        contextOf(
          chainFetch(
            routes({
              [states('pay')]: {
                net_amount_state: {
                  ...statesPay.net_amount_state,
                  stkixo_total_supply: supply,
                  net_amount: net,
                },
              },
              [balance('upay')]: { balance: { denom: 'upay', amount: held } },
            }),
          ),
        ),
      );
    };
    // Rounded down to a whole uixo: 5,740,000 × 1.03135881825 = 5,919,999.6…
    expect(
      await valued('5740000', '10313588182.5', '10000000000'),
    ).toMatchObject({
      ok: true,
      data: {
        pools: [
          {
            rate: '1.031358',
            valueInIxo: coin('IXO', 'uixo', '5.919999', '5919999'),
          },
          { id: 'zero' },
        ],
      },
    });
    // The keeper's Quo rounds half to even at 18 places before truncating:
    // 1 × 1999999999999999999 ÷ 2e18 = 0.9999999999999999995 is 1 uixo.
    expect(
      await valued('1', '1999999999999999999', '2000000000000000000'),
    ).toMatchObject({
      ok: true,
      data: {
        pools: [
          {
            rate: '0.999999',
            valueInIxo: coin('IXO', 'uixo', '0.000001', '1'),
          },
          { id: 'zero' },
        ],
      },
    });
  });

  it("keeps the other pools when one pool's state cannot be read", async () => {
    const result = await run(
      liquidStakingKind,
      {},
      contextOf(chainFetch(routes({ [states('zero')]: reply(500) }))),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        pools: [
          { id: 'pay', rate: '1.031359', valueInIxo: { amount: '5.92' } },
          {
            id: 'zero',
            stateUnavailable: true,
            yourBalance: coin('ZERO', 'uzero', '0', '0'),
          },
        ],
      },
    });
    // Nothing is said of the unread pool's worth.
    expect(result).not.toMatchObject({
      data: { pools: [{}, { rate: expect.anything() }] },
    });
    expect(result).not.toMatchObject({
      data: { pools: [{}, { valueInIxo: expect.anything() }] },
    });
  });

  it('keeps pools, states and module params for 60 s; the balances are read every time', async () => {
    const fetcher = chainFetch(routes());
    const count = (path: string) =>
      pathsOf(fetcher).filter((seen) => seen === path).length;
    await run(liquidStakingKind, {}, contextOf(fetcher));
    await run(liquidStakingKind, {}, contextOf(fetcher));
    expect([POOLS, PARAMS, states('pay')].map(count)).toEqual([1, 1, 1]);
    expect(count(balance('upay'))).toBe(2);
    vi.setSystemTime(Date.now() + LIQUIDSTAKE_TTL_MS + 1);
    await run(liquidStakingKind, {}, contextOf(fetcher));
    expect([POOLS, PARAMS, states('pay')].map(count)).toEqual([2, 2, 2]);
  });

  it('answers a chain without pools with an empty list', async () => {
    const result = await run(
      liquidStakingKind,
      {},
      contextOf(
        chainFetch(
          routes({ [POOLS]: { pools: [], pagination: { next_key: null } } }),
        ),
      ),
    );
    expect(result.ok && result.data).toEqual({
      address: MICHAEL,
      module: { minStake: coin('IXO', 'uixo', '1', '1000000'), paused: false },
      pools: [],
    });
  });

  it('passes a failure of the pools, the parameters or a balance through and does not keep it', async () => {
    for (const broken of [POOLS, PARAMS, balance('upay')]) {
      resetChainState();
      expect(
        await run(
          liquidStakingKind,
          {},
          contextOf(chainFetch(routes({ [broken]: reply(500) }))),
        ),
      ).toEqual(HTTP_500_FAILURE);
    }
    resetChainState();
    await run(
      liquidStakingKind,
      {},
      contextOf(chainFetch(routes({ [POOLS]: reply(500) }))),
    );
    const fetcher = chainFetch(routes());
    expect(await run(liquidStakingKind, {}, contextOf(fetcher))).toMatchObject({
      ok: true,
    });
    expect(pathsOf(fetcher)).toContain(POOLS);
  });
});
