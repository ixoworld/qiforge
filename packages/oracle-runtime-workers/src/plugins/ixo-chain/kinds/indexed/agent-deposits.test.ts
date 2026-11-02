import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentDeposits } from './agent-deposits';
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
// Recorded on devnet on Oct 29 2026 (`first: 3`): neither mainnet nor
// testnet indexed a performance deposit that day.
import recorded from './fixtures/agent-deposits.json';

const NODES =
  '{ pageInfo { hasNextPage } nodes { collectionId agentAddress amount withdrawableAt updatedAt } }';
const AGENT = 'ixo1u4m0hwtysne8y7pkq9tj45ksp38ps9p347a5tr';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('agent_deposits', () => {
  it('reads the user’s deposits, optionally in one collection', () => {
    expect(planOf(agentDeposits, {}).field('r0')).toBe(
      `r0: agentDepositBalances(filter: { agentAddress: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: PRIMARY_KEY_ASC) ${NODES}`,
    );
    expect(planOf(agentDeposits, { collectionId: '794' }).field('r0')).toBe(
      `r0: agentDepositBalances(filter: { agentAddress: { equalTo: "${ADDRESS}" }, collectionId: { equalTo: "794" } }, first: 10, orderBy: PRIMARY_KEY_ASC) ${NODES}`,
    );
  });

  it('validates its arguments', () => {
    expect(refusalOf(agentDeposits, { collectionId: 794 })).toMatch(
      /collectionId:/,
    );
    expect(refusalOf(agentDeposits, { agent: ADDRESS })).toMatch(/agent/);
    expect(refusalOf(agentDeposits, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
  });

  it('refuses values carrying GraphQL syntax and uses no containment', () => {
    expect(refusalOf(agentDeposits, { address: INJECTION })).toMatch(
      /address must be/,
    );
    const field = planOf(agentDeposits, {
      address: `did:ixo:${OTHER}`,
    }).field('r0');
    expect(field).toContain(`{ agentAddress: { equalTo: "${OTHER}" } }`);
    expect(field).not.toContain('contains');
  });

  it('reads the call’s clamped row count', () => {
    expect(
      planOf(agentDeposits, {}, contextOf(undefined, 5)).field('r0'),
    ).toContain('first: 5,');
  });

  it('shapes a recorded deposit whose lock has ended', async () => {
    const plan = planOf(
      agentDeposits,
      { address: AGENT },
      contextOf(undefined, 3, 'devnet'),
    );
    expect(await answerOf(plan, recorded)).toEqual({
      ok: true,
      subject: 'other',
      first: 3,
      data: {
        items: [
          {
            collectionId: '794',
            agent: AGENT,
            coin: {
              denom: 'uixo',
              amountBaseUnits: '500000',
              symbol: 'IXO',
              amount: '0.5',
              verified: true,
            },
            withdrawableAt: '2026-07-25T15:24:10.518',
            lockEnded: true,
            updatedAt: '2026-07-25T15:24:10.518',
          },
        ],
      },
    });
  });

  it('reads index times as UTC and a zero time as no lock', async () => {
    const answer = await answerOf(planOf(agentDeposits, {}), {
      nodes: [
        {
          collectionId: '1',
          agentAddress: ADDRESS,
          amount: [{ denom: 'upay', amount: '3' }],
          withdrawableAt: '2026-10-29T12:00:01.000',
        },
        {
          collectionId: '2',
          agentAddress: ADDRESS,
          amount: [],
          withdrawableAt: '0001-01-01T00:00:00',
        },
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          collectionId: '1',
          agent: ADDRESS,
          // PAY from the chain's own DenomMetadata (6 decimals).
          coin: {
            denom: 'upay',
            amountBaseUnits: '3',
            symbol: 'PAY',
            amount: '0.000003',
            verified: true,
          },
          withdrawableAt: '2026-10-29T12:00:01.000',
          lockEnded: false,
        },
        {
          collectionId: '2',
          agent: ADDRESS,
          coin: 'none',
          withdrawableAt: '0001-01-01T00:00:00',
          lockEnded: true,
        },
      ],
    });
  });

  it('lists a balance of several denoms as coins', async () => {
    const answer = await answerOf(planOf(agentDeposits, {}), {
      nodes: [
        {
          collectionId: '1',
          agentAddress: ADDRESS,
          amount: [
            { denom: 'uixo', amount: '1000000' },
            { denom: 'upay', amount: '2000000' },
          ],
          withdrawableAt: '2026-10-29T11:00:00.000',
        },
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          collectionId: '1',
          agent: ADDRESS,
          coins: [
            {
              denom: 'uixo',
              amountBaseUnits: '1000000',
              symbol: 'IXO',
              amount: '1',
              verified: true,
            },
            {
              denom: 'upay',
              amountBaseUnits: '2000000',
              symbol: 'PAY',
              amount: '2',
              verified: true,
            },
          ],
          withdrawableAt: '2026-10-29T11:00:00.000',
          lockEnded: true,
        },
      ],
    });
  });

  it('answers an empty list and refuses an unexpected shape', async () => {
    const plan = planOf(agentDeposits, {});
    expect((await answerOf(plan, { nodes: [] })).data).toEqual({ items: [] });
    expect(await failureOf(plan, null)).toMatchObject({
      reason: 'unavailable',
    });
  });

  it('clips long index strings', async () => {
    const answer = await answerOf(planOf(agentDeposits, {}), {
      nodes: [
        {
          collectionId: '1',
          agentAddress: long(300, 'a'),
          amount: [{ denom: 'uixo', amount: long(100, '9') }],
          withdrawableAt: 'not a date',
        },
      ],
    });
    // An amount longer than any bank amount (40 digits) is no coin: left out.
    expect(answer.data).toEqual({
      items: [
        {
          collectionId: '1',
          agent: `${long(119, 'a')}…`,
          withdrawableAt: 'not a date',
        },
      ],
    });
  });
});
