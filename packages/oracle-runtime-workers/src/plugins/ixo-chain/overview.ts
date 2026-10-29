/**
 * `get_account_overview`: one call for "tell me about my account". Each
 * section is answered by existing kinds (balances by the read
 * `get_account_balances` makes), all asked in ONE `runRequests` call: the
 * Blocksync-backed parts as one GraphQL document, every chain REST read
 * and denom lookup under the call's limits, inside the shared 20 s
 * budget. Parts that need the same data read it once: the DAO section's
 * DAOs and open proposals share one membership read. Each section answers
 * on its own: its counts and top rows, with the request that reads the
 * rest, or why it failed. The answer is cut to {@link MAX_RESULT_CHARS},
 * top rows first, and an answer without any failure is kept per isolate
 * for {@link OVERVIEW_TTL_MS}.
 */
import { z } from 'zod';
import type { UserIdentity } from '../../core/user-identity';
import { balancesKind } from './balances';
import {
  hasBudget,
  throwIfAborted,
  tooLarge,
  untilAborted,
  type ChainCall,
  type Failure,
  type Outcome,
} from './http';
import { claimsPage } from './kinds/core';
import { daosWithOpenProposals } from './kinds/indexed/dao-proposals';
import { kindByName } from './kinds/registry';
import type { KindContext, KindDef, KindRestOptions } from './kinds/types';
import {
  MAX_RESULT_CHARS,
  runRequests,
  type KindRequest,
  type LookupOptions,
  type LookupResult,
} from './lookup';
import { accountOf, type Subject } from './queries';
import type { Absent } from './rest';
import { isRecord } from './summaries';

const sectionSchema = z.enum([
  'balances',
  'fee_grants',
  'authz',
  'smart_account',
  'account',
  'staking',
  'liquid_staking',
  'claims',
  'governance',
  'daos',
]);
export type Section = z.infer<typeof sectionSchema>;
/** Every section, in the order the answer lists them. */
export const SECTIONS = sectionSchema.options;

// `address` is bounded by `accountOf`'s patterns, not by a length cap here.
export const overviewSchema = z.strictObject({
  address: z.string().optional().describe('ixo1… or did:ixo:ixo1…'),
  sections: z.array(sectionSchema).min(1).max(SECTIONS.length).optional(),
});

/** Rows a section shows, and rows each of its list parts reads. */
const TOP_ROWS = 3;
/** An answer is reused for 20 s by every call of the isolate that asks the same. */
export const OVERVIEW_TTL_MS = 20_000;
export const OVERVIEW_CACHE_LIMIT = 200;

/* ── sections ─────────────────────────────────────────────────────────── */

/** A count of rows: a number, or `"N+"` when there are more than the N read. */
type Count = number | string;
const countOf = (rows: number, more: boolean): Count =>
  more ? `${rows}+` : rows;

/** What one part's answer holds: its rows, how many there are, and whether more exist than were read. */
interface Rows {
  rows: unknown[];
  /** Left out of the section's counts when the rows are one record. */
  count?: Count;
  more: boolean;
}

/** What a section adds besides its rows' counts. */
interface Extra {
  counts?: Record<string, Count>;
  totals?: Record<string, unknown>;
}

interface Part {
  /** The name of the part's rows: a key of `counts`, and each top row's `list` in a section of several parts. */
  list: string;
  /** The kind `more` and a failure name. */
  kind: KindDef;
  /** The kind's arguments besides the account. */
  args: Record<string, unknown>;
  /**
   * The read that answers the part when it is not `kind` itself, with its
   * arguments besides the account and the part's data in its answer. Parts
   * naming the same read share one request.
   */
  via?: {
    read: KindDef;
    args: Record<string, unknown>;
    pick?(data: unknown): unknown;
  };
  /** The kind's argument naming the account. */
  account: 'address' | 'agent' | 'voter';
  /** Rows the part reads (list kinds): the section's top rows. */
  first?: number;
  /** The rows and counts in the kind's answer; null when it is not the shape the kind answers. */
  read(data: unknown): Rows | null;
  extra?(data: unknown): Extra;
  /** The tool that reads the rest, when it is not `chain_lookup` with this kind. */
  tool?: 'get_account_balances';
}

