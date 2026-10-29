/**
 * `fee_grants` and `authz_grants`: x/feegrant allowances and x/authz
 * grants an account received or gave, each with a plain label of what it
 * allows. One REST read per (kind, direction, account) of
 * {@link GRANT_PAGE} rows, kept per isolate for {@link GRANTS_TTL_MS}
 * (shared by calls asking the same at once); the total is never counted
 * (`count_total` makes the node walk every match). An empty amount list is
 * shown by what the chain does with it: "unlimited", "any" or "none
 * allowed", never as an empty list.
 */
import { z } from 'zod';
import type { ChainCall } from '../../http';
import { defineKind, type KindContext, type KindResult } from '../types';
import { displayCoin, displayCoins, type DisplayCoin } from '../coins';
import { clip } from '../../summaries';
import {
  ReadCache,
  accountFor,
  coinsOr,
  addressArg,
  coinSchema,
  coinsSchema,
  directionArg,
  durationText,
  expiryOf,
  failed,
  firstArg,
  isPast,
  listText,
  setDuration,
  shortType,
} from './shared';

/**
 * Granters named by who runs them, per network. Mainnet
 * `ixo1vafr2…tey6` is the IXO fee-grant service behind feegrant.ixo.world:
 * on Oct 29 2026 it had issued 15,573 allowances, among them the fee
 * grants of the pay-convert oracle setup's jambo and oracle accounts.
 */
export const KNOWN_GRANTERS: Record<
  ChainCall['network'],
  Readonly<Record<string, string>>
> = {
  mainnet: {
    ixo1vafr2dqhgz8frc7gf22njz8y2u0fue4kuetey6:
      'IXO fee-grant service (feegrant.ixo.world)',
  },
  testnet: {},
  devnet: {},
};

/** Messages named per allowance or authorization; the rest are counted. */
const NAMED_MESSAGES = 10;
/** Constraints shown per claims authorization; the rest are counted. */
const CONSTRAINT_CAP = 5;
/** Grants read per request: the most rows a request may ask for. */
const GRANT_PAGE = 20;
/** A grants answer is reused for 30 s. */
export const GRANTS_TTL_MS = 30_000;
/** Answers kept per grant kind. */
const GRANTS_CACHE_LIMIT = 500;

const args = z.strictObject({
  direction: directionArg,
  address: addressArg,
  first: firstArg,
});

const pagination = z.object({ next_key: z.string().nullish() }).nullish();

const anyTyped = z.looseObject({ '@type': z.string() });

/** The paging every grants read asks for. */
const PAGE = `pagination.limit=${GRANT_PAGE}`;

/** Whether rows exist past the first `first` of a page. */
const moreThan = (
  rows: readonly unknown[],
  value: z.infer<typeof pagination>,
  first: number,
) => rows.length > first || !!value?.next_key;

/* ── fee grants ───────────────────────────────────────────────────────── */

const allowancesResponse = z.object({
  allowances: z.array(
    z.object({ granter: z.string(), grantee: z.string(), allowance: anyTyped }),
  ),
  pagination,
});

const BASIC = '/cosmos.feegrant.v1beta1.BasicAllowance';
const PERIODIC = '/cosmos.feegrant.v1beta1.PeriodicAllowance';
const ALLOWED_MSG = '/cosmos.feegrant.v1beta1.AllowedMsgAllowance';

const basicAllowance = z.object({
  spend_limit: coinsSchema.default([]),
  expiration: z.string().nullish(),
});
const periodicAllowance = z.object({
  basic: basicAllowance,
  period: z.string(),
  period_spend_limit: coinsSchema.default([]),
  period_can_spend: coinsSchema.default([]),
  period_reset: z.string().nullish(),
});
const allowedMsgAllowance = z.object({
  allowance: anyTyped,
  allowed_messages: z.array(z.string()).default([]),
});

const feeGrantAnswers = new ReadCache<z.infer<typeof allowancesResponse>>(
  GRANTS_TTL_MS,
  GRANTS_CACHE_LIMIT,
);

