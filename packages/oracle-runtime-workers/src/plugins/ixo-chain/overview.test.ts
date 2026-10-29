import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserIdentity } from '../../core/user-identity';
import { ibcDenomTable } from './denoms';
import { TOOL_BUDGET_MS, USER_READ_PERMITS, type ChainCall } from './http';
import claims from './fixtures/claims-michael.json';
import accountBase from './kinds/chain/fixtures/account-base.json';
import authzReceived from './kinds/chain/fixtures/authz-received.json';
import balanceUpay from './kinds/chain/fixtures/balance-upay.json';
import balanceUzero from './kinds/chain/fixtures/balance-uzero.json';
import balances from './kinds/chain/fixtures/balances.json';
import {
  MICHAEL,
  REST,
  Reply,
  reply,
  resetChainState,
  upayRoute,
} from './kinds/chain/fixtures/context';
import feeReceived from './kinds/chain/fixtures/fee-grants-received.json';
import govTallyParams from './kinds/chain/fixtures/gov-tally-params.json';
import govTally from './kinds/chain/fixtures/gov-tally.json';
import govVoting from './kinds/chain/fixtures/gov-voting.json';
import lsParams from './kinds/chain/fixtures/liquidstake-params.json';
import lsPools from './kinds/chain/fixtures/liquidstake-pools.json';
import lsStatesPay from './kinds/chain/fixtures/liquidstake-states-pay.json';
import lsStatesZero from './kinds/chain/fixtures/liquidstake-states-zero.json';
import uzeroMetadata from './kinds/chain/fixtures/metadata-uzero.json';
import smartAccount from './kinds/chain/fixtures/smart-account.json';
import stakingPool from './kinds/chain/fixtures/staking-pool.json';
import delegations from './kinds/chain/fixtures/staking-delegations.json';
import rewards from './kinds/chain/fixtures/staking-rewards.json';
import unbonding from './kinds/chain/fixtures/staking-unbonding-empty.json';
import validator from './kinds/chain/fixtures/validator.json';
import agentDeposits from './kinds/indexed/fixtures/agent-deposits.json';
import daoProposals from './kinds/indexed/fixtures/dao-proposals.json';
import daos from './kinds/indexed/fixtures/daos.json';
import memberBudgets from './kinds/indexed/fixtures/member-budgets.json';
import { MAX_RESULT_CHARS } from './lookup';
import {
  OVERVIEW_CACHE_LIMIT,
  OVERVIEW_TTL_MS,
  SECTIONS,
  accountOverview,
  resetOverviewCache,
  type OverviewAnswer,
  type OverviewFailure,
  type Section,
  type SectionAnswer,
} from './overview';

const BLOCKSYNC = 'https://blocksync.test/graphql';
const USER: UserIdentity = { did: `did:ixo:${MICHAEL}`, address: MICHAEL };
/** Another mainnet account (a validator's own). */
const OTHER = 'ixo1qeex565vg4uu7zwudh9ff2dauxptqf72eg6wds';
const VALOPER = 'ixovaloper1qeex565vg4uu7zwudh9ff2dauxptqf72nf2l44';
const SERVICE = 'ixo1vafr2dqhgz8frc7gf22njz8y2u0fue4kuetey6';
const OPTIONS = { ibcDenoms: ibcDenomTable('mainnet', undefined) };
/** The page every grants read asks for (the kinds keep it per isolate). */
const GRANTS_PAGE = 'pagination.limit=20';
const NONE = { next_key: null, total: '0' };