function kind(name: string): KindDef {
  const found = kindByName(name);
  if (!found) throw new Error(`ixo-chain: the overview needs kind "${name}"`);
  return found;
}

/** `read` over `schema`: null when `data` is not that shape. */
function shaped<S extends z.ZodType>(
  schema: S,
  read: (value: z.infer<S>) => Rows,
): (data: unknown) => Rows | null {
  return (data) => {
    const parsed = schema.safeParse(data);
    return parsed.success ? read(parsed.data) : null;
  };
}

const rows = z.array(z.unknown());
/** `data[key]` of a combined answer. */
const pick = (key: string) => (data: unknown) =>
  isRecord(data) ? data[key] : undefined;
/** The fee and authz grant kinds' answer (no total: `more` says there are more rows). */
const grants = shaped(
  z.looseObject({ more: z.boolean(), grants: rows }),
  (value) => ({
    rows: value.grants,
    count: countOf(value.grants.length, value.more),
    more: value.more,
  }),
);
/** An indexed list kind's answer: `items` and `more`. */
const items = shaped(
  z.looseObject({ items: rows, more: z.boolean().optional() }),
  (value) => ({
    rows: value.items,
    count: countOf(value.items.length, value.more === true),
    more: value.more === true,
  }),
);
/** Rows that say their account has not voted on a proposal still in its voting time. */
const notVoted = (list: unknown[]) =>
  list.filter(
    (row) => isRecord(row) && row.notVoted === true && row.votingEnded !== true,
  ).length;

const fee = kind('fee_grants');
const authz = kind('authz_grants');
const liquidStaking = kind('liquid_staking');
const daoProposals = kind('dao_proposals');