const ALLOWANCE_LABEL: Record<string, string> = {
  BasicAllowance: 'one budget until it expires',
  PeriodicAllowance: 'refills every period',
  AllowedMsgAllowance: 'only for listed actions',
};
const OTHER_ALLOWANCE = 'an allowance type this reader does not know';

/** A coin limit, or what the chain does when the list is empty. */
type Limit<Empty extends string> = DisplayCoin[] | Empty;

type AllowanceTerms = {
  spendLimit: Limit<'unlimited'>;
  period?: {
    every: string;
    limit: Limit<'none allowed'>;
    canSpendThisPeriod: { coins: DisplayCoin[]; nothingLeftThisPeriod?: true };
    resetAt: string | null;
    /** The reset time has passed: the full period limit is available on the next use. */
    resetDue?: true;
  };
  expiration: string | null;
  expired: boolean;
};

/** The terms of a Basic or Periodic allowance; null for any other type. */
async function termsOf(
  ctx: KindContext,
  allowance: z.infer<typeof anyTyped>,
): Promise<AllowanceTerms | null> {
  if (allowance['@type'] === BASIC) {
    const basic = basicAllowance.safeParse(allowance);
    if (!basic.success) return null;
    return {
      spendLimit: await coinsOr(ctx, basic.data.spend_limit, 'unlimited'),
      ...expiryOf(basic.data.expiration),
    };
  }
  if (allowance['@type'] === PERIODIC) {
    const periodic = periodicAllowance.safeParse(allowance);
    if (!periodic.success) return null;
    const { basic, period, period_reset: reset } = periodic.data;
    // x/feegrant subtracts each fee from `period_can_spend`: an empty list
    // is nothing left until the reset; the period limit refills it then
    // (an empty one, which ValidateBasic refuses, would refill nothing).
    const left = await displayCoins(ctx, periodic.data.period_can_spend);
    return {
      spendLimit: await coinsOr(ctx, basic.spend_limit, 'unlimited'),
      period: {
        every: durationText(period),
        limit: await coinsOr(
          ctx,
          periodic.data.period_spend_limit,
          'none allowed',
        ),
        canSpendThisPeriod: left.length
          ? { coins: left }
          : { coins: [], nothingLeftThisPeriod: true },
        resetAt: reset ?? null,
        ...(reset && isPast(reset) ? { resetDue: true } : {}),
      },
      ...expiryOf(basic.expiration),
    };
  }
  return null;
}

async function feeGrantOf(
  ctx: KindContext,
  grant: z.infer<typeof allowancesResponse>['allowances'][number],
): Promise<Record<string, unknown>> {
  const label = KNOWN_GRANTERS[ctx.call.network][grant.granter];
  const head = {
    granter: grant.granter,
    ...(label ? { granterLabel: label } : {}),
    grantee: grant.grantee,
  };
  const type = shortType(grant.allowance['@type']);
  if (grant.allowance['@type'] === ALLOWED_MSG) {
    const wrapper = allowedMsgAllowance.safeParse(grant.allowance);
    if (wrapper.success) {
      const messages = wrapper.data.allowed_messages.map(shortType);
      const inner = shortType(wrapper.data.allowance['@type']);
      const terms = await termsOf(ctx, wrapper.data.allowance);
      return {
        ...head,
        type,
        innerType: inner,
        kindLabel: `${ALLOWANCE_LABEL.AllowedMsgAllowance}; ${ALLOWANCE_LABEL[inner] ?? OTHER_ALLOWANCE}`,
        allowedMessages: messages.slice(0, NAMED_MESSAGES),
        ...(messages.length > NAMED_MESSAGES
          ? { moreAllowedMessages: messages.length - NAMED_MESSAGES }
          : {}),
        ...(terms ?? { expiration: null, expired: false }),
      };
    }
  }
  const terms = await termsOf(ctx, grant.allowance);
  return {
    ...head,
    type,
    kindLabel: (terms && ALLOWANCE_LABEL[type]) || OTHER_ALLOWANCE,
    ...(terms ?? { expiration: null, expired: false }),
  };
}

