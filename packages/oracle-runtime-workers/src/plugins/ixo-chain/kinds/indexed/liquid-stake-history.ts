/**
 * `liquid_stake_history`: an account's liquid staking events (x/liquidstake
 * stake and unstake) as Blocksync indexed them.
 *
 * Index (ixo-blocksync main, `20260101000000000_v7-upgrade.sql`):
 * `LiquidStakeTx_delegator_idx` ("delegator"); ordered by the primary key
 * `id` (indexing order), newest first. `payload` is the event's attributes;
 * since chain v7 its amounts are coins (`{ denom, amount }`), before it
 * `"<amount><denom>"` strings: both are read.
 */
import { z } from 'zod';
import {
  COINS_NOTE,
  displayCoin,
  type ChainCoin,
  type DisplayCoin,
} from '../coins';
import { defineKind, type KindContext, type KindResult } from '../types';
import { accountArg, firstArg } from '../../queries';
import { text } from '../../summaries';
import {
  PAGE,
  accountFor,
  chainCoin,
  compact,
  connection,
  equalTo,
  idText,
  listResult,
  num,
  opt,
  str,
  unexpected,
} from './shared';
import { isRecord } from '../../summaries';

const args = z.strictObject({
  address: accountArg('Delegator'),
  first: firstArg,
});

const FIELDS = 'kind poolId payload transactionHash height timestamp';

const node = z.looseObject({
  kind: str,
  poolId: opt,
  payload: z.unknown().optional(),
  transactionHash: opt,
  height: num,
  timestamp: opt,
});

/** What each event kind means, in a few words. */
const MEANING: Record<string, string> = {
  stake: 'staked through the pool, receiving its liquid token',
  unstake: "returned the pool's liquid token to unstake",
  autocompound: 'the pool restaked its rewards',
  rebalance: 'the pool moved stake between validators',
  addValidator: 'a validator joined the pool',
};

/** The payload keys of each event's amounts and the names they get. */
const AMOUNTS: Record<string, Record<string, string>> = {
  stake: { liquid_amount: 'staked', stk_ixo_minted_amount: 'received' },
  unstake: {
    unstake_amount: 'returned',
    unbonding_amount: 'unbonding',
    unbonded_amount: 'unbonded',
  },
  autocompound: {
    total_amount: 'total',
    fee_amount: 'fee',
    redelegate_amount: 'restaked',
    weighted_rewards_amount: 'weightedRewards',
  },
};

const LEGACY_COIN = /^(\d{1,80})([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/;

/** A payload amount: a coin object, or the `"<amount><denom>"` string events carried before v7. */
function payloadCoin(value: unknown): ChainCoin | undefined {
  if (typeof value === 'string') {
    const match = LEGACY_COIN.exec(value);
    return match ? chainCoin({ denom: match[2], amount: match[1] }) : undefined;
  }
  return chainCoin(value);
}

/** The event's bank coins by what each is (`staked`, `received`…). */
async function coinsOf(
  ctx: KindContext,
  kind: string,
  payload: Record<string, unknown>,
): Promise<Record<string, DisplayCoin> | undefined> {
  const coins: Record<string, DisplayCoin> = {};
  for (const [key, name] of Object.entries(AMOUNTS[kind] ?? {})) {
    const coin = payloadCoin(payload[key]);
    const shown = coin ? await displayCoin(ctx, coin) : null;
    if (shown) coins[name] = shown;
  }
  return Object.keys(coins).length ? coins : undefined;
}

async function eventOf(ctx: KindContext, row: z.infer<typeof node>) {
  const payload = isRecord(row.payload) ? row.payload : {};
  return compact({
    kind: text(row.kind, 40),
    meaning: MEANING[row.kind],
    poolId: idText(row.poolId),
    coins: await coinsOf(ctx, row.kind, payload),
    completionTime:
      row.kind === 'unstake' ? idText(payload.completion_time) : undefined,
    txHash: idText(row.transactionHash),
    height:
      row.height === null || row.height === undefined
        ? undefined
        : idText(String(row.height)),
    time: idText(row.timestamp),
  });
}

export const liquidStakeHistory = defineKind({
  name: 'liquid_stake_history',
  summary:
    'Liquid staking history of an account (default: the user): stakes and unstakes per pool, newest first.',
  explain: [
    'Liquid staking stakes IXO through a pool that spreads it over validators and gives back the pool’s liquid token (e.g. PAY for the `pay` pool), which can be held or moved while the IXO stays staked.',
    'Each row’s bank coins are in `coins`, by what each is. A `stake` row: `coins.staked` (IXO in) and `coins.received` (liquid token out). An `unstake` row: `coins.returned` (liquid token handed back), `coins.unbonding` (IXO now unbonding, paid out at `completionTime`) and `coins.unbonded` (IXO paid at once). An `autocompound` row: `coins.total`, `coins.fee`, `coins.restaked`, `coins.weightedRewards`.',
    COINS_NOTE,
    'Each row also has poolId, txHash, height and time. Ask `liquid_staking` for the pools and the account’s current liquid token balance.',
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: { first: 5 },
  plan(input, ctx) {
    const delegator = accountFor(input.address, ctx.identity, 'address');
    if ('invalid' in delegator) return delegator;
    const n = ctx.first;
    return {
      source: 'blocksync',
      field: (alias) =>
        `${alias}: liquidStakeTxes(filter: ${equalTo('delegator', delegator.address)}, first: ${n}, orderBy: ID_DESC) { ${PAGE} nodes { ${FIELDS} } }`,
      async shape(raw): Promise<KindResult> {
        const parsed = connection(node).safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        return listResult(
          {
            items: await Promise.all(
              parsed.data.nodes.map((row) => eventOf(ctx, row)),
            ),
            more: parsed.data.pageInfo?.hasNextPage ? true : undefined,
          },
          n,
          delegator.subject,
        );
      },
    };
  },
});