const PARTS: Record<Section, readonly Part[]> = {
  balances: [
    {
      list: 'tokens',
      kind: balancesKind,
      args: {},
      account: 'address',
      tool: 'get_account_balances',
      read: shaped(
        z.looseObject({ tokens: rows, moreDenoms: z.boolean() }),
        (value) => ({
          rows: value.tokens,
          count: countOf(value.tokens.length, value.moreDenoms),
          more: value.moreDenoms,
        }),
      ),
    },
  ],
  // Fee grants given are left out: the chain finds them by scanning every
  // fee grant (see `NOT_READ`).
  fee_grants: [
    {
      list: 'received',
      kind: fee,
      args: { direction: 'received' },
      account: 'address',
      first: TOP_ROWS,
      read: grants,
    },
  ],
  authz: [
    {
      list: 'received',
      kind: authz,
      args: { direction: 'received' },
      account: 'address',
      first: TOP_ROWS,
      read: grants,
    },
    {
      list: 'given',
      kind: authz,
      args: { direction: 'given' },
      account: 'address',
      first: TOP_ROWS,
      read: grants,
    },
  ],
  smart_account: [
    {
      list: 'authenticators',
      kind: kind('smart_account'),
      args: {},
      account: 'address',
      read: shaped(
        z.looseObject({
          authenticators: rows,
          moreAuthenticators: z.number().optional(),
        }),
        (value) => ({
          rows: value.authenticators,
          count: value.authenticators.length + (value.moreAuthenticators ?? 0),
          more: (value.moreAuthenticators ?? 0) > 0,
        }),
      ),
    },
  ],
  account: [
    {
      list: 'account',
      kind: kind('account'),
      args: {},
      account: 'address',
      // One record: the row, without the address the overview names.
      read: shaped(
        z.looseObject({ address: z.string(), onChain: z.boolean() }),
        (value) => {
          const record: Record<string, unknown> = { ...value };
          delete record.address;
          return { rows: [record], more: false };
        },
      ),
    },
  ],
  staking: [
    {
      list: 'delegations',
      kind: kind('staking'),
      args: {},
      account: 'address',
      read: shaped(
        z.looseObject({
          delegations: rows,
          moreDelegations: z.boolean().optional(),
        }),
        (value) => ({
          rows: value.delegations,
          count: countOf(value.delegations.length, !!value.moreDelegations),
          more: !!value.moreDelegations,
        }),
      ),
      extra(data) {
        // `rewards` is missing when its read failed (`rewardsUnavailable`).
        const parsed = z
          .looseObject({
            unbonding: rows,
            moreUnbonding: z.boolean().optional(),
            rewards: z.looseObject({ total: z.unknown() }).optional(),
            rewardsUnavailable: z.literal(true).optional(),
            totals: z.looseObject({
              delegated: z.unknown(),
              unbonding: z.unknown(),
            }),
          })
          .safeParse(data);
        if (!parsed.success) return {};
        const { unbonding, moreUnbonding, rewards, totals } = parsed.data;
        return {
          counts: { unbonding: countOf(unbonding.length, !!moreUnbonding) },
          totals: {
            delegated: totals.delegated,
            unbonding: totals.unbonding,
            ...(rewards
              ? { rewards: rewards.total }
              : { rewardsUnavailable: true }),
          },
        };
      },
    },
  ],
  liquid_staking: [
    {
      list: 'pools',
      kind: liquidStaking,
      args: {},
      account: 'address',
      read: shaped(
        z.looseObject({ pools: rows, morePools: z.boolean().optional() }),
        (value) => ({
          rows: value.pools,
          count: countOf(value.pools.length, !!value.morePools),
          more: !!value.morePools,
        }),
      ),
      extra(data) {
        const parsed = z
          .looseObject({
            pools: z.array(
              z.looseObject({
                yourBalance: z
                  .looseObject({ amountBaseUnits: z.string() })
                  .nullish(),
              }),
            ),
          })
          .safeParse(data);
        if (!parsed.success) return {};
        return {
          counts: {
            holding: parsed.data.pools.filter(
              (pool) => (pool.yourBalance?.amountBaseUnits ?? '0') !== '0',
            ).length,
          },
        };
      },
    },
  ],
  claims: [
    {
      list: 'claims',
      kind: kind('claims'),
      args: {},
      account: 'agent',
      first: TOP_ROWS,
      // Without `totalCount`: a full count of the account's claims.
      via: { read: claimsPage, args: {} },
      read: shaped(
        z.looseObject({ hasNextPage: z.boolean().optional(), items: rows }),
        (value) => ({
          rows: value.items,
          count: countOf(value.items.length, value.hasNextPage === true),
          more: value.hasNextPage === true,
        }),
      ),
    },
    {
      list: 'deposits',
      kind: kind('agent_deposits'),
      args: {},
      account: 'address',
      first: TOP_ROWS,
      read: items,
    },
    {
      list: 'budgets',
      kind: kind('member_budgets'),
      args: {},
      account: 'address',
      first: TOP_ROWS,
      read: items,
    },
  ],
  governance: [
    {
      list: 'voting',
      kind: kind('gov_proposals'),
      args: { status: 'voting' },
      account: 'voter',
      first: TOP_ROWS,
      read: shaped(
        z.looseObject({ proposals: rows, more: z.boolean() }),
        (value) => ({
          rows: value.proposals,
          count: countOf(value.proposals.length, value.more),
          more: value.more,
        }),
      ),
      extra(data) {
        const parsed = z
          .looseObject({ proposals: rows, more: z.boolean() })
          .safeParse(data);
        return parsed.success
          ? {
              counts: {
                notVoted: countOf(
                  notVoted(parsed.data.proposals),
                  parsed.data.more,
                ),
              },
            }
          : {};
      },
    },
  ],
  // Both parts from one membership read.
  daos: [
    {
      list: 'daos',
      kind: kind('daos'),
      args: {},
      account: 'address',
      first: TOP_ROWS,
      via: { read: daosWithOpenProposals, args: {}, pick: pick('daos') },
      read: items,
    },
    {
      list: 'openProposals',
      kind: daoProposals,
      args: { status: 'open' },
      account: 'address',
      first: TOP_ROWS,
      via: {
        read: daosWithOpenProposals,
        args: {},
        pick: pick('proposals'),
      },
      read: items,
      extra(data) {
        const parsed = z
          .looseObject({ items: rows, more: z.boolean().optional() })
          .safeParse(data);
        return parsed.success
          ? {
              counts: {
                notVoted: countOf(
                  notVoted(parsed.data.items),
                  parsed.data.more === true,
                ),
              },
            }
          : {};
      },
    },
  ],
};

