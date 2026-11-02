/**
 * `token_history`: the IXO 1155 token transfers, retirements and
 * cancellations of an account, as one alias holding one sub-field per
 * direction (Blocksync's `query` field nests the root query type).
 *
 * Index (ixo-blocksync main): `TokenTransaction_from_to_idx` ("from",
 * "to") serves `from`; `to` and `TokenRetired`/`TokenCancelled` `owner`
 * lead no index (`TokenRetired_name_owner_id_idx` and
 * `TokenCancelled_name_idx` lead with `name`). All four answered in under
 * 1 s on mainnet on Oct 29 2026 (`to` 0.9 s, the slowest), so they are
 * read without `totalCount`, newest indexed row first (`aid`, the primary
 * key). The index stores no time or height for these rows.
 */
import { z } from 'zod';
import { TOKEN_DECIMALS_NOTE } from '../../summaries';
import { defineKind, type KindResult } from '../types';
import { accountArg, firstArg } from '../../queries';
import { text } from '../../summaries';
import {
  PAGE,
  accountFor,
  amountText,
  compact,
  connection,
  equalTo,
  idText,
  listResult,
  longText,
  opt,
  str,
  unexpected,
} from './shared';

const DIRECTIONS = ['in', 'out', 'retired', 'cancelled'] as const;
type Direction = (typeof DIRECTIONS)[number];

const args = z.strictObject({
  address: accountArg('Token holder'),
  direction: z
    .enum(DIRECTIONS)
    .optional()
    .describe(
      'in (received), out (sent), retired or cancelled. Default: in and out.',
    ),
  first: firstArg,
});

const TRANSFER_FIELDS = 'aid from to amount tokenId token { name collection }';

/** The sub-fields (name, root and fields) a direction reads. */
const SUBFIELDS: Record<
  Direction,
  { name: string; root: string; column: string; fields: string }
> = {
  out: {
    name: 'sent',
    root: 'tokenTransactions',
    column: 'from',
    fields: TRANSFER_FIELDS,
  },
  in: {
    name: 'received',
    root: 'tokenTransactions',
    column: 'to',
    fields: TRANSFER_FIELDS,
  },
  retired: {
    name: 'retired',
    root: 'tokenRetireds',
    column: 'owner',
    fields: 'aid id name amount reason jurisdiction',
  },
  cancelled: {
    name: 'cancelled',
    root: 'tokenCancelleds',
    column: 'owner',
    fields: 'aid id name amount reason',
  },
};

const transferNode = z.looseObject({
  aid: z.number(),
  from: str,
  to: str,
  amount: z.union([z.string(), z.number()]),
  tokenId: str,
  token: z.looseObject({ name: opt, collection: opt }).nullish(),
});
const burnNode = z.looseObject({
  aid: z.number(),
  id: str,
  name: opt,
  amount: z.union([z.string(), z.number()]),
  reason: opt,
  jurisdiction: opt,
});
const answer = z.looseObject({
  sent: connection(transferNode).optional(),
  received: connection(transferNode).optional(),
  retired: connection(burnNode).optional(),
  cancelled: connection(burnNode).optional(),
});

type Row = { aid: number; item: Record<string, unknown> };

function transferRows(
  nodes: z.infer<typeof transferNode>[],
  direction: 'sent' | 'received',
): Row[] {
  return nodes.map((node) => {
    // An empty sender is a mint, an empty recipient a burn.
    const counterparty = direction === 'sent' ? node.to : node.from;
    return {
      aid: node.aid,
      item: compact({
        direction,
        tokenId: idText(node.tokenId),
        name: text(node.token?.name),
        collection: idText(node.token?.collection),
        amount: amountText(node.amount),
        counterparty: idText(counterparty),
        minted: direction === 'received' && !node.from ? true : undefined,
        burned: direction === 'sent' && !node.to ? true : undefined,
      }),
    };
  });
}

function burnRows(
  nodes: z.infer<typeof burnNode>[],
  direction: 'retired' | 'cancelled',
): Row[] {
  return nodes.map((node) => ({
    aid: node.aid,
    item: compact({
      direction,
      tokenId: idText(node.id),
      name: text(node.name),
      amount: amountText(node.amount),
      reason: longText(node.reason),
      jurisdiction: text(node.jurisdiction, 80),
    }),
  }));
}

export const tokenHistory = defineKind({
  name: 'token_history',
  summary:
    'IXO 1155 token movements of an account (default: the user): received, sent, retired or cancelled.',
  explain: [
    'IXO 1155 tokens (impact tokens, carbon credits, SUPA…) move between accounts; retiring one takes it out of circulation for good, with a reason and a jurisdiction (an offset claim), and cancelling one voids it.',
    'Each row: direction (received, sent, retired, cancelled), tokenId, name (the token class), collection, amount and, for transfers, the counterparty.',
    '`minted: true` marks a received row with no sender (newly minted to the account); `burned: true` a sent row with no recipient.',
    'IXO 1155 tokens have no decimals on chain: amounts are whole units.',
    'Rows are newest indexed first; the index keeps no time or block height for them, so ask `transactions` for when.',
    'With no direction, received and sent are merged; `more: true` when the index holds older rows.',
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: { direction: 'retired', first: 5 },
  plan(input, ctx) {
    const holder = accountFor(input.address, ctx.identity, 'address');
    if ('invalid' in holder) return holder;
    const directions: Direction[] = input.direction
      ? [input.direction]
      : ['in', 'out'];
    const n = ctx.first;
    const subfields = directions
      .map((direction) => {
        const { name, root, column, fields } = SUBFIELDS[direction];
        return `${name}: ${root}(filter: ${equalTo(column, holder.address)}, first: ${n}, orderBy: PRIMARY_KEY_DESC) { ${PAGE} nodes { ${fields} } }`;
      })
      .join(' ');
    return {
      source: 'blocksync',
      field: (alias) => `${alias}: query { ${subfields} }`,
      shape(raw): KindResult {
        const parsed = answer.safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        const { sent, received, retired, cancelled } = parsed.data;
        const parts = [sent, received, retired, cancelled];
        // A transfer to oneself is not indexed, so no row is in both lists.
        const rows = [
          ...transferRows(sent?.nodes ?? [], 'sent'),
          ...transferRows(received?.nodes ?? [], 'received'),
          ...burnRows(retired?.nodes ?? [], 'retired'),
          ...burnRows(cancelled?.nodes ?? [], 'cancelled'),
        ].sort((a, b) => b.aid - a.aid);
        const more =
          rows.length > n ||
          parts.some((part) => part?.pageInfo?.hasNextPage === true);
        return listResult(
          {
            note: TOKEN_DECIMALS_NOTE,
            items: rows.slice(0, n).map((row) => row.item),
            more: more ? true : undefined,
          },
          n,
          holder.subject,
        );
      },
    };
  },
});