/** Every chain REST route the overview reads for `address`, answered with recorded mainnet answers. */
function restRoutes(address: string): Record<string, unknown> {
  return {
    [`/cosmos/bank/v1beta1/balances/${address}?pagination.limit=50`]: balances,
    ...upayRoute,
    '/cosmos/bank/v1beta1/denoms_metadata_by_query_string?denom=uzero':
      uzeroMetadata,
    [`/cosmos/feegrant/v1beta1/allowances/${address}?${GRANTS_PAGE}`]:
      feeReceived,
    [`/cosmos/authz/v1beta1/grants/grantee/${address}?${GRANTS_PAGE}`]:
      authzReceived,
    [`/cosmos/authz/v1beta1/grants/granter/${address}?${GRANTS_PAGE}`]: {
      grants: [],
      pagination: NONE,
    },
    [`/ixo/smartaccount/authenticators/${address}`]: smartAccount,
    [`/cosmos/auth/v1beta1/accounts/${address}`]: accountBase,
    [`/cosmos/staking/v1beta1/delegations/${address}?pagination.limit=50`]:
      delegations,
    [`/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations?pagination.limit=50`]:
      unbonding,
    [`/cosmos/distribution/v1beta1/delegators/${address}/rewards`]: rewards,
    [`/cosmos/staking/v1beta1/validators/${VALOPER}`]: validator,
    '/ixo/liquidstake/v1beta1/pools?pagination.limit=10': lsPools,
    '/ixo/liquidstake/v1beta1/module_params': lsParams,
    '/ixo/liquidstake/v1beta1/pools/pay/states': lsStatesPay,
    '/ixo/liquidstake/v1beta1/pools/zero/states': lsStatesZero,
    [`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=upay`]:
      balanceUpay,
    [`/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uzero`]:
      balanceUzero,
    '/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_VOTING_PERIOD&pagination.limit=3&pagination.reverse=true':
      govVoting,
    '/cosmos/gov/v1/params/tallying': govTallyParams,
    '/cosmos/staking/v1beta1/pool': stakingPool,
    '/cosmos/gov/v1/proposals/506/tally': govTally,
    // What mainnet answered for an account that had not voted.
    [`/cosmos/gov/v1/proposals/506/votes/${address}`]: reply(400, {
      code: 3,
      message: `voter: ${address} not found for proposal: 506`,
    }),
  };
}

/** The recorded answer of each Blocksync root the overview asks. */
function indexedAnswer(field: string): unknown {
  if (field.includes(': claims(')) return claims;
  if (field.includes(': agentDepositBalances(')) return agentDeposits;
  if (field.includes(': memberBudgets(')) return memberBudgets;
  if (field.includes('daoProposalModulesByDaoAddress')) return daoProposals;
  if (field.includes('daoNativeStakers(')) return daos;
  throw new Error(`no recorded answer for ${field.slice(0, 60)}`);
}

/** The document's aliases (`r0: …`), each with its field. */
function aliasesOf(query: string): [string, string][] {
  const starts = [...query.matchAll(/\b(r\d+): /g)];
  return starts.map((match, index) => [
    match[1] ?? '',
    query.slice(match.index, starts[index + 1]?.index ?? query.length),
  ]);
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

/**
 * A fetch over `rest` (paths under {@link REST}; any other path answers
 * 418, neither retried nor "none") and the Blocksync POST, answered per
 * alias by `indexed`; `posts` collects each POST's document.
 */
function overviewFetch(
  rest: Record<string, unknown>,
  indexed: (field: string) => unknown = indexedAnswer,
) {
  const posts: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === BLOCKSYNC) {
      const body: unknown = JSON.parse(String(init?.body));
      const query =
        body && typeof body === 'object' && 'query' in body
          ? String(body.query)
          : '';
      posts.push(query);
      return json({
        data: Object.fromEntries(
          aliasesOf(query).map(([alias, field]) => [alias, indexed(field)]),
        ),
      });
    }
    const path = url.slice(REST.length);
    if (!(path in rest)) return new Response('{}', { status: 418 });
    const route = rest[path];
    return route instanceof Reply
      ? new Response(JSON.stringify(route.body), { status: route.status })
      : json(route);
  });
  const restPaths = () =>
    fetcher.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url !== BLOCKSYNC)
      .map((url) => url.slice(REST.length));
  return { fetcher, posts, restPaths };
}

function callFor(
  fetcher: typeof fetch,
  signal = new AbortController().signal,
  budgetMs = TOOL_BUDGET_MS,
): ChainCall {
  return {
    network: 'mainnet',
    restUrl: REST,
    blocksyncUrl: BLOCKSYNC,
    user: USER.did,
    deadline: Date.now() + budgetMs,
    signal,
    fetch: fetcher,
  };
}

/** A fetch whose first `hung` Blocksync POSTs wait for their abort; every other request is `fetcher`'s. */
function hangingPosts(fetcher: typeof fetch, hung = 1) {
  let left = hung;
  return vi.fn<typeof fetch>((input, init) => {
    if (String(input) !== BLOCKSYNC || left <= 0) return fetcher(input, init);
    left -= 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  });
}

function okAnswer(answer: OverviewAnswer | OverviewFailure): OverviewAnswer {
  if (!answer.ok) throw new Error(`overview failed: ${answer.detail}`);
  return answer;
}

const overview = async (
  fetcher: typeof fetch,
  input: { address?: string; sections?: Section[] } = {},
  identity: UserIdentity = USER,
) =>
  okAnswer(await accountOverview(callFor(fetcher), identity, input, OPTIONS));