/**
 * What a section does not read by default, as the requests that read it:
 * fee grants given, which the chain answers by scanning every fee grant
 * (Cosmos SDK 0.50 keys them by grantee).
 */
const NOT_READ: Partial<
  Record<Section, readonly { kind: KindDef; args: Record<string, unknown> }[]>
> = {
  fee_grants: [{ kind: fee, args: { direction: 'given' } }],
};

/* ── balances read once ───────────────────────────────────────────────── */

const BALANCES_PAGE =
  /^\/cosmos\/bank\/v1beta1\/balances\/(ixo1[02-9ac-hj-np-z]+)\?pagination\.limit=\d+$/;
const BY_DENOM =
  /^\/cosmos\/bank\/v1beta1\/balances\/(ixo1[02-9ac-hj-np-z]+)\/by_denom\?denom=([^&]+)$/;
const balancePage = z.object({
  balances: z.array(z.object({ denom: z.string(), amount: z.string() })),
  pagination: z.object({ next_key: z.string().nullish() }).nullish(),
});
/** One account's page of bank balances, and whether it is the whole list. */
type BalancePage = {
  address: string;
  amounts: ReadonlyMap<string, string>;
  complete: boolean;
};

/**
 * `ctx.rest` that first asks `known` for a GET's body (undefined, or a
 * body its schema refuses: read as usual) and shows `seen` every answer
 * it reads.
 */
function restFirst(
  ctx: KindContext,
  known: (path: string) => Promise<{ body: unknown } | undefined>,
  seen: (path: string, outcome: Outcome<unknown> | Absent) => void,
): KindContext['rest'] {
  function rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions & { noneOn?: undefined },
  ): Promise<Outcome<z.infer<S>>>;
  function rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions & { noneOn: readonly number[] },
  ): Promise<Outcome<z.infer<S>> | Absent>;
  async function rest<S extends z.ZodType>(
    path: string,
    schema: S,
    opts: KindRestOptions,
  ): Promise<Outcome<z.infer<S>> | Absent> {
    const { noneOn } = opts;
    if (noneOn !== undefined) {
      const outcome = await ctx.rest(path, schema, { ...opts, noneOn });
      seen(path, outcome);
      return outcome;
    }
    const answer = await known(path);
    if (answer) {
      const parsed = schema.safeParse(answer.body);
      if (parsed.success) return { ok: true, value: parsed.data };
    }
    const outcome = await ctx.rest(path, schema, { ...opts, noneOn });
    seen(path, outcome);
    return outcome;
  }
  return rest;
}

/**
 * The balances and liquid staking parts reading the account's balances
 * once: each pool's token balance (`/cosmos/bank/v1beta1/balances/{address}
 * /by_denom`, one read per pool in `liquid_staking`) is taken from the
 * page the balances part reads. A denom missing from a complete page (no
 * `next_key`) is held at zero. When the page is not complete, the
 * balances read failed or it never ran, the denom is read as usual.
 */
