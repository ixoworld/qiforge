/**
 * `evaluations`: x/claims evaluations, by claim, by collection or by the
 * agent that evaluated (default: the user).
 *
 * Index (ixo-blocksync main): `Evaluation_claimId_evaluationDate_idx`
 * ("claimId", "evaluationDate" DESC) and
 * `Evaluation_collectionId_evaluationDate_id_idx` ("collectionId",
 * "evaluationDate", "id") serve the claim and collection reads in
 * `EVALUATION_DATE_DESC` order; `Evaluation_agentAddress_idx`
 * ("agentAddress") serves the evaluator read, ordered by the primary key
 * `id` (indexing order).
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
  collectionIdArg,
  compact,
  connection,
  cw1155Amounts,
  cw20Amounts,
  equalTo,
  idText,
  listResult,
  nonEmpty,
  num,
  opt,
  str,
  unexpected,
} from './shared';

/** x/claims `EvaluationStatus`. */
const STATUS = [
  'pending',
  'approved',
  'rejected',
  'disputed',
  'invalidated',
  'flagged',
] as const;

const args = z
  .strictObject({
    claimId: claimIdArg('Every evaluation of this claim (its history).'),
    collectionId: collectionIdArg(
      'Every evaluation in this collection, e.g. "8250".',
    ),
    evaluator: accountArg('The agent that evaluated'),
    first: firstArg,
  })
  .refine(
    (value) =>
      [value.claimId, value.collectionId, value.evaluator].filter(
        (given) => given !== undefined,
      ).length <= 1,
    { message: 'give at most one of claimId, collectionId and evaluator' },
  );

// `cw1155Payment` is on the mainnet index's `Evaluation` (introspected on
// Oct 29 2026), as the chain's `[{ address, token_id, amount }]`.
const FIELDS =
  'claimId collectionId oracle agentDid agentAddress status reason verificationProof amount cw20Payment cw1155Payment evaluationDate';

const node = z.looseObject({
  claimId: str,
  collectionId: str,
  oracle: opt,
  agentDid: opt,
  agentAddress: opt,
  status: z.number().nullish(),
  reason: num,
  verificationProof: opt,
  amount: z.unknown().optional(),
  cw20Payment: z.unknown().optional(),
  cw1155Payment: z.unknown().optional(),
  evaluationDate: opt,
});

function statusOf(value: number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return STATUS[value] ?? `unknown (${value})`;
}

async function evaluationOf(ctx: KindContext, row: z.infer<typeof node>) {
  const coins = await bankCoins(ctx, row.amount);
  const cw20 = nonEmpty(cw20Amounts(row.cw20Payment));
  const cw1155 = nonEmpty(cw1155Amounts(row.cw1155Payment));
  return compact({
    claimId: idText(row.claimId),
    collectionId: idText(row.collectionId),
    status: statusOf(row.status),
    evaluationDate: idText(row.evaluationDate),
    evaluatorAddress: idText(row.agentAddress),
    evaluatorDid: idText(row.agentDid),
    oracle: idText(row.oracle),
    reasonCode:
      row.reason === null || row.reason === undefined
        ? undefined
        : idText(String(row.reason)),
    verificationProof: idText(row.verificationProof),
    coins,
    cw20,
    cw1155,
    // x/claims pays the collection's default approval payment only when an
    // evaluation sets none of the three; any one set replaces all of it.
    defaultPayment: !coins && !cw20 && !cw1155 ? true : undefined,
  });
}

export const evaluations = defineKind({
  name: 'evaluations',
  summary:
    'Claim evaluations: the history of one claim, a collection, or what an agent evaluated (default: the user).',
  explain: [
    'An evaluation is the verdict an evaluation agent, acting for an oracle, gives a claim: approved claims get paid from the collection, rejected ones do not.',
    'Status: pending, approved, rejected, disputed, invalidated, or flagged (the evaluator declined to decide yet; the claim can be evaluated again, and only a later approved/rejected/invalidated is final).',
    'A claim can have several evaluations (flagged, then decided); with claimId they are newest first.',
    'Each: claimId, collectionId, status, evaluationDate, evaluatorAddress/evaluatorDid (the agent that evaluated), oracle (the oracle entity it evaluated for), reasonCode (a number the evaluator defines), verificationProof (the CID of the evaluation credential).',
    '`coins` (bank coins), `cw20` (base units per token contract) and `cw1155` (whole units of the listed token ids per contract) are the approval payment the evaluation set: together they replace the collection’s default, so one absent beside another pays nothing of its kind.',
    '`defaultPayment: true`: it set none of them, so an approval pays the collection’s default approval payment (see claim_collection payments). A claim with an intent is paid its intent amounts, which the evaluation then carries.',
    COINS_NOTE,
    'For the evaluations of claims an account submitted, ask `claims` (each carries its current evaluation) or this kind with a claimId.',
    'Give at most one of claimId, collectionId, evaluator; with none, the user’s own evaluations.',
  ].join(' '),
  source: 'blocksync',
  list: true,
  args,
  example: { collectionId: '8250', first: 5 },
  plan(input, ctx) {
    const n = ctx.first;
    let filter: string;
    let orderBy: string;
    let subject: 'user' | 'other' | undefined;
    if (input.claimId !== undefined) {
      filter = equalTo('claimId', input.claimId);
      orderBy = 'EVALUATION_DATE_DESC';
    } else if (input.collectionId !== undefined) {
      filter = equalTo('collectionId', input.collectionId);
      orderBy = 'EVALUATION_DATE_DESC';
    } else {
      const evaluator = accountFor(input.evaluator, ctx.identity, 'evaluator');
      if ('invalid' in evaluator) return evaluator;
      filter = equalTo('agentAddress', evaluator.address);
      orderBy = 'ID_DESC';
      subject = evaluator.subject;
    }
    return {
      source: 'blocksync',
      field: (alias) =>
        `${alias}: evaluations(filter: ${filter}, first: ${n}, orderBy: ${orderBy}) { ${PAGE} nodes { ${FIELDS} } }`,
      async shape(raw): Promise<KindResult> {
        const parsed = connection(node).safeParse(raw);
        if (!parsed.success) return { ok: false, ...unexpected };
        return listResult(
          {
            items: await Promise.all(
              parsed.data.nodes.map((row) => evaluationOf(ctx, row)),
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
