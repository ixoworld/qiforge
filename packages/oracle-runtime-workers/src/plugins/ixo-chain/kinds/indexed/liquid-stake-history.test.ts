import { describe, expect, it } from 'vitest';
import {
  ADDRESS,
  INJECTION,
  NO_ADDRESS,
  answerOf,
  contextOf,
  failureOf,
  long,
  planOf,
  refusalOf,
} from './fixtures/context';
// Recorded on mainnet on Oct 29 2026 (`first: 3`): the user has no liquid
// staking history, so this is the answer for the delegator of the newest
// `unstake` row.
import recorded from './fixtures/liquid-stake-history.json';
import { liquidStakeHistory } from './liquid-stake-history';

const NODES =
  '{ pageInfo { hasNextPage } nodes { kind poolId payload transactionHash height timestamp } }';
const DELEGATOR = 'ixo1axp72yt8qltre8pxgtt2g909s76794v2n7xw2h';

const ixo = (amountBaseUnits: string, amount: string) => ({
  denom: 'uixo',
  amountBaseUnits,
  symbol: 'IXO',
  amount,
  verified: true,
});
/** PAY from the chain's own DenomMetadata (6 decimals). */
const pay = (amountBaseUnits: string, amount: string) => ({
  denom: 'upay',
  amountBaseUnits,
  symbol: 'PAY',
  amount,
  verified: true,
});

describe('liquid_stake_history', () => {
  it('reads the user’s events newest first', () => {
    expect(planOf(liquidStakeHistory, {}).field('r0')).toBe(
      `r0: liquidStakeTxes(filter: { delegator: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: ID_DESC) ${NODES}`,
    );
  });

  it('validates its arguments', () => {
    expect(refusalOf(liquidStakeHistory, { poolId: 'pay' })).toMatch(/poolId/);
    expect(refusalOf(liquidStakeHistory, { first: 30 })).toMatch(/first:/);
    expect(refusalOf(liquidStakeHistory, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
  });

  it('refuses an address carrying GraphQL syntax and uses no containment', () => {
    expect(refusalOf(liquidStakeHistory, { address: INJECTION })).toMatch(
      /address must be/,
    );
    const field = planOf(liquidStakeHistory, {
      address: `did:ixo:${DELEGATOR}`,
    }).field('r0');
    expect(field).toContain(`{ delegator: { equalTo: "${DELEGATOR}" } }`);
    expect(field).not.toContain('contains');
  });

  it('reads the call’s clamped row count', () => {
    expect(
      planOf(liquidStakeHistory, {}, contextOf(undefined, 5)).field('r0'),
    ).toContain('first: 5,');
  });

  it('shapes a recorded answer', async () => {
    const plan = planOf(
      liquidStakeHistory,
      { address: DELEGATOR },
      contextOf(undefined, 3),
    );
    expect(await answerOf(plan, recorded)).toEqual({
      ok: true,
      subject: 'other',
      first: 3,
      data: {
        items: [
          {
            kind: 'stake',
            meaning: 'staked through the pool, receiving its liquid token',
            poolId: 'pay',
            coins: {
              staked: ixo('10000000000', '10000'),
              received: pay('10000000000', '10000'),
            },
            txHash:
              '4FC61CE1BA49ED4A77311857F697B1C96C0FD049F6DC486715CBAD62513C7488',
            height: '18502876',
            time: '2026-08-04T07:42:05.922',
          },
          {
            kind: 'unstake',
            meaning: "returned the pool's liquid token to unstake",
            poolId: 'pay',
            coins: {
              returned: pay('1000000', '1'),
              unbonding: ixo('899986', '0.899986'),
              unbonded: ixo('0', '0'),
            },
            completionTime: '2026-08-25T05:43:03.888499954Z',
            txHash:
              '951D847D0D380A07694BAC20C6CFA08184AA2352D2E2B2DB6818C0CD5726D134',
            height: '18501590',
            time: '2026-08-04T05:43:03.888',
          },
          expect.objectContaining({
            kind: 'stake',
            coins: {
              staked: ixo('1000000', '1'),
              received: pay('1000000', '1'),
            },
          }),
        ],
      },
    });
  });

  it('reads the amount strings events carried before chain v7', async () => {
    const answer = await answerOf(planOf(liquidStakeHistory, {}), {
      nodes: [
        {
          kind: 'stake',
          poolId: 'legacy',
          payload: {
            liquid_amount: '100000000uixo',
            stk_ixo_minted_amount: 'not an amount',
          },
          height: 7,
        },
        { kind: 'rebalance', payload: 'x', height: '8' },
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          kind: 'stake',
          meaning: 'staked through the pool, receiving its liquid token',
          poolId: 'legacy',
          coins: { staked: ixo('100000000', '100') },
          height: '7',
        },
        {
          kind: 'rebalance',
          meaning: 'the pool moved stake between validators',
          height: '8',
        },
      ],
    });
  });

  it('answers an empty history and refuses an unexpected shape', async () => {
    const plan = planOf(liquidStakeHistory, {});
    expect((await answerOf(plan, { nodes: [] })).data).toEqual({ items: [] });
    expect(await failureOf(plan, null)).toMatchObject({
      reason: 'unavailable',
    });
    expect(await failureOf(plan, { nodes: [{ kind: 3 }] })).toMatchObject({
      reason: 'unavailable',
    });
  });

  it('clips long index strings', async () => {
    const answer = await answerOf(planOf(liquidStakeHistory, {}), {
      nodes: [
        {
          kind: long(100, 'k'),
          poolId: long(200, 'p'),
          transactionHash: long(200, 'h'),
          payload: {},
        },
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          kind: `${long(39, 'k')}…`,
          poolId: `${long(119, 'p')}…`,
          txHash: `${long(119, 'h')}…`,
        },
      ],
    });
  });
});