function balancesOnce(
  balances: KindDef,
  liquid: KindDef,
): { balances: KindDef; liquid: KindDef } {
  let settle: (page: BalancePage | null) => void = () => undefined;
  const page = new Promise<BalancePage | null>((resolve) => {
    settle = resolve;
  });
  const none = async () => undefined;
  const fromPage = async (
    path: string,
  ): Promise<{ body: unknown } | undefined> => {
    const match = BY_DENOM.exec(path);
    if (!match) return undefined;
    const known = await page;
    if (!known?.complete || known.address !== match[1]) return undefined;
    let denom: string;
    try {
      denom = decodeURIComponent(match[2] ?? '');
    } catch {
      return undefined;
    }
    const amount = known.amounts.get(denom) ?? '0';
    return { body: { balance: { denom, amount } } };
  };
  const keep = (path: string, outcome: Outcome<unknown> | Absent) => {
    const address = BALANCES_PAGE.exec(path)?.[1];
    if (!address) return;
    const parsed =
      'value' in outcome ? balancePage.safeParse(outcome.value) : null;
    settle(
      parsed?.success
        ? {
            address,
            amounts: new Map(
              parsed.data.balances.map((coin) => [coin.denom, coin.amount]),
            ),
            complete: !parsed.data.pagination?.next_key,
          }
        : null,
    );
  };
  return {
    balances: {
      ...balances,
      plan(args, ctx) {
        // The page settles on every path, so no pool waits for it forever.
        let plan: ReturnType<KindDef['plan']>;
        try {
          plan = balances.plan(args, {
            ...ctx,
            rest: restFirst(ctx, none, keep),
          });
        } catch (error) {
          settle(null);
          throw error;
        }
        if ('invalid' in plan || plan.source !== 'chain') {
          settle(null);
          return plan;
        }
        const { run } = plan;
        return {
          source: 'chain',
          async run() {
            try {
              return await run();
            } finally {
              settle(null);
            }
          },
        };
      },
    },
    liquid: {
      ...liquid,
      plan: (args, ctx) =>
        liquid.plan(args, {
          ...ctx,
          rest: restFirst(ctx, fromPage, () => undefined),
        }),
    },
  };
}

/* ── answers ──────────────────────────────────────────────────────────── */

/** The request that reads the rest of a section. */
type More =
  | { kind: string; args: Record<string, unknown> }
  | { tool: 'get_account_balances'; args: Record<string, unknown> };

type PartFailure = { kind: string } & Failure;

export type SectionAnswer =
  | {
      ok: true;
      summary: {
        counts: Record<string, Count>;
        totals?: Record<string, unknown>;
        top: unknown[];
      };
      more?: More;
      /** The requests for what the section does not read by default. */
      notRead?: More[];
      /** Parts of the section that failed; the summary is from the others. */
      failed?: PartFailure[];
      /** Top rows were left out to keep the answer small. */
      truncated?: true;
    }
  | ({ ok: false } & Failure);

export type OverviewAnswer = {
  ok: true;
  network: ChainCall['network'];
  fetchedAt: string;
  address: string;
  subject: Subject;
  sections: Partial<Record<Section, SectionAnswer>>;
};

export type OverviewFailure = {
  ok: false;
  network: ChainCall['network'];
} & Failure;

const SHAPE_FAILED: Failure = {
  reason: 'unavailable',
  detail: 'This section failed inside the oracle; asking again will not help.',
  retryable: false,
};
const LEFT_OUT = tooLarge(
  'Left out to keep the answer small; ask for this section on its own.',
);

/** A part that answered, with its rows. */
interface Answered {
  part: Part;
  rows: Rows;
  extra: Extra;
}

/** A section before its top rows are chosen: what answered and what failed. */
interface Gathered {
  answered: Answered[];
  failed: PartFailure[];
  /** Whether top rows carry the `list` they come from (a section of several parts). */
  tagged: boolean;
}

