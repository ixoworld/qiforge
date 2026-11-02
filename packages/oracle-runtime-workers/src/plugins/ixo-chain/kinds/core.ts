/**
 * The core kinds: claims, collections, entities, DID documents, 1155
 * tokens and transactions, each one aliased root field of the call's
 * Blocksync document. Their arguments, patterns and fields are in
 * `queries.ts`; their answers are shaped by `summaries.ts`.
 */
import type { UserIdentity } from '../../../core/user-identity';
import {
  CORE_ARGS,
  requestField,
  type ChainRequest,
  type Subject,
} from '../queries';
import { shapeResult } from '../summaries';
import {
  defineKind,
  type KindContext,
  type KindDef,
  type KindInvalid,
  type KindPlan,
} from './types';

/** Whose a by-id record is, from the accounts the answer names as its owners. */
function ownerOf(
  ownedBy: string[] | undefined,
  identity: UserIdentity,
): Subject | undefined {
  if (!ownedBy) return undefined;
  return identity.address && ownedBy.includes(identity.address)
    ? 'user'
    : 'other';
}

/** A core request as its aliased field and the shaping of that alias's answer. */
function blocksyncPlan(
  request: ChainRequest,
  ctx: KindContext,
): KindPlan | KindInvalid {
  const plan = requestField(request, ctx.identity, ctx.first);
  if (!plan.ok) return { invalid: plan.detail };
  return {
    source: 'blocksync',
    field: (alias) => `${alias}: ${plan.field}`,
    shape(raw) {
      const shaped = shapeResult(request, raw);
      if (!shaped.ok) return { ok: false, ...shaped.failure };
      const subject = plan.subject ?? ownerOf(shaped.ownedBy, ctx.identity);
      return {
        ok: true,
        data: shaped.data,
        ...(subject ? { subject } : {}),
        ...(plan.first !== undefined ? { first: plan.first } : {}),
      };
    },
  };
}

const COINS =
  'Bank coins are `{ denom, amountBaseUnits }` in base units (uixo ÷ 1,000,000 = IXO).';
const STATUSES =
  'Evaluation status is pending, approved, rejected, disputed, invalidated or flagged.';

const claimsKind = defineKind({
  name: 'claims',
  summary:
    'Claims an agent submitted (default: the user), newest first, with evaluation and payment status.',
  explain: [
    'Each claim: claimId, collectionId, agent, submissionDate, `evaluation` (status, date) and `paymentsStatus` per payment leg (e.g. `approval: PAID`).',
    STATUSES,
    COINS,
    '`totalCount` counts every matching claim; when `hasNextPage`, pass `endCursor` as `after` for the next page.',
  ].join(' '),
  source: 'blocksync',
  list: true,
  args: CORE_ARGS.claims,
  example: { collectionId: '8250', first: 5 },
  plan: (args, ctx) => blocksyncPlan({ kind: 'claims', ...args }, ctx),
});

const COUNTED = ' { totalCount pageInfo { ';

/**
 * `claims` without its `totalCount`, which PostgreSQL computes by counting
 * every matching claim: the page and `hasNextPage` only. What
 * `get_account_overview` reads for its claims part. Not a `chain_lookup`
 * kind.
 */
export const claimsPage: KindDef = {
  ...claimsKind,
  plan(rawArgs, ctx) {
    const plan = claimsKind.plan(rawArgs, ctx);
    if ('invalid' in plan || plan.source !== 'blocksync') return plan;
    return {
      ...plan,
      field: (alias) => plan.field(alias).replace(COUNTED, ' { pageInfo { '),
    };
  },
};

