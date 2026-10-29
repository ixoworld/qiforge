/**
 * `disputes`: x/claims disputes against one claim, or those an account
 * filed (default: the user), with their resolution.
 *
 * Index (ixo-blocksync main): `Dispute_subjectId_idx` ("subjectId") and
 * `Dispute_disputerAddress_idx` ("disputerAddress"); ordered by the
 * primary key `id` (filing order), newest first. The resolution is the
 * 1:1 `DisputeResolution` row (primary key "disputeId"). The filing's and
 * the resolution's `data` (evidence links and proofs) are not read.
 */
import { z } from 'zod';
import { COINS_NOTE } from '../coins';
import { defineKind, type KindContext, type KindResult } from '../types';
import { accountArg, firstArg } from '../../queries';
import {
  PAGE,
  accountFor,
  bankCoins,
  claimIdArg,
  compact,
  connection,
  equalTo,
  idText,
  listResult,
  opt,
  str,
  unexpected,
} from './shared';

/** x/claims `DisputeStatus`. */
const STATUS = ['open', 'awarded', 'dismissed'] as const;
/** x/claims `DisputeTargetRole`: the party of the claim disputed. */
const TARGET = ['unspecified', 'submitter', 'evaluator'] as const;

const args = z
  .strictObject({
    claimId: claimIdArg('Every dispute against this claim.'),
    address: accountArg('Disputer (who filed)'),
    first: firstArg,
  })
  .refine(
    (value) => value.claimId === undefined || value.address === undefined,
    { message: 'give claimId or address, not both' },
  );

const RESOLUTION_FIELDS =
  'resolvedAt adjudicatorDid adjudicatorAddress intendedPenalty actualPenaltyPaid winnerAddress winnerAmount loserAddress adjudicatorAmount';
const FIELDS = `id subjectId type targetRole status disputerAddress disputerDid disputeDeposit submittedAt resolution { ${RESOLUTION_FIELDS} }`;

const resolutionNode = z.looseObject({
  resolvedAt: opt,
  adjudicatorDid: opt,
  adjudicatorAddress: opt,
  intendedPenalty: z.unknown().optional(),
  actualPenaltyPaid: z.unknown().optional(),
  winnerAddress: opt,
  winnerAmount: z.unknown().optional(),
  loserAddress: opt,
  adjudicatorAmount: z.unknown().optional(),
});
const node = z.looseObject({
  id: z.union([z.string(), z.number()]),
  subjectId: str,
  type: z.number().nullish(),
  targetRole: z.number().nullish(),
  status: z.number().nullish(),
  disputerAddress: opt,
  disputerDid: opt,
  disputeDeposit: z.unknown().optional(),
  submittedAt: opt,
  resolution: resolutionNode.nullish(),
});

function named<T extends readonly string[]>(
  names: T,
  value: number | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return names[value] ?? `unknown (${value})`;
}

async function disputeOf(ctx: KindContext, row: z.infer<typeof node>) {
  const resolution = row.resolution;
  return compact({
    id: idText(String(row.id)),
    claimId: idText(row.subjectId),
    against: named(TARGET, row.targetRole),
    status: named(STATUS, row.status),
    type: row.type ?? undefined,
    disputer: idText(row.disputerAddress),
    disputerDid: idText(row.disputerDid),
    deposit: await bankCoins(ctx, row.disputeDeposit),
    submittedAt: idText(row.submittedAt),
    resolution: resolution
      ? compact({
          resolvedAt: idText(resolution.resolvedAt),
          adjudicator: idText(resolution.adjudicatorAddress),
          adjudicatorDid: idText(resolution.adjudicatorDid),
          intendedPenalty: await bankCoins(ctx, resolution.intendedPenalty),
          penaltyPaid: await bankCoins(ctx, resolution.actualPenaltyPaid),
          winner: idText(resolution.winnerAddress),
          winnerAmount: await bankCoins(ctx, resolution.winnerAmount),
          loser: idText(resolution.loserAddress),
          adjudicatorAmount: await bankCoins(ctx, resolution.adjudicatorAmount),
        })
      : undefined,
  });
}

export const disputes = defineKind({
  name: 'disputes',
  summary:
    'Disputes against a claim, or those an account filed (default: the user), with how each was resolved.',
  explain: [
    'A dispute challenges one party of a claim: `against` is `submitter` (the agent that submitted it) or `evaluator` (the agent that evaluated it). The disputer locks a deposit; an adjudicator the collection names then rules.',
    'Status: `open` (awaiting a ruling; the disputed agent cannot submit or withdraw its deposit in that collection meanwhile), `awarded` (upheld: the disputed party was in the wrong, its deposit is slashed, the disputer gets its deposit back and most of the penalty) or `dismissed` (the disputed party was vindicated; the disputer’s deposit becomes the penalty).',
    '`resolution`: when and by whom, the intended and actually paid penalty (capped by what the loser had), the winner, the loser, and the shares paid out.',
    '`type` is a number the client defines. Newest first. Evidence documents are not shown.',
    COINS_NOTE,
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: {
    claimId: 'bafkreibqh2o3cx2bhnvxhoknbashrse3lhxh5rjohyqgy5yoqqc5jhqgpm',
  },
  plan(input, ctx) {
    const n = ctx.first;
    let filter: string;
    let subject: 'user' | 'other' | undefined;
    if (input.claimId !== undefined)
      filter = equalTo('subjectId', input.claimId);
    else {
      const disputer = accountFor(input.address, ctx.identity, 'address');
      if ('invalid' in disputer) return disputer;
      filter = equalTo('disputerAddress', disputer.address);
      subject = disputer.subject;
    }
    return {
      source: 'blocksync',
      field: (alias) =>
        `${alias}: disputes(filter: ${filter}, first: ${n}, orderBy: ID_DESC) { ${PAGE} nodes { ${FIELDS} } }`,
      async shape(raw): Promise<KindResult> {
        const parsed = connection(node).safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        return listResult(
          {
            items: await Promise.all(
              parsed.data.nodes.map((row) => disputeOf(ctx, row)),
            ),
            more: parsed.data.pageInfo?.hasNextPage ? true : undefined,
          },
          n,
          subject,
        );
      },
    };
  },
});