export const feeGrantsKind = defineKind({
  name: 'fee_grants',
  summary:
    "Fee grants an account received (someone pays its fees) or gave (it pays others').",
  explain: [
    "A fee grant (x/feegrant) lets the granter pay the grantee's transaction fees, within limits. It never gives the granter access to the grantee's funds or lets anyone act for the grantee: the grantee still signs every transaction, only the fee is taken from the granter.",
    'Allowance types: BasicAllowance = one budget (`spendLimit`, "unlimited" when none is set) until it expires. PeriodicAllowance = refills every `period.every`: at most `period.limit` per period, `period.canSpendThisPeriod.coins` left now (`nothingLeftThisPeriod: true` = all of it is used until the reset), reset at `period.resetAt` (`resetDue`: the reset time has passed, so the full period limit is available again on the next use), all within the overall `spendLimit`. AllowedMsgAllowance = only for the listed actions (`allowedMessages`); its inner allowance (`innerType`) sets the budget and expiry, shown unwrapped.',
    "`expiration` null = no expiry; `expired: true` = the grant can no longer be used. A granter can revoke a grant at any time and cannot change the grantee's account in any way.",
    "`granterLabel` names a known granter (mainnet: the IXO fee-grant service, feegrant.ixo.world). `direction`: received = grants paying this account's fees; given = grants this account pays. `more` says rows were left out (there is no total count). Amounts are display units (`amount` + `symbol`) with `amountBaseUnits`.",
  ].join('\n'),
  source: 'chain',
  list: true,
  args,
  example: { direction: 'received' },
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    const direction = input.direction ?? 'received';
    const route = direction === 'received' ? 'allowances' : 'issued';
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const read = await feeGrantAnswers.get(
          ctx,
          `${direction}|${account.address}`,
          () =>
            ctx.rest(
              `/cosmos/feegrant/v1beta1/${route}/${account.address}?${PAGE}`,
              allowancesResponse,
              { label: `fee grants ${direction}` },
            ),
        );
        if (!read.ok) return failed(read.failure);
        const { allowances, pagination: paging } = read.value;
        const grants = await Promise.all(
          allowances.slice(0, ctx.first).map((grant) => feeGrantOf(ctx, grant)),
        );
        return {
          ok: true,
          subject: account.subject,
          first: ctx.first,
          data: {
            address: account.address,
            direction,
            more: moreThan(allowances, paging, ctx.first),
            grants,
          },
        };
      },
    };
  },
});

/* ── authz grants ─────────────────────────────────────────────────────── */

const grantsResponse = z.object({
  grants: z.array(
    z.object({
      granter: z.string(),
      grantee: z.string(),
      authorization: anyTyped,
      expiration: z.string().nullish(),
    }),
  ),
  pagination,
});

const authzAnswers = new ReadCache<z.infer<typeof grantsResponse>>(
  GRANTS_TTL_MS,
  GRANTS_CACHE_LIMIT,
);

