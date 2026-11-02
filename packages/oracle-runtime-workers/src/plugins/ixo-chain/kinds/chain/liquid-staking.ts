/**
 * `liquid_staking`: the x/liquidstake pools (each mints its own liquid
 * staking token, e.g. PAY), what one token is worth in IXO, and what the
 * account holds of each pool's token. Pools, pool states and the module's
 * parameters come from a 60 s per-isolate cache; the account's balance of
 * each token is read every time.
 *
 * The chain's own `unstake_rate` is `TruncateDec`'d to a whole number
 * (x/liquidstake `GetNetAmountStateForPool`, `StkIXOToNativeToken(1, …)`),
 * so it reads 1 while a PAY is worth more. The value here is the keeper's
 * unstake arithmetic on the account's whole holding (`LiquidUnstake`
 * before the fee): `held × net_amount ÷ stkixo_total_supply` in
 * `LegacyDec`, truncated to a whole base unit.
 */
import { z } from 'zod';
import { defineKind, type KindContext, type KindResult } from '../types';
import { displayCoin, ixo, wholeUnits } from '../coins';
import { clip } from '../../summaries';
import {
  DEC_ONE,
  ReadCache,
  accountFor,
  addressArg,
  coinSchema,
  decPercent,
  decQuo,
  failed,
  parseDec,
} from './shared';

/** Pools, their states and the module parameters are reused for 60 s. */
export const LIQUIDSTAKE_TTL_MS = 60_000;
/** Pools read (one page); governance creates them, mainnet has two. */
const POOL_PAGE = 10;
/** x/liquidstake pool ids: lower-case letters, digits and inner dashes. */
const POOL_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** The Cosmos SDK bank denom pattern. */
const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/;

const poolsResponse = z.object({
  pools: z.array(
    z.object({
      pool_id: z.string(),
      liquid_bond_denom: z.string(),
      paused: z.boolean().default(false),
      unstake_fee_rate: z.string().optional(),
    }),
  ),
  pagination: z.object({ next_key: z.string().nullish() }).nullish(),
});
const statesResponse = z.object({
  net_amount_state: z.object({
    stake_rate: z.string(),
    unstake_rate: z.string(),
    stkixo_total_supply: z.string(),
    net_amount: z.string(),
    total_liquid_tokens: z.string(),
  }),
});
const paramsResponse = z.object({
  module_params: z.object({
    min_liquid_stake_amount: z.string(),
    module_paused: z.boolean(),
  }),
});
const balanceResponse = z.object({ balance: coinSchema.nullish() });

const pools = new ReadCache<z.infer<typeof poolsResponse>>(
  LIQUIDSTAKE_TTL_MS,
  8,
);
const states = new ReadCache<z.infer<typeof statesResponse>>(
  LIQUIDSTAKE_TTL_MS,
  64,
);
const params = new ReadCache<z.infer<typeof paramsResponse>>(
  LIQUIDSTAKE_TTL_MS,
  8,
);

const readPools = (ctx: KindContext) =>
  pools.get(ctx, 'pools', () =>
    ctx.rest(
      `/ixo/liquidstake/v1beta1/pools?pagination.limit=${POOL_PAGE}`,
      poolsResponse,
      { label: 'liquidstake pools' },
    ),
  );
const readParams = (ctx: KindContext) =>
  params.get(ctx, 'module_params', () =>
    ctx.rest('/ixo/liquidstake/v1beta1/module_params', paramsResponse, {
      label: 'liquidstake params',
    }),
  );
const readState = (ctx: KindContext, poolId: string) =>
  states.get(ctx, poolId, () =>
    ctx.rest(
      `/ixo/liquidstake/v1beta1/pools/${poolId}/states`,
      statesResponse,
      {
        label: 'liquidstake pool state',
      },
    ),
  );

/** A LegacyDec without its trailing zeros: `"1.000000000000000000"` → `"1"`. */
const rateText = (rate: string) =>
  clip(rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate, 30);

/** Decimal places of `rate`. */
const RATE_PLACES = 6;

/**
 * The IXO behind one token: `net ÷ supply` (net in 10⁻¹⁸ units) rounded
 * down to {@link RATE_PLACES} places, e.g. `"1.031359"`.
 */
function rateOf(net: bigint, supply: bigint): string {
  const scale = 10n ** BigInt(RATE_PLACES);
  const scaled = (net * scale) / (supply * DEC_ONE);
  return `${scaled / scale}.${(scaled % scale).toString().padStart(RATE_PLACES, '0')}`;
}

/**
 * `StkIXOToNativeToken(held, supply, net)` as the keeper computes it:
 * `held` as a decimal `MulTruncate` `net`, `Quo` `supply`, `TruncateDec`.
 * Whole base units.
 */
function nativeOf(held: bigint, net: bigint, supply: bigint): string {
  return (decQuo(held * net, supply * DEC_ONE) / DEC_ONE).toString();
}

/**
 * `DeductFeeRate(native, feeRate)` as the keeper computes it on unstake:
 * `native MulTruncate (1 − feeRate)`, `TruncateDec`, then `TruncateInt`.
 * Whole base units; null when the rate is not a decimal in [0, 1].
 */
function afterUnstakeFee(native: string, feeRate: string): string | null {
  const fee = parseDec(feeRate);
  if (fee === null || fee > DEC_ONE) return null;
  return ((BigInt(native) * (DEC_ONE - fee)) / DEC_ONE).toString();
}

/**
 * The pool's state as shown: what a token is worth, and the account's
 * holding in IXO before and after the pool's unstake fee.
 */
