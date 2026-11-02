import { describe, expect, it } from 'vitest';
import { disputes } from './disputes';
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
// Recorded on mainnet on Oct 29 2026 (`first: 3`): the user has filed no
// dispute, so this is the answer for the claim of the table's newest row.
import recorded from './fixtures/disputes.json';

const NODES =
  '{ pageInfo { hasNextPage } nodes { id subjectId type targetRole status disputerAddress disputerDid disputeDeposit submittedAt resolution { resolvedAt adjudicatorDid adjudicatorAddress intendedPenalty actualPenaltyPaid winnerAddress winnerAmount loserAddress adjudicatorAmount } } }';
const CLAIM = 'bafkreibqh2o3cx2bhnvxhoknbashrse3lhxh5rjohyqgy5yoqqc5jhqgpm';

describe('disputes', () => {
  it('reads the disputes the user filed by default, newest first', () => {
    expect(planOf(disputes, {}).field('r0')).toBe(
      `r0: disputes(filter: { disputerAddress: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: ID_DESC) ${NODES}`,
    );
  });

  it('reads the disputes against a claim', () => {
    expect(planOf(disputes, { claimId: CLAIM }).field('r0')).toBe(
      `r0: disputes(filter: { subjectId: { equalTo: "${CLAIM}" } }, first: 10, orderBy: ID_DESC) ${NODES}`,
    );
    expect(() =>
      planOf(disputes, { claimId: CLAIM }, contextOf(NO_ADDRESS)),
    ).not.toThrow();
  });

  it('validates its arguments', () => {
    expect(refusalOf(disputes, { claimId: CLAIM, address: OTHER })).toMatch(
      /give claimId or address, not both/,
    );
    expect(refusalOf(disputes, { claimId: 'x' })).toMatch(/claimId:/);
    expect(refusalOf(disputes, { status: 'open' })).toMatch(/status/);
    expect(refusalOf(disputes, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
  });

  it('refuses values carrying GraphQL syntax and uses no containment', () => {
    expect(refusalOf(disputes, { address: INJECTION })).toMatch(
      /address must be/,
    );
    expect(refusalOf(disputes, { claimId: `${CLAIM} } }` })).toMatch(
      /claimId:/,
    );
    expect(planOf(disputes, {}).field('r0')).not.toContain('contains');
  });

  it('reads the call’s clamped row count', () => {
    expect(
      planOf(disputes, { first: 9 }, contextOf(undefined, 5)).field('r0'),
    ).toContain('first: 5,');
  });

  it('shapes a recorded open dispute', async () => {
    const plan = planOf(disputes, { claimId: CLAIM }, contextOf(undefined, 3));
    expect(await answerOf(plan, recorded)).toEqual({
      ok: true,
      first: 3,
      data: {
        items: [
          {
            id: '2',
            claimId: CLAIM,
            against: 'submitter',
            status: 'open',
            type: 1,
            disputer: 'ixo1nawclxlpwk5ftgqka2nkhup2kxnulc4nkhnk7m',
            disputerDid: 'did:ixo:entity:02dacb4357a852a3bf29e749f3e0f374',
            submittedAt: '2026-10-29T13:22:38.723',
          },
        ],
      },
    });
  });

  it('shapes a resolution', async () => {
    const coin = (amount: string) => [{ denom: 'uixo', amount }];
    const answer = await answerOf(planOf(disputes, {}), {
      nodes: [
        {
          id: 7,
          subjectId: CLAIM,
          type: 0,
          targetRole: 2,
          status: 1,
          disputerAddress: ADDRESS,
          disputeDeposit: coin('1000000'),
          resolution: {
            resolvedAt: '2026-10-30T00:00:00.000',
            adjudicatorAddress: OTHER,
            adjudicatorDid: 'did:ixo:entity:0123456789abcdef0123456789abcdef',
            intendedPenalty: coin('5000000'),
            actualPenaltyPaid: coin('4000000'),
            winnerAddress: ADDRESS,
            winnerAmount: coin('3200000'),
            loserAddress: OTHER,
            adjudicatorAmount: coin('800000'),
          },
        },
        { id: '8', subjectId: CLAIM, targetRole: 5, status: 4 },
      ],
    });
    const ixo = (amountBaseUnits: string, amount: string) => [
      { denom: 'uixo', amountBaseUnits, symbol: 'IXO', amount, verified: true },
    ];
    expect(answer.subject).toBe('user');
    expect(answer.data).toEqual({
      items: [
        {
          id: '7',
          claimId: CLAIM,
          against: 'evaluator',
          status: 'awarded',
          type: 0,
          disputer: ADDRESS,
          deposit: ixo('1000000', '1'),
          resolution: {
            resolvedAt: '2026-10-30T00:00:00.000',
            adjudicator: OTHER,
            adjudicatorDid: 'did:ixo:entity:0123456789abcdef0123456789abcdef',
            intendedPenalty: ixo('5000000', '5'),
            penaltyPaid: ixo('4000000', '4'),
            winner: ADDRESS,
            winnerAmount: ixo('3200000', '3.2'),
            loser: OTHER,
            adjudicatorAmount: ixo('800000', '0.8'),
          },
        },
        {
          id: '8',
          claimId: CLAIM,
          against: 'unknown (5)',
          status: 'unknown (4)',
        },
      ],
    });
  });

  it('answers an empty list and refuses an unexpected shape', async () => {
    const plan = planOf(disputes, {});
    expect((await answerOf(plan, { nodes: [] })).data).toEqual({ items: [] });
    expect(await failureOf(plan, null)).toMatchObject({
      reason: 'unavailable',
    });
    expect(
      await failureOf(plan, { nodes: [{ id: 1, subjectId: 2 }] }),
    ).toMatchObject({ reason: 'unavailable' });
  });

  it('clips long index strings', async () => {
    const answer = await answerOf(planOf(disputes, {}), {
      nodes: [
        {
          id: 1,
          subjectId: long(150, 's'),
          disputerDid: long(150, 'd'),
          status: 0,
        },
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          id: '1',
          claimId: `${long(119, 's')}…`,
          disputerDid: `${long(119, 'd')}…`,
          status: 'open',
        },
      ],
    });
  });
});