const cw20Schema = z.object({ address: z.string(), amount: z.string() });
/** x/claims `CW1155Payment`: a contract, its token ids (none = any) and an amount in whole tokens. */
const cw1155Schema = z.object({
  address: z.string(),
  token_id: z.array(z.string()).default([]),
  amount: z.string(),
});
const cw20List = z.array(cw20Schema).default([]);
const cw1155List = z.array(cw1155Schema).default([]);
const quota = z.string().optional();
const genericAuthorization = z.object({ msg: z.string() });
const sendAuthorization = z.object({
  spend_limit: coinsSchema.default([]),
  allow_list: z.array(z.string()).default([]),
});
const validators = z.object({ address: z.array(z.string()).default([]) });
const stakeAuthorization = z.object({
  max_tokens: coinSchema.nullish(),
  allow_list: validators.nullish(),
  deny_list: validators.nullish(),
  authorization_type: z.string(),
});
const submitClaimAuthorization = z.object({
  admin: z.string(),
  constraints: z.array(
    z.object({
      collection_id: z.string(),
      agent_quota: z.string(),
      max_amount: coinsSchema.default([]),
      max_cw20_payment: cw20List,
      max_cw1155_payment: cw1155List,
      intent_duration_ns: z.string().nullish(),
      member_address: z.string().optional(),
    }),
  ),
});
const evaluateClaimAuthorization = z.object({
  admin: z.string(),
  constraints: z.array(
    z.object({
      collection_id: z.string(),
      claim_ids: z.array(z.string()).default([]),
      agent_quota: z.string(),
      before_date: z.string().nullish(),
      max_custom_amount: coinsSchema.default([]),
      max_custom_cw20_payment: cw20List,
      max_custom_cw1155_payment: cw1155List,
    }),
  ),
});
const withdrawPaymentAuthorization = z.object({
  admin: z.string(),
  constraints: z.array(
    z.object({
      claim_id: z.string(),
      payment_type: z.string().optional(),
      release_date: z.string().nullish(),
      toAddress: z.string().optional(),
    }),
  ),
});
const createClaimAuthorizationAuthorization = z.object({
  admin: z.string(),
  constraints: z.array(
    z.object({
      max_authorizations: quota,
      max_agent_quota: quota,
      max_amount: coinsSchema.default([]),
      max_cw20_payment: cw20List,
      expiration: z.string().nullish(),
      collection_ids: z.array(z.string()).default([]),
      allowed_auth_types: z.string().optional(),
      max_intent_duration_ns: z.string().nullish(),
      max_cw1155_payment: cw1155List,
      member_address: z.string().optional(),
    }),
  ),
});

const STAKE_ACTION: Record<string, string> = {
  AUTHORIZATION_TYPE_DELEGATE: 'delegate',
  AUTHORIZATION_TYPE_UNDELEGATE: 'undelegate',
  AUTHORIZATION_TYPE_REDELEGATE: 'redelegate',
  AUTHORIZATION_TYPE_CANCEL_UNBONDING_DELEGATION: 'cancel unbonding',
};

/** x/claims `CreateClaimAuthorizationType`. */
const CREATE_TYPES: Record<string, string> = {
  ALL: 'submit and evaluate',
  SUBMIT: 'submit',
  EVALUATE: 'evaluate',
};

/** "collection 340" / "collections 340, 341" / the fallback for none. */
function collectionsText(ids: readonly string[], none: string): string {
  if (!ids.length) return none;
  return `${ids.length === 1 ? 'collection' : 'collections'} ${listText(ids.map((id) => clip(id, 20)))}`;
}

/** A meta-authorization's cap: 0 means none is set. */
const quotaText = (value: string | undefined) =>
  value === undefined || value === '0' ? 'no cap' : value;

/** At most {@link CONSTRAINT_CAP} constraints shaped, with how many were left out. */
async function constraintsOf<T>(
  list: readonly T[],
  shape: (item: T) => Promise<Record<string, unknown>>,
): Promise<{
  constraints: Record<string, unknown>[];
  moreConstraints?: number;
}> {
  return {
    constraints: await Promise.all(list.slice(0, CONSTRAINT_CAP).map(shape)),
    ...(list.length > CONSTRAINT_CAP
      ? { moreConstraints: list.length - CONSTRAINT_CAP }
      : {}),
  };
}

/** `{ [key]: value }` when there is a value, else nothing. */
const optional = (key: string, value: string | null) =>
  value === null ? {} : { [key]: value };

/** Token caps shown per list. */
const CAP_ROWS = 5;
const TOKEN_IDS = 5;

/** cw20 caps as shown (the token contract and its base units), or `empty`. */
function cw20Of<Empty extends string>(
  caps: z.infer<typeof cw20Schema>[],
  empty: Empty,
) {
  return caps.length
    ? caps.slice(0, CAP_ROWS).map((cap) => ({
        contract: clip(cap.address, 80),
        amountBaseUnits: clip(cap.amount, 40),
      }))
    : empty;
}