function stateView(
  net: z.infer<typeof statesResponse>['net_amount_state'],
  held: string,
  feeRate: string | undefined,
): Record<string, unknown> {
  const amount = parseDec(net.net_amount);
  const supply = wholeUnits(net.stkixo_total_supply);
  const totalStaked = wholeUnits(net.total_liquid_tokens);
  const backed = amount !== null && supply !== null && supply !== '0';
  const native = backed ? nativeOf(BigInt(held), amount, BigInt(supply)) : null;
  const received =
    native !== null && feeRate !== undefined
      ? afterUnstakeFee(native, feeRate)
      : native;
  return {
    rate: backed ? rateOf(amount, BigInt(supply)) : null,
    chainStakeRate: rateText(net.stake_rate),
    chainUnstakeRate: rateText(net.unstake_rate),
    ...(totalStaked ? { totalStaked: ixo(totalStaked) } : {}),
    ...(native !== null ? { valueInIxo: ixo(native) } : {}),
    ...(received !== null ? { unstakeReceivesIxo: ixo(received) } : {}),
  };
}

/**
 * One pool as shown, with the account's holding of its token; a pool
 * whose state could not be read is shown with `stateUnavailable` (its
 * rate, totals and value unknown). The account's balance failing fails
 * the pool.
 */
async function poolView(
  ctx: KindContext,
  address: string,
  pool: z.infer<typeof poolsResponse>['pools'][number],
): Promise<KindResult> {
  const denom = pool.liquid_bond_denom;
  const [state, balance] = await Promise.all([
    readState(ctx, pool.pool_id),
    ctx.rest(
      `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`,
      balanceResponse,
      { label: 'liquid staking token balance' },
    ),
  ]);
  if (!balance.ok) return failed(balance.failure);
  const held = wholeUnits(balance.value.balance?.amount ?? '0') ?? '0';
  const [yourBalance, lstSupply] = await Promise.all([
    displayCoin(ctx, { denom, amount: held }),
    state.ok
      ? displayCoin(ctx, {
          denom,
          amount: state.value.net_amount_state.stkixo_total_supply,
        })
      : null,
  ]);
  const fee = pool.unstake_fee_rate ? decPercent(pool.unstake_fee_rate) : null;
  return {
    ok: true,
    data: {
      id: pool.pool_id,
      lst: { symbol: yourBalance?.symbol ?? denom, denom },
      paused: pool.paused,
      ...(fee ? { unstakeFee: fee } : {}),
      ...(state.ok
        ? stateView(state.value.net_amount_state, held, pool.unstake_fee_rate)
        : { stateUnavailable: true }),
      ...(lstSupply ? { lstSupply } : {}),
      yourBalance,
    },
  };
}

const args = z.strictObject({ address: addressArg });

export const liquidStakingKind = defineKind({
  name: 'liquid_staking',
  summary:
    'Liquid staking pools (e.g. PAY): rates, totals and how much of each token an account holds.',
  explain: [
    'Liquid staking (x/liquidstake) is staking too: IXO staked into a pool is delegated to its validators and earns rewards, and the pool mints its own liquid staking token (LST, e.g. PAY from the "pay" pool) one for one. The LST can be held or sent while the IXO stays staked; unstaking burns LST and returns its IXO, minus `unstakeFee`, after the unbonding period.',
    "Per pool: `id`, `lst` (symbol and denom), `paused` (no staking or unstaking now), `rate` = IXO behind one LST now (pool IXO ÷ LST supply, 6 decimals; it grows as rewards accrue; null when the pool has no LST), `totalStaked` (IXO delegated by the pool), `lstSupply`, and for the account `yourBalance` (its LST) and `valueInIxo` (the IXO behind that LST now) and `unstakeReceivesIxo` (what unstaking it now would return after `unstakeFee`, as the chain computes it). `chainStakeRate` / `chainUnstakeRate` are the chain's own figures, truncated by the chain to whole numbers: use `rate`, never them, for what a token is worth. `stateUnavailable` = that pool's state could not be read (no rate or value).",
    '`module.minStake` is the smallest stake accepted, `module.paused` pauses every pool. Amounts are display units with `amountBaseUnits`.',
  ].join('\n'),
  source: 'chain',
  list: false,
  args,
  example: {},
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const [poolList, moduleParams] = await Promise.all([
          readPools(ctx),
          readParams(ctx),
        ]);
        if (!poolList.ok) return failed(poolList.failure);
        if (!moduleParams.ok) return failed(moduleParams.failure);
        const readable = poolList.value.pools.filter(
          (pool) =>
            POOL_ID.test(pool.pool_id) && DENOM.test(pool.liquid_bond_denom),
        );
        const answers = await Promise.all(
          readable.map((pool) => poolView(ctx, account.address, pool)),
        );
        const views = [];
        for (const answer of answers) {
          if (!answer.ok) return answer;
          views.push(answer.data);
        }
        const { min_liquid_stake_amount: min, module_paused: paused } =
          moduleParams.value.module_params;
        const minStake = wholeUnits(min);
        const skipped = poolList.value.pools.length - readable.length;
        return {
          ok: true,
          subject: account.subject,
          data: {
            address: account.address,
            module: {
              ...(minStake ? { minStake: ixo(minStake) } : {}),
              paused,
            },
            pools: views,
            ...(skipped ? { unreadablePools: skipped } : {}),
            ...(poolList.value.pagination?.next_key ? { morePools: true } : {}),
          },
        };
      },
    };
  },
});