/** `parts` with the answer of each part's request (`results`, in part order). */
function gather(
  parts: readonly Part[],
  results: readonly (LookupResult | undefined)[],
): Gathered {
  const answered: Answered[] = [];
  const failed: PartFailure[] = [];
  parts.forEach((part, index) => {
    const result = results[index];
    if (!result) return;
    const name = part.kind.name;
    if (!result.ok) {
      failed.push({
        kind: name,
        reason: result.reason,
        detail: result.detail,
        retryable: result.retryable,
      });
      return;
    }
    const data = part.via?.pick ? part.via.pick(result.data) : result.data;
    const read = part.read(data);
    if (!read) {
      // A kind answering another shape than it documents is a bug here.
      // eslint-disable-next-line no-console -- console IS the logger on Workers
      console.error(`[ixo-chain] overview could not read the ${name} answer`);
      failed.push({ kind: name, ...SHAPE_FAILED });
      return;
    }
    answered.push({ part, rows: read, extra: part.extra?.(data) ?? {} });
  });
  return { answered, failed, tagged: parts.length > 1 };
}

/**
 * A section with at most `limit` top rows, taken from its parts in turn
 * (first row of each, then the second…), and the request for the rest of
 * the first part with rows not shown.
 */
function render(
  gathered: Gathered,
  limit: number,
  moreArgs: (part: Part) => Record<string, unknown>,
): SectionAnswer {
  const { answered, failed, tagged } = gathered;
  const first = failed[0];
  if (!answered.length)
    return first
      ? {
          ok: false,
          reason: first.reason,
          detail: first.detail,
          retryable: first.retryable,
        }
      : { ok: false, ...SHAPE_FAILED };
  const top: unknown[] = [];
  const shown = answered.map(() => 0);
  for (let row = 0; top.length < limit; row += 1) {
    let added = false;
    answered.forEach((entry, index) => {
      const value = entry.rows.rows[row];
      if (top.length >= limit || value === undefined) return;
      top.push(
        tagged && isRecord(value) ? { list: entry.part.list, ...value } : value,
      );
      shown[index] = (shown[index] ?? 0) + 1;
      added = true;
    });
    if (!added) break;
  }
  const counts: Record<string, Count> = {};
  let totals: Record<string, unknown> | undefined;
  for (const { part, rows, extra } of answered) {
    if (rows.count !== undefined) counts[part.list] = rows.count;
    Object.assign(counts, extra.counts);
    if (extra.totals) totals = extra.totals;
  }
  const rest = answered.find(
    (entry, index) =>
      entry.rows.more || entry.rows.rows.length > (shown[index] ?? 0),
  );
  const more: More | undefined = !rest
    ? undefined
    : rest.part.tool
      ? { tool: rest.part.tool, args: moreArgs(rest.part) }
      : { kind: rest.part.kind.name, args: moreArgs(rest.part) };
  return {
    ok: true,
    summary: { counts, ...(totals ? { totals } : {}), top },
    ...(more ? { more } : {}),
    ...(failed.length ? { failed } : {}),
  };
}

const size = (value: unknown) => JSON.stringify(value).length;

/**
 * Reads every section's parts in one `runRequests` call and cuts the
 * answer to {@link MAX_RESULT_CHARS}: one top row at a time from the
 * largest section that still has some, then, if it is still too large,
 * whole sections (largest first) as `too_large`.
 */
