import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimIntentsKind, collectionMembershipKind } from './claims';
import emptyIntents from './fixtures/claim-intents-empty.json';
import devnetDeposits from './fixtures/collection-deposits-devnet.json';
import emptyDeposits from './fixtures/collection-deposits-empty.json';
import emptyMembers from './fixtures/collection-members-empty.json';
import {
  HTTP_500_FAILURE,
  MICHAEL,
  chainFetch,
  contextOf,
  pathsOf,
  refusal,
  reply,
  resetChainState,
  run,
} from './fixtures/context';

/** The intents page that starts at the store key `start`. */
const intentsFrom = (start: string) =>
  `/ixo/claims/intents?pagination.key=${encodeURIComponent(btoa(start))}&pagination.limit=200`;
const INTENTS = intentsFrom(`${MICHAEL}/`);
const OTHER = 'ixo1rtjje8u0ctwwcdk8x07f4zgmexnjcmk8w6dgvq';
const ixoCoin = (amount: string, amountBaseUnits: string) => ({
  amount,
  symbol: 'IXO',
  denom: 'uixo',
  amountBaseUnits,
  verified: true,
});

beforeEach(() => {
  resetChainState();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ now: new Date('2026-10-29T12:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('claim_intents', () => {
  const intent = (
    id: string,
    agent: string,
    collection: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    agent_did: `did:ixo:${agent}`,
    agent_address: agent,
    collection_id: collection,
    claim_id: '',
    created_at: '2026-10-20T00:00:00Z',
    expire_at: '2026-11-20T00:00:00Z',
    status: 'ACTIVE',
    amount: [{ denom: 'uixo', amount: '3000000' }],
    cw20_payment: [],
    from_address: 'ixo1from',
    escrow_address: 'ixo1escrow',
    cw1155_payment: [],
    cw1155_intent_payment: [],
    member_address: '',
    ...extra,
  });

  it('validates its arguments', () => {
    const ctx = contextOf(chainFetch({}));
    expect(refusal(claimIntentsKind, { collectionId: '340' }, ctx)).toBeNull();
    expect(refusal(claimIntentsKind, { collectionId: '34a' }, ctx)).toBe(
      'collectionId must be a number such as "8250".',
    );
    expect(refusal(claimIntentsKind, { collection: '340' }, ctx)).toMatch(
      /^Invalid args for kind "claim_intents"/,
    );
  });

  it('answers no intents when the store ends before any of the account (recorded mainnet answer)', async () => {
    const fetcher = chainFetch({ [INTENTS]: emptyIntents });
    expect(await run(claimIntentsKind, {}, contextOf(fetcher))).toEqual({
      ok: true,
      subject: 'user',
      first: 10,
      data: {
        address: MICHAEL,
        intents: [],
        matched: 0,
        complete: true,
      },
    });
    expect(pathsOf(fetcher)).toEqual([INTENTS]);
    // The page starts at the store key `<agent>/`.
    expect(INTENTS).toContain(
      `pagination.key=${encodeURIComponent(btoa('ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95/'))}`,
    );
  });

  it("reads the account's intents from its own key and stops at the first intent of another agent", async () => {
    const body = {
      intents: [
        intent('2', MICHAEL, '340', {
          status: 'FULFILLED',
          claim_id: 'bafkreiclaim',
          amount: [],
        }),
        intent('3', MICHAEL, '341', {
          expire_at: '2026-10-25T00:00:00Z',
          member_address: OTHER,
        }),
        intent('1', OTHER, '340'),
        intent('9', MICHAEL, '340'),
      ],
      pagination: { next_key: 'next' },
    };
    const all = await run(
      claimIntentsKind,
      {},
      contextOf(chainFetch({ [INTENTS]: body })),
    );
    expect(all.ok && all.data).toEqual({
      address: MICHAEL,
      intents: [
        {
          id: '2',
          collectionId: '340',
          status: 'fulfilled',
          coins: 'none',
          createdAt: '2026-10-20T00:00:00Z',
          expiresAt: '2026-11-20T00:00:00Z',
          claimId: 'bafkreiclaim',
        },
        {
          id: '3',
          collectionId: '341',
          status: 'active',
          coins: [ixoCoin('3', '3000000')],
          createdAt: '2026-10-20T00:00:00Z',
          expiresAt: '2026-10-25T00:00:00Z',
          pastExpiry: true,
          forMember: OTHER,
        },
      ],
      matched: 2,
      // Another agent's intent ended the account's: nothing was left out.
      complete: true,
    });
  });

  it("reads one collection's intents from `<agent>/<collection>/`, stopping at the next collection", async () => {
    const page = intentsFrom(`${MICHAEL}/341/`);
    const body = {
      intents: [
        intent('3', MICHAEL, '341'),
        intent('4', MICHAEL, '341'),
        intent('5', MICHAEL, '3410'),
      ],
      pagination: { next_key: 'next' },
    };
    const fetcher = chainFetch({ [page]: body });
    const one = await run(
      claimIntentsKind,
      { collectionId: '341' },
      contextOf(fetcher, { first: 1 }),
    );
    expect(pathsOf(fetcher)).toEqual([page]);
    expect(one).toMatchObject({
      ok: true,
      first: 1,
      data: {
        collectionId: '341',
        matched: 2,
        complete: true,
        intents: [{ id: '3' }],
      },
    });
  });

  it("says the list is incomplete when a full page held only the account's intents", async () => {
    const body = {
      intents: [intent('2', MICHAEL, '340'), intent('3', MICHAEL, '341')],
      pagination: { next_key: 'next' },
    };
    expect(
      await run(
        claimIntentsKind,
        {},
        contextOf(chainFetch({ [INTENTS]: body })),
      ),
    ).toMatchObject({ ok: true, data: { matched: 2, complete: false } });
    expect(
      await run(
        claimIntentsKind,
        {},
        contextOf(
          chainFetch({
            [INTENTS]: { ...body, pagination: { next_key: null } },
          }),
        ),
      ),
    ).toMatchObject({ ok: true, data: { matched: 2, complete: true } });
  });

  it('passes an upstream failure through', async () => {
    expect(
      await run(
        claimIntentsKind,
        {},
        contextOf(chainFetch({ [INTENTS]: reply(500) })),
      ),
    ).toEqual(HTTP_500_FAILURE);
  });
});

