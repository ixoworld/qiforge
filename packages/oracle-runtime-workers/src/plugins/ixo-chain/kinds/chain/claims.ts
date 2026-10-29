/**
 * `claim_intents` and `collection_membership`: x/claims state the index
 * does not answer, read from the chain.
 */
import { z } from 'zod';
import { defineKind, type KindResult } from '../types';
import { displayCoins } from '../coins';
import { clip } from '../../summaries';
import {
  COLLECTION_ID,
  accountFor,
  addressArg,
  coinsOr,
  coinsSchema,
  durationText,
  failed,
  firstArg,
  isPast,
} from './shared';

const pagination = z.object({ next_key: z.string().nullish() }).nullish();
const cw20Schema = z.object({ address: z.string(), amount: z.string() });

/** cw20 amounts as shown: the token contract and its base units. */
const cw20Of = (payments: z.infer<typeof cw20Schema>[]) =>
  payments.slice(0, 5).map((payment) => ({
    contract: clip(payment.address, 80),
    amountBaseUnits: clip(payment.amount, 40),
  }));

/** A store key for `pagination.key`: its bytes base64, escaped for a query string. */
const keyParam = (key: string) => encodeURIComponent(btoa(key));

/** cw20 amounts as shown, or `empty`. */
const cw20Or = <Empty extends string>(
  payments: z.infer<typeof cw20Schema>[],
  empty: Empty,
) => (payments.length ? cw20Of(payments) : empty);

const collectionIdArg = z
  .string()
  .describe('Claim collection id, e.g. "8250".');

/* ── claim intents ────────────────────────────────────────────────────── */

/**
 * Intents read per request. x/claims keys an intent
 * `<agentAddress>/<collectionId>/<intentId>` (`IntentKeyCreate`) and lists
 * the whole store in key order, so a page that starts at the key
 * `<agent>/` (or `<agent>/<collection>/`) holds that agent's intents
 * first; the first intent of another agent (or collection) ends them.
 */
const INTENT_SCAN = 200;

const intentsResponse = z.object({
  intents: z.array(
    z.object({
      id: z.string(),
      agent_address: z.string(),
      collection_id: z.string(),
      claim_id: z.string().optional(),
      created_at: z.string().nullish(),
      expire_at: z.string().nullish(),
      status: z.string(),
      amount: coinsSchema.default([]),
      cw20_payment: z.array(cw20Schema).default([]),
      cw1155_payment: z.array(z.unknown()).default([]),
      member_address: z.string().optional(),
    }),
  ),
  pagination,
});

export const claimIntentsKind = defineKind({
  name: 'claim_intents',
  summary:
    "An agent's claim intents: payments reserved in escrow before a claim is submitted.",
  explain: [
    'A claim intent (x/claims) is an agent\'s declared plan to submit a claim in a collection: the payment it asks for (`coins`, bank coins or "none"; `cw20` tokens) is moved into the collection\'s escrow when the intent is created. `status`: active (waiting for the claim; `expiresAt` is the deadline), fulfilled (the claim was submitted, `claimId`; the escrow is paid out on approval or returned on rejection), expired (no claim in time; the escrow went back).',
    '`pastExpiry: true` = still active on chain but past its deadline: the chain expires it on its next pass. `forMember` = the team member the intent is on behalf of.',
    "The kind reads up to 200 intents starting at this account's (and collection's) first one; `matched` counts them, `complete: false` = there were more than 200, so the list may be missing some.",
  ].join('\n'),
  source: 'chain',
  list: true,
  args: z.strictObject({
    address: addressArg,
    collectionId: collectionIdArg.optional(),
    first: firstArg,
  }),
  example: {},
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    const { collectionId } = input;
    if (collectionId !== undefined && !COLLECTION_ID.test(collectionId))
      return { invalid: 'collectionId must be a number such as "8250".' };
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const start = `${account.address}/${collectionId === undefined ? '' : `${collectionId}/`}`;
        const read = await ctx.rest(
          `/ixo/claims/intents?pagination.key=${keyParam(start)}&pagination.limit=${INTENT_SCAN}`,
          intentsResponse,
          { label: 'claim intents' },
        );
        if (!read.ok) return failed(read.failure);
        const { intents: page, pagination: paging } = read.value;
        const theirs = (intent: (typeof page)[number]) =>
          intent.agent_address === account.address &&
          (collectionId === undefined || intent.collection_id === collectionId);
        const end = page.findIndex((intent) => !theirs(intent));
        const mine = end < 0 ? page : page.slice(0, end);
        const intents = await Promise.all(
          mine.slice(0, ctx.first).map(async (intent) => {
            const status = intent.status.toLowerCase();
            return {
              id: clip(intent.id, 40),
              collectionId: clip(intent.collection_id, 20),
              status: clip(status, 20),
              coins: await coinsOr(ctx, intent.amount, 'none'),
              ...(intent.cw20_payment.length
                ? { cw20: cw20Of(intent.cw20_payment) }
                : {}),
              ...(intent.cw1155_payment.length
                ? { cw1155Payments: intent.cw1155_payment.length }
                : {}),
              createdAt: intent.created_at ?? null,
              expiresAt: intent.expire_at ?? null,
              ...(status === 'active' &&
              intent.expire_at &&
              isPast(intent.expire_at)
                ? { pastExpiry: true }
                : {}),
              ...(intent.claim_id
                ? { claimId: clip(intent.claim_id, 120) }
                : {}),
              ...(intent.member_address
                ? { forMember: clip(intent.member_address, 80) }
                : {}),
            };
          }),
        );
        return {
          ok: true,
          subject: account.subject,
          first: ctx.first,
          data: {
            address: account.address,
            ...(collectionId !== undefined ? { collectionId } : {}),
            intents,
            matched: mine.length,
            // Another agent's intent ended the account's, or the store did.
            complete: end >= 0 || !paging?.next_key,
          },
        };
      },
    };
  },
});