async function readOverview(
  call: ChainCall,
  identity: UserIdentity,
  account: { address: string; subject: Subject },
  sections: readonly Section[],
  options: LookupOptions,
): Promise<OverviewAnswer> {
  const planned = sections.flatMap((section) =>
    PARTS[section].map((part) => ({ section, part })),
  );
  // With both sections asked, the liquid staking holdings come from the
  // balances read.
  const once =
    sections.includes('balances') && sections.includes('liquid_staking')
      ? balancesOnce(balancesKind, liquidStaking)
      : null;
  const readOf = (part: Part): KindDef => {
    const read = part.via?.read ?? part.kind;
    if (once && read === balancesKind) return once.balances;
    if (once && read === liquidStaking) return once.liquid;
    return read;
  };
  // One request per part, except that parts reading through the same
  // `via` share its request.
  const requests: KindRequest[] = [];
  const shared = new Map<KindDef, number>();
  const requestOf = planned.map(({ part }) => {
    const known = part.via ? shared.get(part.via.read) : undefined;
    if (known !== undefined) return known;
    const index =
      requests.push({
        kind: readOf(part),
        args: {
          ...(part.via?.args ?? part.args),
          [part.account]: account.address,
        },
        ...(part.first !== undefined ? { first: part.first } : {}),
      }) - 1;
    if (part.via) shared.set(part.via.read, index);
    return index;
  });
  const answers = await runRequests(call, identity, requests, options);
  // The account is named in `more` only when it is not the user's (the
  // kinds' default).
  const moreArgs = (part: Part) =>
    account.subject === 'user'
      ? { ...part.args }
      : { ...part.args, [part.account]: account.address };
  const state = sections.map((section) => {
    const results = planned.flatMap((entry, index) =>
      entry.section === section ? [answers[requestOf[index] ?? -1]] : [],
    );
    return {
      section,
      gathered: gather(PARTS[section], results),
      limit: TOP_ROWS,
    };
  });
  const answer: OverviewAnswer = {
    ok: true,
    network: call.network,
    fetchedAt: new Date().toISOString(),
    address: account.address,
    subject: account.subject,
    sections: {},
  };
  // What a section leaves out, named for every answer it gives (a cut
  // below keeps it).
  const notRead = (section: Section): More[] | undefined =>
    NOT_READ[section]?.map((entry) => ({
      kind: entry.kind.name,
      args:
        account.subject === 'user'
          ? { ...entry.args }
          : { ...entry.args, address: account.address },
    }));
  const show = (entry: (typeof state)[number], cut: boolean) => {
    const shown = render(entry.gathered, entry.limit, moreArgs);
    const unread = notRead(entry.section);
    answer.sections[entry.section] = shown.ok
      ? {
          ...shown,
          ...(unread ? { notRead: unread } : {}),
          ...(cut ? { truncated: true } : {}),
        }
      : shown;
  };
  for (const entry of state) show(entry, false);
  while (size(answer) > MAX_RESULT_CHARS) {
    let largest: (typeof state)[number] | undefined;
    let largestSize = -1;
    for (const entry of state) {
      const shown = answer.sections[entry.section];
      if (!shown?.ok || !shown.summary.top.length) continue;
      const bytes = size(shown);
      if (bytes > largestSize) {
        largest = entry;
        largestSize = bytes;
      }
    }
    if (!largest) break;
    largest.limit -= 1;
    show(largest, true);
  }
  while (size(answer) > MAX_RESULT_CHARS) {
    let largest: Section | undefined;
    let largestSize = -1;
    for (const section of sections) {
      const shown = answer.sections[section];
      if (!shown?.ok) continue;
      const bytes = size(shown);
      if (bytes > largestSize) {
        largest = section;
        largestSize = bytes;
      }
    }
    if (!largest) break;
    answer.sections[largest] = { ok: false, ...LEFT_OUT };
  }
  return answer;
}

/* ── cache ────────────────────────────────────────────────────────────── */

/**
 * Whether `value` holds a read that failed inside an answer: every kind
 * marks one `<what>Unavailable: true` (a coin's `metadataUnavailable`,
 * staking's `rewardsUnavailable`, a pool's `stateUnavailable`, a
 * proposal's `tallyUnavailable` or `voteUnavailable`, an account's
 * `contractInfoUnavailable`).
 */
function hasUnreadPart(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnreadPart);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, inner]) =>
    key.endsWith('Unavailable') ? inner === true : hasUnreadPart(inner),
  );
}

/**
 * Whether an answer may be kept: every section answered, no part failed
 * and no read inside a part failed. Anything less is read again by the
 * next call, so a passing fault is never served for 20 s.
 */
function complete(answer: OverviewAnswer): boolean {
  return (
    Object.values(answer.sections).every(
      (section) => section.ok && !section.failed,
    ) && !hasUnreadPart(answer.sections)
  );
}

