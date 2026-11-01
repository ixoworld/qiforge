/**
 * `member_budgets`: an account's per-period spending budgets in team
 * claim collections (x/claims `MemberBudget`).
 *
 * Index (ixo-blocksync main): `MemberBudget_memberAddress_idx`
 * ("memberAddress") serves the account; the primary key ("collectionId",
 * "memberAddress") serves a collection with it and gives the order
 * (collection id as text).
 */
import { z } from 'zod';
import { literal } from '../../queries';
import { COINS_NOTE, displayCoins, type ChainCoin } from '../coins';
import { defineKind, type KindContext, type KindResult } from '../types';
import { accountArg, firstArg } from '../../queries';
import {
  PAGE,
  accountFor,
  chainCoins,
  collectionIdArg,
  compact,
  connection,
  cw20Amounts,
  idText,
  listResult,
  num,
  opt,
  reached,
  str,
  unexpected,
} from './shared';

const args = z.strictObject({
  address: accountArg('Team member'),
  collectionId: collectionIdArg('Only this collection, e.g. "8250".'),
  first: firstArg,
});

const FIELDS =
  'collectionId memberAddress periodNs periodSpendLimit periodSpent periodCw20SpendLimit periodCw20Spent periodResetAt updatedAt';

const node = z.looseObject({
  collectionId: str,
  memberAddress: str,
  periodNs: num,
  periodSpendLimit: z.unknown().optional(),
  periodSpent: z.unknown().optional(),
  periodCw20SpendLimit: z.unknown().optional(),
  periodCw20Spent: z.unknown().optional(),
  periodResetAt: opt,
  updatedAt: opt,
});

const DIGITS = /^\d+$/;
const NS_PER_SECOND = 1_000_000_000n;

/** A period in nanoseconds as days, hours or seconds (the largest unit it divides into). */
function periodLabel(
  value: string | number | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const ns = String(value);
  if (!DIGITS.test(ns)) return undefined;
  const seconds = BigInt(ns) / NS_PER_SECOND;
  if (seconds > 0n && seconds % 86_400n === 0n)
    return `${seconds / 86_400n} days`;
  if (seconds > 0n && seconds % 3_600n === 0n)
    return `${seconds / 3_600n} hours`;
  return `${seconds} seconds`;
}

/**
 * Per limit denom, what is left this period: the limit less what counts
 * as spent in it (never below zero).
 */
function remainingOf(limit: ChainCoin[], spent: ChainCoin[]): ChainCoin[] {
  return limit.map((coin) => {
    const used = spent.find((entry) => entry.denom === coin.denom);
    const left = BigInt(coin.amount) - (used ? BigInt(used.amount) : 0n);
    return { denom: coin.denom, amount: String(left > 0n ? left : 0n) };
  });
}

/**
 * An empty limit lets the member commit none of that kind (x/claims
 * checks an intent's coins against the limit less what was spent, and a
 * denom or cw20 contract it does not list has nothing left); the chain
 * refuses a budget with neither a native nor a cw20 limit.
 */
const NONE_ALLOWED = 'none allowed';
/** What was spent this period, or `"none"`. */
const spentOrNone = <T>(list: T[]): T[] | 'none' =>
  list.length ? list : 'none';

async function budgetOf(
  ctx: KindContext,
  row: z.infer<typeof node>,
  now: number,
) {
  const limit = chainCoins(row.periodSpendLimit);
  const cw20Limit = cw20Amounts(row.periodCw20SpendLimit);
  // After the reset time nothing spent counts: the chain zeroes it at the
  // member's next intent.
  const resetDue = reached(row.periodResetAt, now) === true;
  const spent = resetDue ? [] : chainCoins(row.periodSpent);
  const cw20Spent = resetDue ? [] : cw20Amounts(row.periodCw20Spent);
  const [spendLimit, spentShown, remaining] = await Promise.all([
    displayCoins(ctx, limit),
    displayCoins(ctx, spent),
    displayCoins(ctx, remainingOf(limit, spent)),
  ]);
  const native = spendLimit.length > 0;
  return compact({
    collectionId: idText(row.collectionId),
    member: idText(row.memberAddress),
    period: periodLabel(row.periodNs),
    spendLimit: native ? spendLimit : NONE_ALLOWED,
    spent: spentOrNone(spentShown),
    remaining: native ? remaining : undefined,
    cw20SpendLimit: cw20Limit.length ? cw20Limit : NONE_ALLOWED,
    cw20Spent: spentOrNone(cw20Spent),
    resetAt: idText(row.periodResetAt),
    resetDue: resetDue ? true : undefined,
    updatedAt: idText(row.updatedAt),
  });
}

export const memberBudgets = defineKind({
  name: 'member_budgets',
  summary:
    'Spending budgets an account (default: the user) has as a team member of claim collections.',
  explain: [
    'A collection with member budgets is a team collection: every claim intent on it is made on behalf of a member, and each member may commit at most `spendLimit` of the collection’s payments per `period` (at least 24 hours).',
    '`spendLimit` is bank coins (a denom it does not list may not be committed), or `"none allowed"`: no bank coin, only the cw20 tokens of `cw20SpendLimit` (likewise `"none allowed"` when no cw20 token may be committed).',
    'Committing an intent adds its amount to `spent` (`"none"` when nothing counts this period); a rejected, disputed or invalidated claim, or an intent that expires unused, gives it back within the same period.',
    '`remaining` is the limit less what was spent this period. The period rolls over at `resetAt`, lazily: `resetDue: true` means that time has passed, so nothing spent counts any more and the chain zeroes it at the member’s next intent.',
    COINS_NOTE,
    '`cw20SpendLimit`/`cw20Spent` are base units per cw20 token contract. cw1155 payments are not budgeted.',
    'Ordered by collection id as text. Empty when the account is not a member of any team collection.',
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: { collectionId: '8250' },
  plan(input, ctx) {
    const member = accountFor(input.address, ctx.identity, 'address');
    if ('invalid' in member) return member;
    const n = ctx.first;
    const filter = literal({
      memberAddress: { equalTo: member.address },
      ...(input.collectionId !== undefined
        ? { collectionId: { equalTo: input.collectionId } }
        : {}),
    });
    return {
      source: 'blocksync',
      field: (alias) =>
        `${alias}: memberBudgets(filter: ${filter}, first: ${n}, orderBy: PRIMARY_KEY_ASC) { ${PAGE} nodes { ${FIELDS} } }`,
      async shape(raw): Promise<KindResult> {
        const parsed = connection(node).safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        const now = Date.now();
        return listResult(
          {
            items: await Promise.all(
              parsed.data.nodes.map((row) => budgetOf(ctx, row, now)),
            ),
            more: parsed.data.pageInfo?.hasNextPage ? true : undefined,
          },
          n,
          member.subject,
        );
      },
    };
  },
});