/* ── collection membership ────────────────────────────────────────────── */

const memberBudget = z.object({
  member_address: z.string(),
  period: z.string(),
  period_spend_limit: coinsSchema.default([]),
  period_spent: coinsSchema.default([]),
  period_cw20_spend_limit: z.array(cw20Schema).default([]),
  period_cw20_spent: z.array(cw20Schema).default([]),
  period_reset_at: z.string().nullish(),
});
const depositBalance = z.object({
  agent_address: z.string(),
  amount: coinsSchema.default([]),
  withdrawable_at: z.string().nullish(),
});
const membersResponse = z.object({
  member_budgets: z.array(memberBudget),
  pagination,
});
const depositsResponse = z.object({
  balances: z.array(depositBalance),
  pagination,
});

/**
 * The list page that starts at `address`. x/claims keys member budgets
 * and deposits by `<collection>/<address>` and lists one collection's
 * under the `<collection>/` prefix, so a page keyed at the address holds
 * that account's record first if it exists. The point routes answer HTTP
 * 500 for an absent record, which `ctx.rest` cannot tell from a fault.
 */
const fromAddress = (address: string) =>
  `pagination.key=${encodeURIComponent(btoa(address))}&pagination.limit=1`;

export const collectionMembershipKind = defineKind({
  name: 'collection_membership',
  summary:
    "An account's team-member budget and performance deposit in one claim collection.",
  explain: [
    '`member: true` = the account is a team member of the collection with a spending budget (x/claims member budget): it may reserve up to `budget.spendLimit` per `budget.period` for claim intents (`budget.spent` so far this period, "none" = nothing yet; reset at `budget.resetAt`; `resetDue` = that time has passed and the budget refills on the next use). "none allowed" = the budget allows no spending of that kind (bank coins, or cw20 tokens: `cw20SpendLimit`, `cw20Spent`). `member: false` = no member budget here (an agent may still submit claims through an authz grant: see `authz_grants`).',
    "`deposit` = the agent's performance deposit held in the collection's escrow (null = none), as `coin` (or `coins` when it holds several denoms): it can be slashed when a dispute against the agent is lost. `lockEnded: true` = its lock (`withdrawableAt`, null = none) is over, so it can be withdrawn unless a dispute against the agent is still open.",
    'Amounts are display units (`amount` + `symbol`) with `amountBaseUnits`; cw20 amounts are base units of the token contract.',
  ].join('\n'),
  source: 'chain',
  list: false,
  args: z.strictObject({ collectionId: collectionIdArg, address: addressArg }),
  example: { collectionId: '8250' },
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    const { collectionId } = input;
    if (!COLLECTION_ID.test(collectionId))
      return { invalid: 'collectionId must be a number such as "8250".' };
    const base = `/ixo/claims/collection/${collectionId}`;
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const [members, deposits] = await Promise.all([
          ctx.rest(
            `${base}/members?${fromAddress(account.address)}`,
            membersResponse,
            { label: 'collection member budget' },
          ),
          ctx.rest(
            `${base}/deposits?${fromAddress(account.address)}`,
            depositsResponse,
            { label: 'collection deposit' },
          ),
        ]);
        if (!members.ok) return failed(members.failure);
        if (!deposits.ok) return failed(deposits.failure);
        const budget = members.value.member_budgets.find(
          (entry) => entry.member_address === account.address,
        );
        const deposit = deposits.value.balances.find(
          (entry) => entry.agent_address === account.address,
        );
        const withdrawableAt = deposit?.withdrawable_at ?? null;
        // A drained deposit is removed from the store: an empty one is none.
        const held = deposit ? await displayCoins(ctx, deposit.amount) : [];
        return {
          ok: true,
          subject: account.subject,
          data: {
            address: account.address,
            collectionId,
            member: !!budget,
            ...(budget
              ? {
                  budget: {
                    period: durationText(budget.period),
                    // The intent handler lets a member spend only what the
                    // limit lists: an empty limit allows nothing.
                    spendLimit: await coinsOr(
                      ctx,
                      budget.period_spend_limit,
                      'none allowed',
                    ),
                    spent: await coinsOr(ctx, budget.period_spent, 'none'),
                    cw20SpendLimit: cw20Or(
                      budget.period_cw20_spend_limit,
                      'none allowed',
                    ),
                    cw20Spent: cw20Or(budget.period_cw20_spent, 'none'),
                    resetAt: budget.period_reset_at ?? null,
                    ...(budget.period_reset_at && isPast(budget.period_reset_at)
                      ? { resetDue: true }
                      : {}),
                  },
                }
              : {}),
            deposit: held.length
              ? {
                  ...(held.length === 1 && held[0]
                    ? { coin: held[0] }
                    : { coins: held }),
                  withdrawableAt,
                  lockEnded: withdrawableAt === null || isPast(withdrawableAt),
                }
              : null,
          },
        };
      },
    };
  },
});