describe('collection_membership', () => {
  /** The page of a collection list that starts at the account's key. */
  const page = (collection: string, list: string, address: string) =>
    `/ixo/claims/collection/${collection}/${list}?pagination.key=${encodeURIComponent(btoa(address))}&pagination.limit=1`;

  it('validates its arguments: the collection is required', () => {
    const ctx = contextOf(chainFetch({}));
    expect(
      refusal(collectionMembershipKind, { collectionId: '340' }, ctx),
    ).toBeNull();
    expect(refusal(collectionMembershipKind, {}, ctx)).toMatch(
      /^Invalid args for kind "collection_membership" \(collectionId: /,
    );
    expect(
      refusal(collectionMembershipKind, { collectionId: '340/../x' }, ctx),
    ).toBe('collectionId must be a number such as "8250".');
  });

  it('answers an account that is neither member nor depositor (recorded mainnet answers)', async () => {
    const members = page('340', 'members', MICHAEL);
    const deposits = page('340', 'deposits', MICHAEL);
    expect(members).toBe(
      '/ixo/claims/collection/340/members?pagination.key=aXhvMWNyYTZwMGplZnU4ZjkwN2dxbmdrZnp4dXIyNms3ZjczYW40djk1&pagination.limit=1',
    );
    const fetcher = chainFetch({
      [members]: emptyMembers,
      [deposits]: emptyDeposits,
    });
    expect(
      await run(
        collectionMembershipKind,
        { collectionId: '340' },
        contextOf(fetcher),
      ),
    ).toEqual({
      ok: true,
      subject: 'user',
      data: {
        address: MICHAEL,
        collectionId: '340',
        member: false,
        deposit: null,
      },
    });
    expect(pathsOf(fetcher).sort()).toEqual([deposits, members].sort());
  });

  it("reads an agent's deposit (recorded devnet answer)", async () => {
    const agent = 'ixo1u4m0hwtysne8y7pkq9tj45ksp38ps9p347a5tr';
    const result = await run(
      collectionMembershipKind,
      { collectionId: '794', address: agent },
      contextOf(
        chainFetch({
          [page('794', 'members', agent)]: emptyMembers,
          [page('794', 'deposits', agent)]: devnetDeposits,
        }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      subject: 'other',
      data: {
        address: agent,
        collectionId: '794',
        member: false,
        deposit: {
          coin: ixoCoin('0.5', '500000'),
          withdrawableAt: null,
          lockEnded: true,
        },
      },
    });
  });

  it("shows a member's budget, and ignores the next account's record on the page", async () => {
    const result = await run(
      collectionMembershipKind,
      { collectionId: '340' },
      contextOf(
        chainFetch({
          [page('340', 'members', MICHAEL)]: {
            member_budgets: [
              {
                collection_id: '340',
                member_address: MICHAEL,
                period: '2592000s',
                period_spend_limit: [{ denom: 'uixo', amount: '50000000' }],
                period_spent: [{ denom: 'uixo', amount: '12500000' }],
                period_cw20_spend_limit: [],
                period_cw20_spent: [],
                period_reset_at: '2026-11-01T00:00:00Z',
              },
            ],
            pagination: { next_key: null },
          },
          [page('340', 'deposits', MICHAEL)]: {
            balances: [
              {
                collection_id: '340',
                agent_address: OTHER,
                amount: [{ denom: 'uixo', amount: '1' }],
                withdrawable_at: null,
              },
            ],
            pagination: { next_key: null },
          },
        }),
      ),
    );
    expect(result.ok && result.data).toEqual({
      address: MICHAEL,
      collectionId: '340',
      member: true,
      budget: {
        period: '30 days',
        spendLimit: [ixoCoin('50', '50000000')],
        spent: [ixoCoin('12.5', '12500000')],
        cw20SpendLimit: 'none allowed',
        cw20Spent: 'none',
        resetAt: '2026-11-01T00:00:00Z',
      },
      deposit: null,
    });
  });

  it('says what empty budget amounts mean, and when a deposit is still locked', async () => {
    const result = await run(
      collectionMembershipKind,
      { collectionId: '340' },
      contextOf(
        chainFetch({
          [page('340', 'members', MICHAEL)]: {
            member_budgets: [
              {
                collection_id: '340',
                member_address: MICHAEL,
                period: '86400s',
                period_spend_limit: [],
                period_spent: [],
                period_cw20_spend_limit: [{ address: OTHER, amount: '9' }],
                period_cw20_spent: [],
                period_reset_at: '2026-10-28T00:00:00Z',
              },
            ],
            pagination: { next_key: null },
          },
          [page('340', 'deposits', MICHAEL)]: {
            balances: [
              {
                collection_id: '340',
                agent_address: MICHAEL,
                amount: [
                  { denom: 'uixo', amount: '1000000' },
                  { denom: 'uixo2', amount: '5' },
                ],
                withdrawable_at: '2026-11-15T00:00:00Z',
              },
            ],
            pagination: { next_key: null },
          },
        }),
      ),
    );
    expect(result.ok && result.data).toMatchObject({
      member: true,
      budget: {
        period: '1 day',
        spendLimit: 'none allowed',
        spent: 'none',
        cw20SpendLimit: [{ contract: OTHER, amountBaseUnits: '9' }],
        cw20Spent: 'none',
        resetDue: true,
      },
      deposit: {
        coins: [
          ixoCoin('1', '1000000'),
          expect.objectContaining({ denom: 'uixo2' }),
        ],
        withdrawableAt: '2026-11-15T00:00:00Z',
        lockEnded: false,
      },
    });
  });

  it('passes a failure of either read through', async () => {
    const routes = {
      [page('340', 'members', MICHAEL)]: emptyMembers,
      [page('340', 'deposits', MICHAEL)]: emptyDeposits,
    };
    for (const broken of Object.keys(routes))
      expect(
        await run(
          collectionMembershipKind,
          { collectionId: '340' },
          contextOf(chainFetch({ ...routes, [broken]: reply(500) })),
        ),
      ).toEqual(HTTP_500_FAILURE);
  });
});
