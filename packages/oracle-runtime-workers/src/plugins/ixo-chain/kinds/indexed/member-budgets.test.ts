import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADDRESS,
  INJECTION,
  NO_ADDRESS,
  OTHER,
  answerOf,
  contextOf,
  failureOf,
  long,
  planOf,
  refusalOf,
} from './fixtures/context';
// The user's answer, recorded on mainnet on Oct 29 2026 (`first: 3`). No
// network indexed a member budget that day, so the rows below are written
// in the indexer's stored shape (ixo-blocksync `upsertMemberBudget`: coin
// arrays, cw20 `{ address, amount }` arrays, the period in nanoseconds).
import recorded from './fixtures/member-budgets.json';
import { memberBudgets } from './member-budgets';

const NODES =
  '{ pageInfo { hasNextPage } nodes { collectionId memberAddress periodNs periodSpendLimit periodSpent periodCw20SpendLimit periodCw20Spent periodResetAt updatedAt } }';
const DAY_NS = '86400000000000';
/** PAY from the chain's own DenomMetadata (6 decimals). */
const pay = (amountBaseUnits: string, amount: string) => ({
  denom: 'upay',
  amountBaseUnits,
  symbol: 'PAY',
  amount,
  verified: true,
});

const budget = (overrides: Record<string, unknown>) => ({
  collectionId: '8250',
  memberAddress: ADDRESS,
  periodNs: String(30n * BigInt(DAY_NS)),
  periodSpendLimit: [{ denom: 'uixo', amount: '100000000' }],
  periodSpent: [{ denom: 'uixo', amount: '25500000' }],
  periodCw20SpendLimit: [{ address: OTHER, amount: '1000' }],
  periodCw20Spent: [{ address: OTHER, amount: '10' }],
  periodResetAt: '2026-11-15T00:00:00.000',
  updatedAt: '2026-10-20T08:00:00.000',
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('member_budgets', () => {
  it('reads the user’s budgets, optionally in one collection', () => {
    expect(planOf(memberBudgets, {}).field('r0')).toBe(
      `r0: memberBudgets(filter: { memberAddress: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: PRIMARY_KEY_ASC) ${NODES}`,
    );
    expect(
      planOf(memberBudgets, { collectionId: '8250', address: OTHER }).field(
        'r2',
      ),
    ).toBe(
      `r2: memberBudgets(filter: { memberAddress: { equalTo: "${OTHER}" }, collectionId: { equalTo: "8250" } }, first: 10, orderBy: PRIMARY_KEY_ASC) ${NODES}`,
    );
  });

  it('validates its arguments', () => {
    expect(refusalOf(memberBudgets, { collectionId: '82 50' })).toMatch(
      /collectionId: a collection number/,
    );
    expect(refusalOf(memberBudgets, { member: ADDRESS })).toMatch(/member/);
    expect(refusalOf(memberBudgets, { first: 1.5 })).toMatch(/first:/);
    expect(refusalOf(memberBudgets, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
  });

  it('refuses values carrying GraphQL syntax and uses no containment', () => {
    expect(refusalOf(memberBudgets, { address: INJECTION })).toMatch(
      /address must be/,
    );
    expect(refusalOf(memberBudgets, { collectionId: '1" } }) { x' })).toMatch(
      /collectionId/,
    );
    expect(planOf(memberBudgets, {}).field('r0')).not.toContain('contains');
  });

  it('reads the call’s clamped row count', () => {
    expect(
      planOf(memberBudgets, { first: 20 }, contextOf(undefined, 4)).field('r0'),
    ).toContain('first: 4,');
  });

  it('shapes the recorded (empty) answer', async () => {
    const plan = planOf(memberBudgets, {}, contextOf(undefined, 3));
    expect(await answerOf(plan, recorded)).toEqual({
      ok: true,
      subject: 'user',
      first: 3,
      data: { items: [] },
    });
  });

  it('shapes a budget in its period: limit, spent and what remains', async () => {
    const answer = await answerOf(planOf(memberBudgets, {}), {
      pageInfo: { hasNextPage: true },
      nodes: [budget({})],
    });
    expect(answer.data).toEqual({
      more: true,
      items: [
        {
          collectionId: '8250',
          member: ADDRESS,
          period: '30 days',
          spendLimit: [
            {
              denom: 'uixo',
              amountBaseUnits: '100000000',
              symbol: 'IXO',
              amount: '100',
              verified: true,
            },
          ],
          spent: [
            {
              denom: 'uixo',
              amountBaseUnits: '25500000',
              symbol: 'IXO',
              amount: '25.5',
              verified: true,
            },
          ],
          remaining: [
            {
              denom: 'uixo',
              amountBaseUnits: '74500000',
              symbol: 'IXO',
              amount: '74.5',
              verified: true,
            },
          ],
          cw20SpendLimit: [{ address: OTHER, amountBaseUnits: '1000' }],
          cw20Spent: [{ address: OTHER, amountBaseUnits: '10' }],
          resetAt: '2026-11-15T00:00:00.000',
          updatedAt: '2026-10-20T08:00:00.000',
        },
      ],
    });
  });

  it('counts nothing spent once the reset time has passed', async () => {
    const answer = await answerOf(planOf(memberBudgets, {}), {
      nodes: [
        budget({
          periodNs: String(36n * 3_600_000_000_000n),
          periodResetAt: '2026-10-29T11:59:59.000',
          periodSpendLimit: [{ denom: 'upay', amount: '10' }],
          periodSpent: [{ denom: 'upay', amount: '12' }],
        }),
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          collectionId: '8250',
          member: ADDRESS,
          period: '36 hours',
          spendLimit: [pay('10', '0.00001')],
          spent: 'none',
          remaining: [pay('10', '0.00001')],
          cw20SpendLimit: [{ address: OTHER, amountBaseUnits: '1000' }],
          cw20Spent: 'none',
          resetAt: '2026-10-29T11:59:59.000',
          resetDue: true,
          updatedAt: '2026-10-20T08:00:00.000',
        },
      ],
    });
  });

  it('says what an empty limit or spend means instead of an empty list', async () => {
    const answer = await answerOf(planOf(memberBudgets, {}), {
      nodes: [
        // A budget of cw20 tokens only: no bank coin may be committed.
        budget({ periodSpendLimit: [], periodSpent: [], periodCw20Spent: [] }),
        // Bank coins only, nothing spent yet.
        budget({
          periodSpent: [],
          periodCw20SpendLimit: [],
          periodCw20Spent: [],
        }),
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          collectionId: '8250',
          member: ADDRESS,
          period: '30 days',
          spendLimit: 'none allowed',
          spent: 'none',
          cw20SpendLimit: [{ address: OTHER, amountBaseUnits: '1000' }],
          cw20Spent: 'none',
          resetAt: '2026-11-15T00:00:00.000',
          updatedAt: '2026-10-20T08:00:00.000',
        },
        {
          collectionId: '8250',
          member: ADDRESS,
          period: '30 days',
          spendLimit: [
            {
              denom: 'uixo',
              amountBaseUnits: '100000000',
              symbol: 'IXO',
              amount: '100',
              verified: true,
            },
          ],
          spent: 'none',
          remaining: [
            {
              denom: 'uixo',
              amountBaseUnits: '100000000',
              symbol: 'IXO',
              amount: '100',
              verified: true,
            },
          ],
          // No cw20 token may be committed.
          cw20SpendLimit: 'none allowed',
          cw20Spent: 'none',
          resetAt: '2026-11-15T00:00:00.000',
          updatedAt: '2026-10-20T08:00:00.000',
        },
      ],
    });
  });

  it('never shows less than nothing remaining', async () => {
    const answer = await answerOf(planOf(memberBudgets, {}), {
      nodes: [
        budget({
          periodSpendLimit: [{ denom: 'upay', amount: '10' }],
          periodSpent: [{ denom: 'upay', amount: '12' }],
        }),
      ],
    });
    expect(answer.data).toMatchObject({
      items: [{ remaining: [pay('0', '0')] }],
    });
  });

  it('refuses an unexpected shape', async () => {
    const plan = planOf(memberBudgets, {});
    expect(await failureOf(plan, null)).toMatchObject({
      reason: 'unavailable',
    });
    expect(
      await failureOf(plan, { nodes: [{ memberAddress: 1 }] }),
    ).toMatchObject({ reason: 'unavailable' });
  });

  it('clips long index strings', async () => {
    const answer = await answerOf(planOf(memberBudgets, {}), {
      nodes: [
        budget({
          collectionId: long(200, '1'),
          periodSpendLimit: [{ denom: long(200, 'd'), amount: '1' }],
          periodSpent: [],
        }),
      ],
    });
    expect(answer.data).toMatchObject({
      items: [
        {
          collectionId: `${long(119, '1')}…`,
          // A clipped denom is no bank denom: never looked up, base units.
          spendLimit: [
            {
              denom: `${long(119, 'd')}…`,
              amountBaseUnits: '1',
              symbol: `${long(119, 'd')}…`,
              amount: '1',
              verified: false,
            },
          ],
        },
      ],
    });
  });
});