const ixo = (amount: string, amountBaseUnits: string) => ({
  denom: 'uixo',
  symbol: 'IXO',
  amount,
  amountBaseUnits,
  verified: true,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetChainState();
  resetOverviewCache();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('get_account_overview', () => {
  it('answers every section from recorded answers, asking every Blocksync part in one POST', async () => {
    const { fetcher, posts } = overviewFetch(restRoutes(MICHAEL));
    const answer = await overview(fetcher);
    expect(posts).toHaveLength(1);
    const aliases = aliasesOf(posts[0] ?? '');
    // Claims, deposits, budgets, and the DAOs with their open proposals
    // as one alias.
    expect(aliases.map(([alias]) => alias)).toEqual(['r8', 'r9', 'r10', 'r12']);
    expect(posts[0]).toContain(
      `r8: claims(filter: { agentAddress: { equalTo: "${MICHAEL}" } }, first: 3, orderBy: SUBMISSION_DATE_DESC) { pageInfo {`,
    );
    // No full count of the account's claims.
    expect(posts[0]).not.toContain('totalCount');
    expect(posts[0]).toContain('r9: agentDepositBalances(');
    expect(posts[0]).toContain('r10: memberBudgets(');
    // The memberships are read once for both DAO lists.
    for (const root of [
      'daoNativeStakers(',
      'daoCw20Stakers(',
      'daoCw4Members(',
    ])
      expect((posts[0] ?? '').split(root)).toHaveLength(2);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(Object.keys(answer.sections)).toEqual(SECTIONS);
    expect(answer).toMatchObject({
      ok: true,
      network: 'mainnet',
      address: MICHAEL,
      subject: 'user',
    });
    const { sections } = answer;
    expect(sections.balances).toEqual({
      ok: true,
      summary: {
        counts: { tokens: 4 },
        top: [
          { ...ixo('9', '9000000'), decimals: 6 },
          expect.objectContaining({ symbol: 'USDC', origin: 'noble-1' }),
          expect.objectContaining({
            denom: 'upay',
            symbol: 'PAY',
            amount: '5.74',
            decimals: 6,
          }),
        ],
      },
      more: { tool: 'get_account_balances', args: {} },
    });
    // The user's own fee grant; the grants it gave are one request away.
    expect(sections.fee_grants).toEqual({
      ok: true,
      summary: {
        counts: { received: 1 },
        top: [
          expect.objectContaining({
            granter: SERVICE,
            granterLabel: 'IXO fee-grant service (feegrant.ixo.world)',
            kindLabel: 'one budget until it expires',
            spendLimit: 'unlimited',
          }),
        ],
      },
      notRead: [{ kind: 'fee_grants', args: { direction: 'given' } }],
    });
    expect(sections.authz).toMatchObject({
      ok: true,
      summary: {
        counts: { received: 2, given: 0 },
        top: [
          { list: 'received', type: 'CreateClaimAuthorizationAuthorization' },
          { list: 'received' },
        ],
      },
    });
    expect(sections.authz).not.toHaveProperty('more');
    expect(sections.smart_account).toMatchObject({
      ok: true,
      summary: {
        counts: { authenticators: 2 },
        top: [
          { id: '1155', type: 'AllOf' },
          { id: '1156', type: 'SignatureVerification' },
        ],
      },
    });
    expect(sections.account).toEqual({
      ok: true,
      summary: {
        counts: {},
        top: [
          {
            onChain: true,
            type: 'BaseAccount',
            kindLabel: 'regular account (held by a key)',
            accountNumber: '27012',
            sequence: expect.any(String),
            publicKey: 'secp256k1',
          },
        ],
      },
    });
    expect(sections.staking).toMatchObject({
      ok: true,
      summary: {
        counts: { delegations: 1, unbonding: 0 },
        totals: {
          unbonding: ixo('0', '0'),
          rewards: [ixo('0.570925', '570925')],
        },
        top: [{ validator: VALOPER, moniker: 'Alex (Bambarello) Validator' }],
      },
    });
    expect(sections.liquid_staking).toMatchObject({
      ok: true,
      summary: {
        counts: { pools: 2, holding: 1 },
        top: [
          {
            id: 'pay',
            lst: { symbol: 'PAY', denom: 'upay' },
            yourBalance: {
              denom: 'upay',
              symbol: 'PAY',
              amount: '5.74',
              amountBaseUnits: '5740000',
              verified: true,
            },
          },
          { id: 'zero' },
        ],
      },
    });
    // Claims and the deposit in turn; the rest of the claims is a request
    // away (counted from `hasNextPage`, not a total).
    expect(sections.claims).toMatchObject({
      ok: true,
      summary: {
        counts: { claims: '3+', deposits: 1, budgets: 0 },
        top: [
          {
            list: 'claims',
            claimId:
              'bafkreido4unh2l34n5zy5sy3nhyc3nhih65eysmal5dlq6j56m3eecntfm',
            collectionId: '8253',
            evaluation: { status: 'rejected' },
          },
          {
            list: 'deposits',
            collectionId: '794',
            coin: ixo('0.5', '500000'),
          },
          { list: 'claims' },
        ],
      },
      more: { kind: 'claims', args: {} },
    });
    expect(sections.governance).toMatchObject({
      ok: true,
      summary: {
        counts: { voting: 1, notVoted: 1 },
        top: [{ id: '506', status: 'voting', notVoted: true }],
      },
    });
    // DAOs and their open proposals in turn; more of both exist. The one
    // proposal not voted on is past its voting time, so it is not counted.
    expect(sections.daos).toMatchObject({
      ok: true,
      summary: {
        counts: { daos: '3+', openProposals: '3+', notVoted: '0+' },
        top: [
          { list: 'daos', name: 'Staking Group', membership: 'cw20-staked' },
          {
            list: 'openProposals',
            daoName: 'Administration',
            label: 'A3',
            votingEnded: true,
            notVoted: true,
          },
          { list: 'daos', name: 'Members Group' },
        ],
      },
      more: { kind: 'daos', args: {} },
    });
    // "Not voted" is an answer, never logged.
    expect(warn).not.toHaveBeenCalled();
  });

  it(`keeps at most ${USER_READ_PERMITS} chain reads in flight across every section`, async () => {
    vi.useRealTimers();
    const { fetcher } = overviewFetch(restRoutes(MICHAEL));
    let active = 0;
    let peak = 0;
    const slow = vi.fn<typeof fetch>(async (input, init) => {
      const rest = String(input) !== BLOCKSYNC;
      if (rest) {
        active += 1;
        peak = Math.max(peak, active);
      }
      await new Promise((resolve) => setTimeout(resolve, 3));
      if (rest) active -= 1;
      return fetcher(input, init);
    });
    const answer = await overview(slow);
    expect(Object.values(answer.sections).every((s) => s.ok)).toBe(true);
    expect(slow.mock.calls.length).toBeGreaterThan(20);
    expect(peak).toBe(USER_READ_PERMITS);
  });

  it('answers a failing section on its own, and a failing part beside the parts that answered', async () => {
    const routes = {
      ...restRoutes(MICHAEL),
      [`/cosmos/staking/v1beta1/delegations/${MICHAEL}?pagination.limit=50`]:
        reply(500),
      [`/cosmos/authz/v1beta1/grants/granter/${MICHAEL}?${GRANTS_PAGE}`]:
        reply(500),
    };
    const { fetcher } = overviewFetch(routes, (field) =>
      field.includes(': memberBudgets(') ? null : indexedAnswer(field),
    );
    const { sections } = await overview(fetcher);
    expect(sections.staking).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'The chain node is unavailable right now (HTTP 500).',
      retryable: true,
    });
    expect(sections.authz).toMatchObject({
      ok: true,
      summary: { counts: { received: 2 } },
      failed: [
        {
          kind: 'authz_grants',
          reason: 'unavailable',
          detail: 'The chain node is unavailable right now (HTTP 500).',
          retryable: true,
        },
      ],
    });
    // One alias of the document failing fails only its part.
    expect(sections.claims).toMatchObject({
      ok: true,
      summary: { counts: { claims: '3+', deposits: 1 } },
      failed: [
        {
          kind: 'member_budgets',
          reason: 'unavailable',
          detail: 'Blocksync answered this request in an unexpected shape.',
          retryable: false,
        },
      ],
    });
    expect(sections.balances?.ok).toBe(true);
    expect(sections.governance?.ok).toBe(true);
  });

  it('fails only the Blocksync sections when the POST fails', async () => {
    const { fetcher } = overviewFetch(restRoutes(MICHAEL));
    const failing = vi.fn<typeof fetch>(async (input, init) =>
      String(input) === BLOCKSYNC
        ? new Response('', { status: 400 })
        : fetcher(input, init),
    );
    const { sections } = await overview(failing);
    const failure = {
      ok: false,
      reason: 'unavailable',
      detail: 'Blocksync is unavailable right now (HTTP 400).',
      retryable: false,
    };
    expect(sections.daos).toEqual(failure);
    // Claims fail as a whole: every part is Blocksync's.
    expect(sections.claims).toEqual(failure);
    for (const section of SECTIONS.filter(
      (name) => name !== 'claims' && name !== 'daos',
    ))
      expect(sections[section]?.ok).toBe(true);
  });

  it('answers within the 20 s budget when nothing answers, and keeps no answer whose sections all failed', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z') });
    const hang = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const pending = accountOverview(callFor(hang), USER, {}, OPTIONS);
    await vi.advanceTimersByTimeAsync(TOOL_BUDGET_MS);
    const answer = okAnswer(await pending);
    for (const section of SECTIONS)
      expect(answer.sections[section]).toMatchObject({
        ok: false,
        reason: 'timeout',
        retryable: true,
      });
    const calls = hang.mock.calls.length;
    const again = accountOverview(callFor(hang), USER, {}, OPTIONS);
    await vi.advanceTimersByTimeAsync(TOOL_BUDGET_MS);
    await again;
    expect(hang.mock.calls.length).toBeGreaterThan(calls);
  });

  it("throws the turn's abort", async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    const hang = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const pending = accountOverview(
      callFor(hang, controller.signal),
      USER,
      {},
      OPTIONS,
    );
    await vi.waitFor(() => expect(hang).toHaveBeenCalled());
    const reason = new Error('turn aborted');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it(`keeps an answer for ${OVERVIEW_TTL_MS / 1000} s per isolate, as a copy, and shares one in flight`, async () => {
    const { fetcher } = overviewFetch(restRoutes(MICHAEL));
    const first = await overview(fetcher);
    const reads = fetcher.mock.calls.length;
    first.sections.account = TAMPERED;
    const second = await overview(fetcher);
    expect(fetcher.mock.calls.length).toBe(reads);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.sections.account?.ok).toBe(true);
    // Other sections, or another address, are another answer.
    await overview(fetcher, { sections: ['account'] });
    expect(fetcher.mock.calls.length).toBe(reads + 1);
    // Expired: read again.
    vi.setSystemTime(Date.now() + OVERVIEW_TTL_MS + 1);
    const third = await overview(fetcher);
    expect(fetcher.mock.calls.length).toBeGreaterThan(reads + 1);
    expect(third.fetchedAt).not.toBe(first.fetchedAt);
    // Two calls at once share one read.
    resetOverviewCache();
    resetChainState();
    fetcher.mockClear();
    const [a, b] = await Promise.all([overview(fetcher), overview(fetcher)]);
    expect(fetcher.mock.calls.length).toBe(reads);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("keys an answer by whose it is, so another user's call never gets the user's subject", async () => {
    const { fetcher } = overviewFetch({
      [`/cosmos/auth/v1beta1/accounts/${MICHAEL}`]: accountBase,
    });
    const mine = await overview(fetcher, { sections: ['account'] });
    const theirs = await overview(
      fetcher,
      { address: MICHAEL, sections: ['account'] },
      { did: `did:ixo:${OTHER}`, address: OTHER },
    );
    expect(mine.subject).toBe('user');
    expect(theirs.subject).toBe('other');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it(`keeps at most ${OVERVIEW_CACHE_LIMIT} answers, dropping the oldest`, async () => {
    // Every read answers, so every answer is complete and kept.
    const { fetcher } = overviewFetch(restRoutes(MICHAEL));
    const accountRead = [
      `${REST}/cosmos/auth/v1beta1/accounts/${MICHAEL}`,
      expect.anything(),
    ];
    // Each subset of the other sections beside `account` is its own answer.
    const others = SECTIONS.filter((section) => section !== 'account');
    const subset = (n: number): Section[] => [
      'account',
      ...others.filter((_section, bit) => (n >> bit) & 1),
    ];
    for (let n = 0; n <= OVERVIEW_CACHE_LIMIT; n += 1)
      await overview(fetcher, { sections: subset(n) });
    fetcher.mockClear();
    await overview(fetcher, { sections: subset(1) });
    expect(fetcher).not.toHaveBeenCalledWith(...accountRead);
    await overview(fetcher, { sections: subset(0) });
    expect(fetcher).toHaveBeenCalledWith(...accountRead);
  });

  it('reads only the sections asked, in their fixed order', async () => {
    const { fetcher, posts, restPaths } = overviewFetch(restRoutes(MICHAEL));
    const answer = await overview(fetcher, {
      sections: ['governance', 'account', 'governance'],
    });
    expect(Object.keys(answer.sections)).toEqual(['account', 'governance']);
    expect(posts).toEqual([]);
    expect(restPaths()).toEqual([
      `/cosmos/auth/v1beta1/accounts/${MICHAEL}`,
      '/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_VOTING_PERIOD&pagination.limit=3&pagination.reverse=true',
      '/cosmos/gov/v1/params/tallying',
      '/cosmos/staking/v1beta1/pool',
      '/cosmos/gov/v1/proposals/506/tally',
      `/cosmos/gov/v1/proposals/506/votes/${MICHAEL}`,
    ]);
  });

  it('fits the size cap by leaving out top rows first, the largest section first, with `more` for the rest', async () => {
    // Authz grants each carrying five constraints over five collections.
    const constraint = {
      max_authorizations: '0',
      max_agent_quota: '0',
      max_amount: [{ denom: 'uixo', amount: '1000000' }],
      max_cw20_payment: [],
      expiration: null,
      collection_ids: ['8250', '8251', '8252', '8253', '8254'],
      allowed_auth_types: 'ALL',
      max_intent_duration_ns: '3600s',
      member_address: OTHER,
    };
    const grant = (n: number) => ({
      granter: OTHER,
      grantee: MICHAEL,
      authorization: {
        '@type': '/ixo.claims.v1beta1.CreateClaimAuthorizationAuthorization',
        admin: `${OTHER.slice(0, -1)}${n}`,
        constraints: Array.from({ length: 5 }, () => constraint),
      },
      expiration: null,
    });
    const routes = {
      ...restRoutes(MICHAEL),
      [`/cosmos/authz/v1beta1/grants/grantee/${MICHAEL}?${GRANTS_PAGE}`]: {
        grants: [grant(1), grant(2), grant(3)],
        pagination: { next_key: null, total: '3' },
      },
      [`/cosmos/authz/v1beta1/grants/granter/${MICHAEL}?${GRANTS_PAGE}`]: {
        grants: [grant(4), grant(5), grant(6)],
        pagination: { next_key: null, total: '3' },
      },
    };
    const { fetcher } = overviewFetch(routes);
    const answer = await overview(fetcher);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const authz = answer.sections.authz;
    if (!authz?.ok) throw new Error('authz should answer');
    expect(authz.truncated).toBe(true);
    expect(authz.summary.counts).toEqual({ received: 3, given: 3 });
    expect(authz.summary.top.length).toBeLessThan(3);
    expect(authz.more).toEqual({
      kind: 'authz_grants',
      args: { direction: 'received' },
    });
    // The small sections keep every top row.
    expect(answer.sections.governance).not.toHaveProperty('truncated');
    expect(answer.sections.account).not.toHaveProperty('truncated');
  });

  it("reads another account by address or DID, says it is another's and names it in `more`", async () => {
    const { fetcher, restPaths } = overviewFetch(restRoutes(OTHER));
    const answer = await overview(fetcher, { address: `did:ixo:${OTHER}` });
    expect(answer).toMatchObject({ address: OTHER, subject: 'other' });
    expect(restPaths()).toContain(
      `/cosmos/gov/v1/proposals/506/votes/${OTHER}`,
    );
    expect(restPaths().some((path) => path.includes(MICHAEL))).toBe(false);
    expect(answer.sections.fee_grants).toMatchObject({
      notRead: [
        { kind: 'fee_grants', args: { direction: 'given', address: OTHER } },
      ],
    });
    expect(answer.sections.claims).toMatchObject({
      more: { kind: 'claims', args: { agent: OTHER } },
    });
    expect(answer.sections.balances).toMatchObject({
      more: { tool: 'get_account_balances', args: { address: OTHER } },
    });
  });

  it('refuses a user with no IXO address and no address given, and a bad address, without a read', async () => {
    const { fetcher } = overviewFetch(restRoutes(MICHAEL));
    const noAccount: UserIdentity = { did: 'did:key:z6MkTest', address: null };
    expect(
      await accountOverview(callFor(fetcher), noAccount, {}, OPTIONS),
    ).toEqual({
      ok: false,
      network: 'mainnet',
      reason: 'invalid_input',
      detail: 'The user has no IXO account address; give one.',
      retryable: false,
    });
    expect(
      await accountOverview(
        callFor(fetcher),
        USER,
        { address: 'cosmos1abc' },
        OPTIONS,
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps no answer with a failed part or a coin whose display was not read', async () => {
    // A part failing beside the others: answered, not kept.
    const failing = overviewFetch({}, (field) =>
      field.includes(': memberBudgets(') ? null : indexedAnswer(field),
    );
    const first = await overview(failing.fetcher, { sections: ['claims'] });
    expect(first.sections.claims).toMatchObject({
      ok: true,
      failed: [{ kind: 'member_budgets' }],
    });
    await overview(failing.fetcher, { sections: ['claims'] });
    expect(failing.posts).toHaveLength(2);
    // A deposit in a denom whose metadata read failed (418 here).
    resetOverviewCache();
    const unread = overviewFetch({}, (field) =>
      field.includes(': agentDepositBalances(')
        ? {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                collectionId: '794',
                agentAddress: MICHAEL,
                amount: [{ denom: 'uother', amount: '5' }],
                withdrawableAt: '2026-07-25T15:24:10.518',
              },
            ],
          }
        : indexedAnswer(field),
    );
    const shown = await overview(unread.fetcher, { sections: ['claims'] });
    expect(shown.sections.claims).not.toHaveProperty('failed');
    expect(JSON.stringify(shown)).toContain('"metadataUnavailable":true');
    await overview(unread.fetcher, { sections: ['claims'] });
    expect(unread.posts).toHaveLength(2);
  });

  it('shows staking without its rewards when that read fails, and keeps no such answer', async () => {
    const { fetcher } = overviewFetch({
      ...restRoutes(MICHAEL),
      [`/cosmos/distribution/v1beta1/delegators/${MICHAEL}/rewards`]:
        reply(500),
    });
    const { sections } = await overview(fetcher, { sections: ['staking'] });
    expect(sections.staking).toMatchObject({
      ok: true,
      summary: {
        counts: { delegations: 1, unbonding: 0 },
        totals: { unbonding: ixo('0', '0'), rewardsUnavailable: true },
        top: [{ validator: VALOPER }],
      },
    });
    expect(sections.staking).not.toHaveProperty('failed');
    const reads = fetcher.mock.calls.length;
    await overview(fetcher, { sections: ['staking'] });
    expect(fetcher.mock.calls.length).toBeGreaterThan(reads);
  });

  it("never throws the starting turn's abort to a joining call, which reads again itself", async () => {
    vi.useRealTimers();
    const { fetcher, posts } = overviewFetch({});
    const hanging = hangingPosts(fetcher);
    const starter = new AbortController();
    const leading = accountOverview(
      callFor(hanging, starter.signal),
      USER,
      { sections: ['claims'] },
      OPTIONS,
    );
    await vi.waitFor(() => expect(hanging).toHaveBeenCalled());
    const joining = accountOverview(
      callFor(hanging),
      USER,
      { sections: ['claims'] },
      OPTIONS,
    );
    const reason = new Error('the starting turn was aborted');
    starter.abort(reason);
    await expect(leading).rejects.toBe(reason);
    const answer = okAnswer(await joining);
    expect(answer.sections.claims?.ok).toBe(true);
    // The joining call's own read.
    expect(posts).toHaveLength(1);
  });

  it('throws only its own abort while it waits on a shared read', async () => {
    vi.useRealTimers();
    const { fetcher } = overviewFetch({});
    const hanging = hangingPosts(fetcher);
    const starter = new AbortController();
    const leading = accountOverview(
      callFor(hanging, starter.signal),
      USER,
      { sections: ['claims'] },
      OPTIONS,
    );
    await vi.waitFor(() => expect(hanging).toHaveBeenCalled());
    const joiner = new AbortController();
    const joining = accountOverview(
      callFor(hanging, joiner.signal),
      USER,
      { sections: ['claims'] },
      OPTIONS,
    );
    const own = new Error('the joining turn was aborted');
    joiner.abort(own);
    await expect(joining).rejects.toBe(own);
    const theirs = new Error('the starting turn was aborted');
    starter.abort(theirs);
    await expect(leading).rejects.toBe(theirs);
  });

  it('reads again in a joining call when the shared read ran out of its own budget', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z') });
    const { fetcher, posts } = overviewFetch({});
    const hanging = hangingPosts(fetcher);
    // The starting call has 2 s left; the joining call its whole budget.
    const leading = accountOverview(
      callFor(hanging, undefined, 2_000),
      USER,
      { sections: ['claims'] },
      OPTIONS,
    );
    const joining = accountOverview(
      callFor(hanging),
      USER,
      { sections: ['claims'] },
      OPTIONS,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(okAnswer(await leading).sections.claims).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(okAnswer(await joining).sections.claims?.ok).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it('leaves fee grants given out by default and names the request that reads them', async () => {
    const mine = overviewFetch(restRoutes(MICHAEL));
    const { sections } = await overview(mine.fetcher, {
      sections: ['fee_grants'],
    });
    expect(mine.restPaths().some((path) => path.includes('/issued/'))).toBe(
      false,
    );
    expect(sections.fee_grants).toMatchObject({
      ok: true,
      summary: { counts: { received: expect.anything() } },
      notRead: [{ kind: 'fee_grants', args: { direction: 'given' } }],
    });
    if (!sections.fee_grants?.ok) throw new Error('fee grants should answer');
    expect(sections.fee_grants.summary.counts).not.toHaveProperty('given');
    const theirs = overviewFetch(restRoutes(OTHER));
    const other = await overview(theirs.fetcher, {
      address: OTHER,
      sections: ['fee_grants'],
    });
    expect(other.sections.fee_grants).toMatchObject({
      notRead: [
        { kind: 'fee_grants', args: { direction: 'given', address: OTHER } },
      ],
    });
  });

  it('takes the liquid staking holdings from the balances read when both are asked', async () => {
    const both = overviewFetch(restRoutes(MICHAEL));
    const shared = await overview(both.fetcher, {
      sections: ['balances', 'liquid_staking'],
    });
    expect(both.restPaths().some((path) => path.includes('/by_denom'))).toBe(
      false,
    );
    resetOverviewCache();
    resetChainState();
    const alone = overviewFetch(restRoutes(MICHAEL));
    const own = await overview(alone.fetcher, { sections: ['liquid_staking'] });
    expect(
      alone.restPaths().filter((path) => path.includes('/by_denom')),
    ).toEqual([
      `/cosmos/bank/v1beta1/balances/${MICHAEL}/by_denom?denom=upay`,
      `/cosmos/bank/v1beta1/balances/${MICHAEL}/by_denom?denom=uzero`,
    ]);
    // The same holdings either way: upay from the page, uzero absent from a complete page.
    expect(shared.sections.liquid_staking).toEqual(own.sections.liquid_staking);
  });

  it('reads each pool token balance when the balances page is incomplete or failed', async () => {
    const page = `/cosmos/bank/v1beta1/balances/${MICHAEL}?pagination.limit=50`;
    for (const answer of [
      { ...balances, pagination: { next_key: 'bmV4dA==', total: '0' } },
      reply(500),
    ]) {
      resetOverviewCache();
      resetChainState();
      const { fetcher, restPaths } = overviewFetch({
        ...restRoutes(MICHAEL),
        [page]: answer,
      });
      const { sections } = await overview(fetcher, {
        sections: ['balances', 'liquid_staking'],
      });
      expect(
        restPaths().filter((path) => path.includes('/by_denom')),
      ).toHaveLength(2);
      expect(sections.liquid_staking?.ok).toBe(true);
    }
  });

  it('counts not-voted DAO proposals only while their voting time runs', async () => {
    const open = (id: string, endsMs: number) => ({
      id,
      title: `Proposal ${id}`,
      status: 'open',
      startHeight: 19_000_000,
      expiration: { at_time: `${BigInt(endsMs) * 1_000_000n}` },
      daoVotesByProposalModuleAndProposalId: { nodes: [] },
    });
    const core = {
      address: 'ixo14g47ggcgge3xgmzddenqzsgr26ckk854gfngz4g908wc29drwussp0k66n',
      name: 'Test',
      daoProposalModulesByDaoAddress: {
        nodes: [
          {
            address: 'ixo1module',
            prefix: 'A',
            daoProposalsByProposalModule: {
              nodes: [
                open('2', Date.now() + 86_400_000),
                open('1', Date.now() - 86_400_000),
              ],
            },
          },
        ],
      },
    };
    const empty = { nodes: [] };
    const { fetcher, posts } = overviewFetch({}, () => ({
      native: empty,
      cw20: empty,
      cw4: {
        nodes: [
          {
            weight: 1,
            daoCw4GroupContractByGroupContractAddress: {
              daoVotingModulesByGroupContractAddress: {
                nodes: [
                  {
                    address: 'ixo1voting',
                    totalWeight: '2',
                    daoCoresByVotingModule: { nodes: [core] },
                  },
                ],
              },
            },
          },
        ],
      },
    }));
    const { sections } = await overview(fetcher, { sections: ['daos'] });
    expect(sections.daos).toMatchObject({
      ok: true,
      summary: { counts: { daos: 1, openProposals: 2, notVoted: 1 } },
    });
    // One alias reads the memberships once for both lists.
    expect(aliasesOf(posts[0] ?? '')).toHaveLength(1);
    for (const root of [
      'daoNativeStakers(',
      'daoCw20Stakers(',
      'daoCw4Members(',
    ])
      expect((posts[0] ?? '').split(root)).toHaveLength(2);
  });
});

const TAMPERED: SectionAnswer = {
  ok: false,
  reason: 'unavailable',
  detail: 'changed by the caller',
  retryable: false,
};
