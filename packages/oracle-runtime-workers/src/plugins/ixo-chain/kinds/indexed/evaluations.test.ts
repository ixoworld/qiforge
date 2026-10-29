import { describe, expect, it } from 'vitest';
import { evaluations } from './evaluations';
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
// Recorded on mainnet on Oct 29 2026 (`first: 3`, collection 751): the
// user has evaluated nothing, so this is the collection of the table's
// newest row.
import recorded from './fixtures/evaluations.json';

const NODES =
  '{ pageInfo { hasNextPage } nodes { claimId collectionId oracle agentDid agentAddress status reason verificationProof amount cw20Payment cw1155Payment evaluationDate } }';
const CLAIM = 'bafkreibl6puxqkuhz5d5j355kkb5gcsw3ud62cujo7nhyimhk4j6j5pye4';
const EVALUATOR = 'ixo1n280ly8a7amr062jw3g9ct8e5hgvx559wa7ynu';

describe('evaluations', () => {
  it('reads what the user evaluated by default, in index order', () => {
    expect(planOf(evaluations, {}).field('r0')).toBe(
      `r0: evaluations(filter: { agentAddress: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: ID_DESC) ${NODES}`,
    );
  });

  it('reads a claim or a collection newest evaluation first', () => {
    expect(planOf(evaluations, { claimId: CLAIM }).field('r0')).toBe(
      `r0: evaluations(filter: { claimId: { equalTo: "${CLAIM}" } }, first: 10, orderBy: EVALUATION_DATE_DESC) ${NODES}`,
    );
    expect(planOf(evaluations, { collectionId: '751' }).field('r0')).toBe(
      `r0: evaluations(filter: { collectionId: { equalTo: "751" } }, first: 10, orderBy: EVALUATION_DATE_DESC) ${NODES}`,
    );
  });

  it('validates its arguments', () => {
    expect(
      refusalOf(evaluations, { claimId: CLAIM, collectionId: '751' }),
    ).toMatch(/at most one of claimId, collectionId and evaluator/);
    expect(
      refusalOf(evaluations, { evaluator: OTHER, collectionId: '751' }),
    ).toMatch(/at most one/);
    expect(refusalOf(evaluations, { collectionId: 'abc' })).toMatch(
      /collectionId: a collection number/,
    );
    expect(refusalOf(evaluations, { claimId: 'short' })).toMatch(
      /claimId: a claim id/,
    );
    expect(refusalOf(evaluations, { agent: ADDRESS })).toMatch(/agent/);
    expect(refusalOf(evaluations, { first: 50 })).toMatch(/first:/);
    expect(refusalOf(evaluations, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
    // A collection or claim needs no account of the user's.
    expect(() =>
      planOf(evaluations, { collectionId: '751' }, contextOf(NO_ADDRESS)),
    ).not.toThrow();
  });

  it('writes values as literals and refuses ones carrying GraphQL syntax', () => {
    expect(refusalOf(evaluations, { evaluator: INJECTION })).toMatch(
      /evaluator must be/,
    );
    expect(refusalOf(evaluations, { claimId: `${CLAIM}"` })).toMatch(/claimId/);
    const field = planOf(evaluations, {
      evaluator: `did:ixo:${EVALUATOR}`,
    }).field('r0');
    expect(field).toContain(`{ agentAddress: { equalTo: "${EVALUATOR}" } }`);
    expect(field).not.toContain('contains');
  });

  it('reads the call’s clamped row count', () => {
    expect(
      planOf(evaluations, { first: 20 }, contextOf(undefined, 5)).field('r0'),
    ).toContain('first: 5,');
  });

  it('shapes a recorded answer', async () => {
    const plan = planOf(
      evaluations,
      { collectionId: '751' },
      contextOf(undefined, 3),
    );
    const answer = await answerOf(plan, recorded);
    expect(answer.subject).toBeUndefined();
    expect(answer.first).toBe(3);
    expect(answer.data).toEqual({
      more: true,
      items: [
        {
          claimId: CLAIM,
          collectionId: '751',
          status: 'approved',
          evaluationDate: '2026-10-29T14:55:29.676',
          evaluatorAddress: EVALUATOR,
          evaluatorDid: `did:ixo:${EVALUATOR}`,
          oracle: `did:ixo:${EVALUATOR}`,
          reasonCode: '1',
          verificationProof: CLAIM,
          // No amounts set: an approval pays the collection's default.
          defaultPayment: true,
        },
        expect.objectContaining({
          claimId:
            'bafkreibtp27a4svbm33dgmybf3c3d6qcwnj5yzv5kodr4tljgzadbm7f2u',
          status: 'approved',
        }),
        expect.objectContaining({ status: 'approved' }),
      ],
    });
  });

  it('shapes statuses, custom payments and the user subject', async () => {
    const plan = planOf(evaluations, {});
    const answer = await answerOf(plan, {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          claimId: CLAIM,
          collectionId: '1',
          status: 5,
          reason: 0,
          amount: [
            { denom: 'uixo', amount: '2500000' },
            { denom: 'upay', amount: '5740000' },
            { denom: 'uunknown', amount: '12' },
          ],
          cw20Payment: [{ address: OTHER, amount: '7' }],
          cw1155Payment: [
            {
              address: OTHER,
              token_id: ['CARBON:bafy1', 'CARBON:bafy2'],
              amount: '3',
            },
          ],
        },
        { claimId: CLAIM, collectionId: '1', status: 9, amount: [] },
      ],
    });
    expect(answer.subject).toBe('user');
    expect(answer.data).toEqual({
      items: [
        {
          claimId: CLAIM,
          collectionId: '1',
          status: 'flagged',
          reasonCode: '0',
          coins: [
            {
              denom: 'uixo',
              amountBaseUnits: '2500000',
              symbol: 'IXO',
              amount: '2.5',
              verified: true,
            },
            // PAY from the chain's own DenomMetadata (6 decimals).
            {
              denom: 'upay',
              amountBaseUnits: '5740000',
              symbol: 'PAY',
              amount: '5.74',
              verified: true,
            },
            // No metadata: base units under the full denom.
            {
              denom: 'uunknown',
              amountBaseUnits: '12',
              symbol: 'uunknown',
              amount: '12',
              verified: false,
            },
          ],
          cw20: [{ address: OTHER, amountBaseUnits: '7' }],
          cw1155: [
            {
              address: OTHER,
              tokenIds: ['CARBON:bafy1', 'CARBON:bafy2'],
              amount: '3',
            },
          ],
        },
        {
          claimId: CLAIM,
          collectionId: '1',
          status: 'unknown (9)',
          defaultPayment: true,
        },
      ],
    });
  });

  it('answers an empty list and refuses an unexpected shape', async () => {
    const plan = planOf(evaluations, {});
    expect(
      (await answerOf(plan, { pageInfo: { hasNextPage: false }, nodes: [] }))
        .data,
    ).toEqual({ items: [] });
    expect(await failureOf(plan, null)).toMatchObject({
      reason: 'unavailable',
      retryable: false,
    });
  });

  it('clips long index strings', async () => {
    const plan = planOf(evaluations, {});
    const answer = await answerOf(plan, {
      nodes: [
        {
          claimId: long(200, 'c'),
          collectionId: '1',
          oracle: long(300, 'o'),
          verificationProof: long(300, 'p'),
        },
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          claimId: `${long(119, 'c')}…`,
          collectionId: '1',
          oracle: `${long(119, 'o')}…`,
          verificationProof: `${long(119, 'p')}…`,
          defaultPayment: true,
        },
      ],
    });
  });

  it('never calls a payment of only cw20 or cw1155 tokens the default', async () => {
    const plan = planOf(evaluations, {});
    const answer = await answerOf(plan, {
      nodes: [
        {
          claimId: CLAIM,
          collectionId: '1',
          status: 1,
          amount: [],
          cw20Payment: [],
          cw1155Payment: [{ address: OTHER, token_id: ['T1'], amount: '2' }],
        },
        {
          claimId: CLAIM,
          collectionId: '1',
          status: 1,
          amount: [],
          cw20Payment: [{ address: OTHER, amount: '9' }],
          cw1155Payment: null,
        },
      ],
    });
    expect(answer.data).toEqual({
      items: [
        {
          claimId: CLAIM,
          collectionId: '1',
          status: 'approved',
          cw1155: [{ address: OTHER, tokenIds: ['T1'], amount: '2' }],
        },
        {
          claimId: CLAIM,
          collectionId: '1',
          status: 'approved',
          cw20: [{ address: OTHER, amountBaseUnits: '9' }],
        },
      ],
    });
  });
});