/**
 * cw1155 caps as shown (the token contract, its token ids or "any", and
 * the amount in whole tokens), or `empty`.
 */
function cw1155Of<Empty extends string>(
  caps: z.infer<typeof cw1155Schema>[],
  empty: Empty,
) {
  return caps.length
    ? caps.slice(0, CAP_ROWS).map((cap) => ({
        contract: clip(cap.address, 80),
        tokenIds: cap.token_id.length
          ? cap.token_id.slice(0, TOKEN_IDS).map((id) => clip(id, 80))
          : 'any',
        ...(cap.token_id.length > TOKEN_IDS
          ? { moreTokenIds: cap.token_id.length - TOKEN_IDS }
          : {}),
        amount: clip(cap.amount, 40),
      }))
    : empty;
}

/** What a Submit or Evaluate constraint's empty caps mean: no custom payment of that kind. */
const NONE = 'none allowed';
/** What a CreateClaimAuthorization constraint's empty caps mean: the authorizations it creates may set any. */
const ANY = 'any';

/** What an authorization lets the grantee do: its short type, label and limits. */
async function authorizationOf(
  ctx: KindContext,
  authorization: z.infer<typeof anyTyped>,
): Promise<Record<string, unknown>> {
  const type = shortType(authorization['@type']);
  const unknown = {
    type,
    kindLabel: `may act for the granter as ${type} allows (a type this reader does not know)`,
  };
  switch (authorization['@type']) {
    case '/cosmos.authz.v1beta1.GenericAuthorization': {
      const parsed = genericAuthorization.safeParse(authorization);
      if (!parsed.success) return unknown;
      const message = shortType(parsed.data.msg);
      return {
        type,
        message,
        kindLabel: `may send ${message} for the granter`,
      };
    }
    case '/cosmos.bank.v1beta1.SendAuthorization': {
      const parsed = sendAuthorization.safeParse(authorization);
      if (!parsed.success) return unknown;
      // ValidateBasic requires a positive limit; an empty one would let
      // nothing be sent.
      const limit = await coinsOr(ctx, parsed.data.spend_limit, NONE);
      const allowList = parsed.data.allow_list;
      return {
        type,
        kindLabel:
          limit === NONE
            ? 'may send nothing from the granter'
            : `may send up to ${limit.map((coin) => `${coin.amount} ${coin.symbol}`).join(' + ')} from the granter`,
        spendLimit: limit,
        ...(allowList.length
          ? { onlyTo: allowList.slice(0, 5).map((a) => clip(a, 80)) }
          : {}),
      };
    }
    case '/cosmos.staking.v1beta1.StakeAuthorization': {
      const parsed = stakeAuthorization.safeParse(authorization);
      if (!parsed.success) return unknown;
      const action = STAKE_ACTION[parsed.data.authorization_type] ?? 'stake';
      const max = parsed.data.max_tokens
        ? await displayCoin(ctx, parsed.data.max_tokens)
        : null;
      const allow = parsed.data.allow_list?.address ?? [];
      const deny = parsed.data.deny_list?.address ?? [];
      return {
        type,
        kindLabel: `may ${action} the granter's stake${max ? ` (up to ${max.amount} ${max.symbol})` : ''}`,
        maxTokens: max ?? 'unlimited',
        ...(allow.length ? { onlyValidators: allow.slice(0, 5) } : {}),
        ...(deny.length ? { exceptValidators: deny.slice(0, 5) } : {}),
      };
    }
    case '/ixo.claims.v1beta1.SubmitClaimAuthorization': {
      const parsed = submitClaimAuthorization.safeParse(authorization);
      if (!parsed.success) return unknown;
      const { constraints } = parsed.data;
      return {
        type,
        kindLabel: `may submit claims in ${collectionsText(
          constraints.map((c) => c.collection_id),
          'no collection',
        )}`,
        admin: parsed.data.admin,
        ...(await constraintsOf(constraints, async (c) => ({
          collectionId: clip(c.collection_id, 20),
          claimsLeft: c.agent_quota,
          maxAmount: await coinsOr(ctx, c.max_amount, NONE),
          maxCw20: cw20Of(c.max_cw20_payment, NONE),
          maxCw1155: cw1155Of(c.max_cw1155_payment, NONE),
          ...optional('intentDuration', setDuration(c.intent_duration_ns)),
          ...(c.member_address ? { forMember: c.member_address } : {}),
        }))),
      };
    }
    case '/ixo.claims.v1beta1.EvaluateClaimAuthorization': {
      const parsed = evaluateClaimAuthorization.safeParse(authorization);
      if (!parsed.success) return unknown;
      const { constraints } = parsed.data;
      return {
        type,
        kindLabel: `may evaluate claims in ${collectionsText(
          constraints.map((c) => c.collection_id),
          'no collection',
        )}`,
        admin: parsed.data.admin,
        ...(await constraintsOf(constraints, async (c) => ({
          collectionId: clip(c.collection_id, 20),
          evaluationsLeft: c.agent_quota,
          ...(c.claim_ids.length ? { onlyClaims: c.claim_ids.length } : {}),
          ...(c.before_date ? { before: c.before_date } : {}),
          maxCustomAmount: await coinsOr(ctx, c.max_custom_amount, NONE),
          maxCustomCw20: cw20Of(c.max_custom_cw20_payment, NONE),
          maxCustomCw1155: cw1155Of(c.max_custom_cw1155_payment, NONE),
        }))),
      };
    }
    case '/ixo.claims.v1beta1.WithdrawPaymentAuthorization': {
      const parsed = withdrawPaymentAuthorization.safeParse(authorization);
      if (!parsed.success) return unknown;
      const { constraints } = parsed.data;
      return {
        type,
        kindLabel: `may withdraw payments for ${constraints.length} ${constraints.length === 1 ? 'claim' : 'claims'}`,
        admin: parsed.data.admin,
        ...(await constraintsOf(constraints, async (c) => ({
          claimId: clip(c.claim_id, 120),
          ...(c.payment_type
            ? { paymentType: c.payment_type.toLowerCase() }
            : {}),
          ...(c.release_date ? { releasesAt: c.release_date } : {}),
          ...(c.toAddress ? { to: clip(c.toAddress, 80) } : {}),
        }))),
      };
    }
    case '/ixo.claims.v1beta1.CreateClaimAuthorizationAuthorization': {
      const parsed =
        createClaimAuthorizationAuthorization.safeParse(authorization);
      if (!parsed.success) return unknown;
      const { constraints } = parsed.data;
      const kinds = [
        ...new Set(
          constraints.map(
            (c) => CREATE_TYPES[c.allowed_auth_types ?? 'ALL'] ?? 'claim',
          ),
        ),
      ];
      const ids = constraints.flatMap((c) => c.collection_ids);
      const anyCollection = constraints.some((c) => !c.collection_ids.length);
      return {
        type,
        kindLabel: `may create ${kinds.join(' / ')} authorizations in ${
          anyCollection
            ? "any of the admin's collections"
            : collectionsText(ids, 'no collection')
        }`,
        admin: parsed.data.admin,
        ...(await constraintsOf(constraints, async (c) => ({
          collections: c.collection_ids.length
            ? c.collection_ids.slice(0, 10).map((id) => clip(id, 20))
            : "all of the admin's",
          creates: CREATE_TYPES[c.allowed_auth_types ?? 'ALL'] ?? 'claim',
          maxAuthorizations: quotaText(c.max_authorizations),
          maxAgentQuota: quotaText(c.max_agent_quota),
          maxAmount: await coinsOr(ctx, c.max_amount, ANY),
          maxCw20: cw20Of(c.max_cw20_payment, ANY),
          maxCw1155: cw1155Of(c.max_cw1155_payment, ANY),
          ...optional(
            'maxIntentDuration',
            setDuration(c.max_intent_duration_ns),
          ),
          ...expiryOf(c.expiration),
          ...(c.member_address ? { forMember: c.member_address } : {}),
        }))),
      };
    }
    default:
      return unknown;
  }
}

