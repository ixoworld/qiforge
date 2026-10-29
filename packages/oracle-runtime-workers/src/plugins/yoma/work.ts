/**
 * Where a person's logged work stands: whether it was approved and whether
 * it was paid, read live from Blocksync (the same query as Jambo's
 * `fetchClaimsByAgentAddress`), never from memory. Approval and payment are
 * told apart. The job's name is its claim form's title.
 */
import { z } from 'zod';
import type { ChainCall, Outcome } from '../ixo-chain/http';
import {
  coinSchema,
  COLLECTION_ID,
  fetchEntities,
  loadForm,
  nodesOf,
  paymentsSchema,
  positiveCoins,
  templateTitle,
  type Coin,
  type RawEntity,
} from './catalog';
import { blocksyncRead, literal } from './reads';

/** A cursor is Blocksync's opaque base64. */
const CURSOR = /^[A-Za-z0-9+/=_-]{1,200}$/;

/** ixo.claims.v1beta1.EvaluationStatus, in words a person reads. */
const CHECK_LABEL: Record<number, { state: string; label: string }> = {
  0: { state: 'being_checked', label: 'Being checked' },
  1: { state: 'approved', label: 'Approved ✓' },
  2: { state: 'not_approved', label: 'Not approved' },
  3: { state: 'disputed', label: 'With support' },
  4: { state: 'not_approved', label: 'Not approved' },
  // Flagged: a reviewer wants another look before deciding.
  5: { state: 'being_checked', label: 'Being checked again' },
};
const BEING_CHECKED = { state: 'being_checked', label: 'Being checked' };

/** ixo.claims.v1beta1.PaymentStatus of the approval payment. */
const PAYMENT_LABEL: Record<string, { state: string; label: string }> = {
  PAID: { state: 'paid', label: 'Paid' },
  PROMISED: { state: 'on_its_way', label: 'On its way' },
  AUTHORIZED: { state: 'on_its_way', label: 'On its way' },
  GUARANTEED: { state: 'on_its_way', label: 'On its way' },
  FAILED: { state: 'problem', label: 'Payment problem — the team is on it' },
  DISPUTED_PAYMENT: { state: 'problem', label: 'Payment is being looked into' },
};

const claimSchema = z.object({
  claimId: z.string().max(200),
  collectionId: z.string().regex(COLLECTION_ID),
  submissionDate: z.string().nullable(),
  paymentsStatus: z
    .object({ approval: z.string().optional() })
    .passthrough()
    .nullable(),
  evaluationByClaimId: z
    .object({
      status: z.number().int(),
      evaluationDate: z.string().nullable(),
      amount: z.array(coinSchema).max(20).nullable().optional(),
    })
    .nullable(),
});
type RawClaim = z.infer<typeof claimSchema>;

const pageSchema = z.object({
  totalCount: z.number().int().optional(),
  pageInfo: z
    .object({
      hasNextPage: z.boolean().optional(),
      endCursor: z.string().nullable().optional(),
    })
    .optional(),
});

const collectionSchema = z.object({
  id: z.string(),
  protocol: z.string(),
  payments: paymentsSchema,
});

export interface WorkItem {
  collectionId: string;
  job: string;
  sentOn?: string;
  check: { state: string; label: string };
  checkedOn?: string;
  payment: { state: string; label: string };
  /** What approval pays: the evaluation's amount, else the collection's. */
  reward: Coin[];
}

export interface WorkPage {
  items: WorkItem[];
  total: number;
  hasNextPage: boolean;
  endCursor?: string;
}

function paymentOf(claim: RawClaim, reward: Coin[]): WorkItem['payment'] {
  const known = PAYMENT_LABEL[claim.paymentsStatus?.approval ?? ''];
  if (known) return known;
  if (claim.evaluationByClaimId?.status !== 1)
    return { state: 'not_due', label: '—' };
  return reward.length
    ? { state: 'not_paid_yet', label: 'Not paid yet' }
    : { state: 'no_payment', label: 'No payment for this one' };
}

/** One page of the account's claims, newest first, with each job's name. */
export async function loadWork(
  call: ChainCall,
  input: { address: string; first: number; after?: string },
): Promise<Outcome<WorkPage>> {
  const after =
    input.after && CURSOR.test(input.after)
      ? `, after: ${literal(input.after)}`
      : '';
  const claims = await blocksyncRead(call, [
    {
      alias: 'w',
      field: `w: claims(filter: { agentAddress: { equalTo: ${literal(input.address)} } }, first: ${input.first}${after}, orderBy: SUBMISSION_DATE_DESC) { totalCount pageInfo { hasNextPage endCursor } nodes { claimId collectionId submissionDate paymentsStatus evaluationByClaimId { status evaluationDate amount } } }`,
    },
  ]);
  if (!claims.ok) return claims;
  const parsedPage = pageSchema.safeParse(claims.value.w);
  const page = parsedPage.success ? parsedPage.data : undefined;
  const nodes = nodesOf(claims.value.w, claimSchema);
  const endCursor = page?.pageInfo?.endCursor;
  const base: Omit<WorkPage, 'items'> = {
    total: page?.totalCount ?? nodes.length,
    hasNextPage: page?.pageInfo?.hasNextPage === true,
    ...(endCursor && CURSOR.test(endCursor) ? { endCursor } : {}),
  };
  if (!nodes.length) return { ok: true, value: { items: [], ...base } };

  // Names: each collection's protocol, then its claim form's title. A name
  // that cannot be read falls back to the collection id; the statuses stand.
  const collectionIds = [...new Set(nodes.map((n) => n.collectionId))];
  const collections = await blocksyncRead(call, [
    {
      alias: 'c',
      field: `c: claimCollections(filter: { id: { in: [${collectionIds.map(literal).join(', ')}] } }, first: ${collectionIds.length}) { nodes { id protocol payments } }`,
    },
  ]);
  const byId = new Map(
    (collections.ok ? nodesOf(collections.value.c, collectionSchema) : []).map(
      (c) => [c.id, c],
    ),
  );
  const protocolIds = [...new Set([...byId.values()].map((c) => c.protocol))];
  const protocols = protocolIds.length
    ? await fetchEntities(call, protocolIds)
    : { ok: true as const, value: new Map<string, RawEntity>() };
  const titles = new Map(
    await Promise.all(
      protocolIds.map(async (id) => {
        const form = protocols.ok
          ? await loadForm(call, protocols.value.get(id), 'claim')
          : undefined;
        return [id, form?.ok ? templateTitle(form.value) : undefined] as const;
      }),
    ),
  );

  const items = nodes.map((claim): WorkItem => {
    const collection = byId.get(claim.collectionId);
    const evaluation = claim.evaluationByClaimId;
    const paid = positiveCoins(evaluation?.amount);
    const reward = paid.length
      ? paid
      : positiveCoins(collection?.payments?.approval?.amount);
    return {
      collectionId: claim.collectionId,
      job:
        (collection && titles.get(collection.protocol)) ??
        `Opportunity ${claim.collectionId}`,
      ...(claim.submissionDate
        ? { sentOn: claim.submissionDate.slice(0, 10) }
        : {}),
      check: CHECK_LABEL[evaluation?.status ?? 0] ?? BEING_CHECKED,
      ...(evaluation?.evaluationDate
        ? { checkedOn: evaluation.evaluationDate.slice(0, 10) }
        : {}),
      payment: paymentOf(claim, reward),
      reward,
    };
  });
  return { ok: true, value: { items, ...base } };
}
