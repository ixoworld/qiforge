/**
 * `staking`: an account's delegations, unbonding entries and pending
 * rewards, with each validator's moniker. Three reads at once; monikers
 * come from a per-isolate cache. A failed rewards read leaves the
 * delegations standing, marked `rewardsUnavailable`.
 */
import { z } from 'zod';
import { defineKind, type KindContext, type KindResult } from '../types';
import { displayCoin, ixo, wholeUnits } from '../coins';
import { clip } from '../../summaries';
import {
  ReadCache,
  accountFor,
  addressArg,
  coinSchema,
  coinsOr,
  coinsSchema,
  failed,
} from './shared';

/** A validator operator address. */
const VALOPER = /^ixovaloper1[0-9a-z]{38,58}$/;
/** Delegations and unbonding validators read per account (one page each). */
const STAKING_PAGE = 50;
/** Validators whose moniker is looked up per request; the others are shown by address. */
const MONIKER_LOOKUPS = 20;
/** A moniker (or a validator's absence) is reused for 10 min. */
export const MONIKER_TTL_MS = 600_000;
const MONIKER_CACHE_LIMIT = 256;

const monikers = new ReadCache<string | null>(
  MONIKER_TTL_MS,
  MONIKER_CACHE_LIMIT,
);

const validatorResponse = z.object({
  validator: z.object({ description: z.object({ moniker: z.string() }) }),
});

/** A validator's moniker; null when it has none or the chain has no such validator. */
function monikerOf(ctx: KindContext, valoper: string) {
  return monikers.get(ctx, valoper, async () => {
    const read = await ctx.rest(
      `/cosmos/staking/v1beta1/validators/${valoper}`,
      validatorResponse,
      { label: 'validator', notFoundOn404: true, maxBytes: 64 * 1024 },
    );
    if (read.ok)
      return {
        ok: true,
        value: clip(read.value.validator.description.moniker, 60) || null,
      };
    return read.failure.reason === 'not_found'
      ? { ok: true, value: null }
      : read;
  });
}

const pagination = z.object({ next_key: z.string().nullish() }).nullish();
const delegationsResponse = z.object({
  delegation_responses: z.array(
    z.object({
      delegation: z.object({ validator_address: z.string() }),
      balance: coinSchema,
    }),
  ),
  pagination,
});
const unbondingResponse = z.object({
  unbonding_responses: z.array(
    z.object({
      validator_address: z.string(),
      entries: z.array(
        z.object({ completion_time: z.string(), balance: z.string() }),
      ),
    }),
  ),
  pagination,
});
const rewardsResponse = z.object({
  rewards: z
    .array(z.object({ validator_address: z.string(), reward: coinsSchema }))
    .default([]),
  total: coinsSchema.default([]),
});

/** The sum of whole base units. */
const sum = (amounts: readonly string[]) =>
  amounts.reduce((total, units) => total + BigInt(units), 0n).toString();

const args = z.strictObject({ address: addressArg });

export const stakingKind = defineKind({
  name: 'staking',
  summary:
    "An account's staked IXO: delegations, unbonding, rewards waiting to be claimed.",
  explain: [
    'Staking = delegating IXO to validators, who secure the chain; delegated IXO earns rewards and is not in the bank balance. `delegations`: per validator (`moniker`, `validator` address) the IXO delegated now (`coin`). `unbonding`: IXO being undelegated (`coin`), returned to the bank balance at `completesAt` (it earns nothing meanwhile). `rewards`: earned and not yet withdrawn (claiming them is a transaction), in total and per validator (`coins`). `totals` adds them up. `rewardsUnavailable: true` = the rewards could not be read; the delegations still stand.',
    'Liquid staking is staking too: IXO staked into a liquid staking pool (e.g. for PAY) is delegated by the pool, not by the account, so it is not listed here: see `liquid_staking`.',
    '`staking: false` = no delegations and nothing unbonding (rewards may still be waiting). Amounts are display units (`amount` + `symbol`) with `amountBaseUnits`; reward fractions of a base unit are dropped. `moreDelegations` / `moreUnbonding` = more than 50 validators, the rest not read.',
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
        const page = `pagination.limit=${STAKING_PAGE}`;
        const [delegations, unbonding, rewards] = await Promise.all([
          ctx.rest(
            `/cosmos/staking/v1beta1/delegations/${account.address}?${page}`,
            delegationsResponse,
            { label: 'delegations' },
          ),
          ctx.rest(
            `/cosmos/staking/v1beta1/delegators/${account.address}/unbonding_delegations?${page}`,
            unbondingResponse,
            { label: 'unbonding delegations' },
          ),
          ctx.rest(
            `/cosmos/distribution/v1beta1/delegators/${account.address}/rewards`,
            rewardsResponse,
            { label: 'staking rewards' },
          ),
        ]);
        if (!delegations.ok) return failed(delegations.failure);
        if (!unbonding.ok) return failed(unbonding.failure);
        const earned = rewards.ok ? rewards.value : null;
        const validators = [
          ...new Set([
            ...delegations.value.delegation_responses.map(
              (row) => row.delegation.validator_address,
            ),
            ...unbonding.value.unbonding_responses.map(
              (row) => row.validator_address,
            ),
            ...(earned?.rewards ?? []).map((row) => row.validator_address),
          ]),
        ].filter((valoper) => VALOPER.test(valoper));
        const names = new Map<string, string>();
        await Promise.all(
          validators.slice(0, MONIKER_LOOKUPS).map(async (valoper) => {
            const moniker = await monikerOf(ctx, valoper);
            if (moniker.ok && moniker.value) names.set(valoper, moniker.value);
          }),
        );
        const who = (valoper: string) => {
          const moniker = names.get(valoper);
          return {
            validator: clip(valoper, 80),
            ...(moniker ? { moniker } : {}),
          };
        };
        const delegated = await Promise.all(
          delegations.value.delegation_responses.map(async (row) => ({
            ...who(row.delegation.validator_address),
            coin: await displayCoin(ctx, row.balance),
          })),
        );
        // Unbonding balances are in the bond denom, uixo on every IXO network.
        const entries = unbonding.value.unbonding_responses.flatMap((row) =>
          row.entries.flatMap((entry) => {
            const units = wholeUnits(entry.balance);
            return units === null
              ? []
              : [
                  {
                    ...who(row.validator_address),
                    coin: ixo(units),
                    completesAt: entry.completion_time,
                  },
                ];
          }),
        );
        const bonded = delegated.flatMap((row) =>
          row.coin?.denom === 'uixo' ? [row.coin.amountBaseUnits] : [],
        );
        return {
          ok: true,
          subject: account.subject,
          data: {
            address: account.address,
            staking: delegated.length > 0 || entries.length > 0,
            delegations: delegated,
            unbonding: entries,
            ...(earned
              ? {
                  rewards: {
                    total: await coinsOr(ctx, earned.total, 'none'),
                    byValidator: await Promise.all(
                      earned.rewards.map(async (row) => ({
                        ...who(row.validator_address),
                        coins: await coinsOr(ctx, row.reward, 'none'),
                      })),
                    ),
                  },
                }
              : { rewardsUnavailable: true }),
            totals: {
              delegated: ixo(sum(bonded)),
              unbonding: ixo(
                sum(entries.map((row) => row.coin.amountBaseUnits)),
              ),
            },
            ...(delegations.value.pagination?.next_key
              ? { moreDelegations: true }
              : {}),
            ...(unbonding.value.pagination?.next_key
              ? { moreUnbonding: true }
              : {}),
          },
        };
      },
    };
  },
});
