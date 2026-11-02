/**
 * `agent_deposits`: an account's performance deposits in claim
 * collections (x/claims `AgentDepositBalance`).
 *
 * Index (ixo-blocksync main): `AgentDepositBalance_agentAddress_idx`
 * ("agentAddress") serves the account; the primary key ("collectionId",
 * "agentAddress") serves a collection with it and gives the order
 * (collection id as text).
 */
import { z } from 'zod';
import { literal } from '../../queries';
import { COINS_NOTE, displayCoins, type DisplayCoin } from '../coins';
import { defineKind, type KindContext, type KindResult } from '../types';
import { accountArg, firstArg } from '../../queries';
import {
  PAGE,
  accountFor,
  chainCoins,
  collectionIdArg,
  compact,
  connection,
  idText,
  listResult,
  opt,
  reached,
  str,
  unexpected,
} from './shared';

const args = z.strictObject({
  address: accountArg('Agent'),
  collectionId: collectionIdArg('Only this collection, e.g. "8250".'),
  first: firstArg,
});

const FIELDS = 'collectionId agentAddress amount withdrawableAt updatedAt';

const node = z.looseObject({
  collectionId: str,
  agentAddress: str,
  amount: z.unknown().optional(),
  withdrawableAt: opt,
  updatedAt: opt,
});

/**
 * A deposit's balance (x/claims keeps it as coins): `coin` when it holds
 * one denom, `coins` when several, `"none"` when the record holds none.
 * An amount that is no coin is left out.
 */
async function balanceOf(
  ctx: KindContext,
  amount: unknown,
): Promise<{ coin?: DisplayCoin | 'none'; coins?: DisplayCoin[] }> {
  const shown = await displayCoins(ctx, chainCoins(amount));
  const [only] = shown;
  if (only && shown.length === 1) return { coin: only };
  if (shown.length) return { coins: shown };
  return Array.isArray(amount) && amount.length === 0 ? { coin: 'none' } : {};
}

async function depositOf(
  ctx: KindContext,
  row: z.infer<typeof node>,
  now: number,
) {
  return compact({
    collectionId: idText(row.collectionId),
    agent: idText(row.agentAddress),
    ...(await balanceOf(ctx, row.amount)),
    withdrawableAt: idText(row.withdrawableAt),
    lockEnded: reached(row.withdrawableAt, now),
    updatedAt: idText(row.updatedAt),
  });
}

export const agentDeposits = defineKind({
  name: 'agent_deposits',
  summary:
    'Performance deposits an agent (default: the user) holds in claim collections, and when each can be withdrawn.',
  explain: [
    'A performance deposit is stake an agent (a service agent, an evaluator or a disputer) puts into a collection’s escrow so it has something to lose: a dispute the agent loses is paid out of it.',
    'Each: collectionId, agent, `coin` (the balance; `coins` when it holds several denoms, `"none"` when empty), withdrawableAt and `lockEnded`.',
    'Every top-up moves `withdrawableAt` to at least now plus the collection’s minimum deposit period; a collection without one has no lock (a zero date).',
    '`lockEnded: true` means that time has passed. Withdrawing also needs no open dispute against the agent in that collection (see `disputes`), which this record does not show.',
    'A fully withdrawn or slashed deposit is removed, so it no longer appears. Ordered by collection id as text.',
    COINS_NOTE,
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: {},
  plan(input, ctx) {
    const agent = accountFor(input.address, ctx.identity, 'address');
    if ('invalid' in agent) return agent;
    const n = ctx.first;
    const filter = literal({
      agentAddress: { equalTo: agent.address },
      ...(input.collectionId !== undefined
        ? { collectionId: { equalTo: input.collectionId } }
        : {}),
    });
    return {
      source: 'blocksync',
      field: (alias) =>
        `${alias}: agentDepositBalances(filter: ${filter}, first: ${n}, orderBy: PRIMARY_KEY_ASC) { ${PAGE} nodes { ${FIELDS} } }`,
      async shape(raw): Promise<KindResult> {
        const parsed = connection(node).safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        const now = Date.now();
        return listResult(
          {
            items: await Promise.all(
              parsed.data.nodes.map((row) => depositOf(ctx, row, now)),
            ),
            more: parsed.data.pageInfo?.hasNextPage ? true : undefined,
          },
          n,
          agent.subject,
        );
      },
    };
  },
});