/** The core kinds, in catalogue order. */
export const CORE_KINDS: readonly KindDef[] = [
  claimsKind,
  defineKind({
    name: 'claim',
    summary:
      'One claim by id, with its current evaluation (status, oracle, reason, amount paid).',
    explain: [
      '`not_found` when the index has no claim with that id.',
      STATUSES,
      COINS,
      "`subject` is `user` when the claim's agent is the user's address.",
    ].join(' '),
    source: 'blocksync',
    list: false,
    args: CORE_ARGS.claim,
    example: {
      claimId: 'bafkreido4unh2l34n5zy5sy3nhyc3nhih65eysmal5dlq6j56m3eecntfm',
    },
    plan: (args, ctx) => blocksyncPlan({ kind: 'claim', ...args }, ctx),
  }),
  defineKind({
    name: 'claim_collection',
    summary: 'One claim collection: claim counts, state and payment terms.',
    explain: [
      '`state` is open, paused or closed; quota, count, evaluated, approved, rejected and disputed count claims.',
      '`payments` per leg (submission, evaluation, approval, rejection): the paying `account`, bank coins, cw20 amounts (`amountBaseUnits`, base units), cw1155 amounts (whole units, with token ids) and `oraclePayment` when an oracle is paid.',
      COINS,
      "`subject` is `user` when the collection's admin is the user.",
    ].join(' '),
    source: 'blocksync',
    list: false,
    args: CORE_ARGS.claim_collection,
    example: { id: '8250' },
    plan: (args, ctx) =>
      blocksyncPlan({ kind: 'claim_collection', ...args }, ctx),
  }),
  defineKind({
    name: 'claim_collections',
    summary:
      'Claim collections by admin (default: the user) or by entity, newest start date first.',
    explain: [
      'Each: id, entity, admin, protocol, start/end date, claim counts and state (open, paused, closed).',
      'A collection without a start date sorts first.',
      'With only `entity`, every collection of that entity whatever its admin, and no `subject`.',
    ].join(' '),
    source: 'blocksync',
    list: true,
    args: CORE_ARGS.claim_collections,
    example: { first: 5 },
    plan: (args, ctx) =>
      blocksyncPlan({ kind: 'claim_collections', ...args }, ctx),
  }),
  defineKind({
    name: 'entities',
    summary:
      'Entities (DAOs, projects, protocols, assets…) an account owns (default: the user).',
    explain: [
      'Each: id (did:ixo:entity:…), type, status, owner, created.',
      'Ordered by id as text: ids are hashes, so the order says nothing about age.',
      "`status` is a number the entity's creator defines; the chain gives it no fixed meaning.",
    ].join(' '),
    source: 'blocksync',
    list: true,
    args: CORE_ARGS.entities,
    example: { type: 'dao' },
    plan: (args, ctx) => blocksyncPlan({ kind: 'entities', ...args }, ctx),
  }),
  defineKind({
    name: 'entity',
    summary:
      'One entity by DID: type, owner, controllers, accounts, linked entities and resources, services, settings.',
    explain: [
      'Resources, services and settings show what and where (id, type, description, serviceEndpoint, mediaType), never their content.',
      "`status` is a number the entity's creator defines.",
      'Ask it beside `did_document` for "what is did:ixo:entity:…".',
      "`subject` is `user` when the entity's owner is the user.",
    ].join(' '),
    source: 'blocksync',
    list: false,
    args: CORE_ARGS.entity,
    example: { id: 'did:ixo:entity:0123456789abcdef0123456789abcdef' },
    plan: (args, ctx) => blocksyncPlan({ kind: 'entity', ...args }, ctx),
  }),
  defineKind({
    name: 'did_document',
    summary:
      "A DID document (default: the user's DID): controllers, verification methods, linked resources.",
    explain: [
      'Any did:ixo:… DID, an entity or an account.',
      'Verification methods show id, type, controller and the public key or blockchain account they hold.',
    ].join(' '),
    source: 'blocksync',
    list: false,
    args: CORE_ARGS.did_document,
    example: {},
    plan: (args, ctx) => blocksyncPlan({ kind: 'did_document', ...args }, ctx),
  }),
  defineKind({
    name: 'token_balances',
    summary:
      'IXO 1155 tokens (impact tokens, carbon credits…) an account holds (default: the user), largest first.',
    explain: [
      'Each: tokenId, name, class, collection, amount, retired, contractAddress.',
      'IXO 1155 tokens have no decimals on chain: `amount` and `retired` are whole units.',
    ].join(' '),
    source: 'blocksync',
    list: true,
    args: CORE_ARGS.token_balances,
    example: {},
    plan: (args, ctx) =>
      blocksyncPlan({ kind: 'token_balances', ...args }, ctx),
  }),
  defineKind({
    name: 'transactions',
    summary:
      'Transactions an account signed (default) or received, newest first, with each message summarised.',
    explain: [
      'Each: hash, height, time, code, succeeded (code 0), memo and its first 5 messages (`messageCount` when there are more).',
      'Messages: MsgSend `{ from, to, amount }`, MsgTransferToken `{ from, to, tokens }` (whole units), claim messages `{ claimId, collectionId, status }`, an authz MsgExec as its first 5 inner messages, anything else as a short excerpt.',
      '`received` matches the recipient of a message (or of the first message inside a MsgExec); MsgMultiSend outputs are not seen.',
      COINS,
    ].join(' '),
    source: 'blocksync',
    list: true,
    args: CORE_ARGS.transactions,
    example: { direction: 'received', first: 5 },
    plan: (args, ctx) => blocksyncPlan({ kind: 'transactions', ...args }, ctx),
  }),
  defineKind({
    name: 'transaction',
    summary:
      'One transaction by hash, with up to 50 messages, its signers and fee.',
    explain: [
      'As a row of `transactions`, plus up to 10 `signers` and the `fee`.',
      COINS,
      '`subject` is `user` when the user signed it.',
    ].join(' '),
    source: 'blocksync',
    list: false,
    args: CORE_ARGS.transaction,
    example: {
      hash: '9C1D5E4A7B3F20864D2E6A1C8B5F3D7E0A4C6B2D8F1E3A5C7B9D0F2E4A6C8B1D',
    },
    plan: (args, ctx) => blocksyncPlan({ kind: 'transaction', ...args }, ctx),
  }),
];