export const authzGrantsKind = defineKind({
  name: 'authz_grants',
  summary:
    'Authz grants: who may act for an account (given) or for whom it may act (received).',
  explain: [
    "An authz grant (x/authz) lets the grantee send specific transactions on the granter's behalf, signed by the grantee and executed as the granter. `direction`: received = grants this account holds (it may act for others); given = grants this account made, i.e. WHO CAN ACT FOR IT — check these when the question is about account safety. The granter can revoke a grant at any time.",
    'Types (`type`, `kindLabel`): GenericAuthorization = may send that one message type (`message`) for the granter, with no limit. SendAuthorization = may send up to `spendLimit` from the granter (`onlyTo` restricts recipients). StakeAuthorization = may delegate / undelegate / redelegate the granter\'s stake (up to `maxTokens`, "unlimited" when none is set; `onlyValidators` / `exceptValidators`).',
    'IXO claims authorizations (granted by a collection\'s admin account, `admin`): SubmitClaimAuthorization = may submit claims in the listed collections (`claimsLeft` claims, each intent valid for `intentDuration`) asking a custom payment of at most `maxAmount` (bank coins), `maxCw20` and `maxCw1155`. EvaluateClaimAuthorization = may evaluate (approve/reject) claims there (`evaluationsLeft`, `before` a date) and set a custom payment of at most `maxCustomAmount`, `maxCustomCw20` and `maxCustomCw1155`. On both, "none allowed" = no custom payment of that kind: the collection\'s own payments apply. WithdrawPaymentAuthorization = may withdraw the payment of a claim (`paymentType`, from `releasesAt`). CreateClaimAuthorizationAuthorization = may itself create submit and/or evaluate authorizations for those collections (`maxAuthorizations`, `maxAgentQuota`; "no cap" = no limit set) whose custom payments are capped at `maxAmount`, `maxCw20` and `maxCw1155`, where "any" = the created authorizations may set any.',
    '`expiration` null = no expiry; `expired: true` = it can no longer be used. `more` says rows were left out (there is no total count). For who can act for an account through its own signing rules (passkeys, extra keys), see `smart_account`. Amounts are display units (`amount` + `symbol`) with `amountBaseUnits`; cw20 caps are base units of the token contract, cw1155 caps whole tokens of the contract (`tokenIds` "any" = any token id).',
  ].join('\n'),
  source: 'chain',
  list: true,
  args,
  example: { direction: 'given' },
  plan(input, ctx) {
    const account = accountFor(ctx, input.address);
    if ('invalid' in account) return account;
    const direction = input.direction ?? 'received';
    const role = direction === 'received' ? 'grantee' : 'granter';
    return {
      source: 'chain',
      async run(): Promise<KindResult> {
        const read = await authzAnswers.get(
          ctx,
          `${direction}|${account.address}`,
          () =>
            ctx.rest(
              `/cosmos/authz/v1beta1/grants/${role}/${account.address}?${PAGE}`,
              grantsResponse,
              { label: `authz grants ${direction}` },
            ),
        );
        if (!read.ok) return failed(read.failure);
        const { grants: all, pagination: paging } = read.value;
        const grants = await Promise.all(
          all.slice(0, ctx.first).map(async (grant) => ({
            granter: grant.granter,
            grantee: grant.grantee,
            ...(await authorizationOf(ctx, grant.authorization)),
            ...expiryOf(grant.expiration),
          })),
        );
        return {
          ok: true,
          subject: account.subject,
          first: ctx.first,
          data: {
            address: account.address,
            direction,
            more: moreThan(all, paging, ctx.first),
            grants,
          },
        };
      },
    };
  },
});