/** Whether a section or part ran out of time: of the call that read it, not necessarily of another. */
function timedOut(answer: OverviewAnswer): boolean {
  return Object.values(answer.sections).some((section) =>
    section.ok
      ? (section.failed ?? []).some((part) => part.reason === 'timeout')
      : section.reason === 'timeout',
  );
}

/**
 * Overview answers per isolate: each complete one kept for
 * {@link OVERVIEW_TTL_MS}, at most {@link OVERVIEW_CACHE_LIMIT} (the
 * oldest dropped first). A read in flight is shared by every call that
 * asks the same; a joining call waits on its own turn's abort only and
 * throws its own abort reason. It reads again itself when the shared read
 * ended in the starting turn's abort, or when that read ran out of time
 * and the joining call still has budget. Every call gets its own copy.
 */
class OverviewCache {
  private readonly answers = new Map<
    string,
    { answer: OverviewAnswer; expiresAt: number }
  >();
  private readonly inflight = new Map<string, Promise<OverviewAnswer>>();

  async get(
    key: string,
    call: ChainCall,
    read: () => Promise<OverviewAnswer>,
  ): Promise<OverviewAnswer> {
    const hit = this.answers.get(key);
    if (hit && hit.expiresAt > Date.now()) return structuredClone(hit.answer);
    if (hit) this.answers.delete(key);
    const running = this.inflight.get(key);
    if (!running) return this.start(key, read);
    let shared: OverviewAnswer;
    try {
      shared = await untilAborted(running, call.signal);
    } catch {
      // This turn's abort, or the starting turn's (the only error a read
      // throws): only this turn's is thrown; after the other's this call
      // reads on its own.
      throwIfAborted(call.signal);
      return this.start(key, read);
    }
    if (timedOut(shared) && hasBudget(call)) return this.start(key, read);
    return structuredClone(shared);
  }

  clear(): void {
    this.answers.clear();
    this.inflight.clear();
  }

  private async start(
    key: string,
    read: () => Promise<OverviewAnswer>,
  ): Promise<OverviewAnswer> {
    const pending = read();
    this.inflight.set(key, pending);
    try {
      const answer = await pending;
      if (complete(answer)) this.remember(key, answer);
      return answer;
    } finally {
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    }
  }

  private remember(key: string, answer: OverviewAnswer): void {
    this.answers.delete(key);
    if (this.answers.size >= OVERVIEW_CACHE_LIMIT) {
      const oldest = this.answers.keys().next();
      if (!oldest.done) this.answers.delete(oldest.value);
    }
    this.answers.set(key, {
      answer: structuredClone(answer),
      expiresAt: Date.now() + OVERVIEW_TTL_MS,
    });
  }
}

const cache = new OverviewCache();

/** Tests only: forget every kept overview. */
export function resetOverviewCache(): void {
  cache.clear();
}

/**
 * The overview of `input.address` (default: the user's account), the
 * sections asked (default: all) in their fixed order. Only the turn's
 * abort is thrown; a user with no IXO address and none given, or an
 * address that is none, is `invalid_input`.
 */
export async function accountOverview(
  call: ChainCall,
  identity: UserIdentity,
  input: { address?: string; sections?: readonly Section[] },
  options: LookupOptions,
): Promise<OverviewAnswer | OverviewFailure> {
  const account = accountOf(input.address, identity, 'address');
  if (!account.ok)
    return {
      ok: false,
      network: call.network,
      reason: 'invalid_input',
      detail: account.detail,
      retryable: false,
    };
  const asked = input.sections;
  const sections = SECTIONS.filter(
    (section) => !asked || asked.includes(section),
  );
  // Everything an answer depends on: where it is read from, whose it is
  // (`subject` differs per user) and what it holds.
  const key = [
    call.network,
    call.restUrl,
    call.blocksyncUrl,
    account.address,
    account.subject,
    sections.join(','),
  ].join('|');
  return cache.get(key, call, () =>
    readOverview(
      call,
      identity,
      { address: account.address, subject: account.subject },
      sections,
      options,
    ),
  );
}
