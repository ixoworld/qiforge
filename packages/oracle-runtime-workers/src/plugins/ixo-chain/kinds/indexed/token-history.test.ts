import { describe, expect, it } from 'vitest';
import { TOKEN_DECIMALS_NOTE } from '../../summaries';
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
// Recorded on mainnet on Oct 29 2026 (`first: 3`): the user has no token
// history, so these are the answers for the accounts of the tables' newest
// rows (a SUPA-ZMW mint, and SUPA-ZMW retirements).
import received from './fixtures/token-history-received.json';
import retired from './fixtures/token-history-retired.json';
import { tokenHistory } from './token-history';

const TRANSFER =
  '{ pageInfo { hasNextPage } nodes { aid from to amount tokenId token { name collection } } }';

describe('token_history', () => {
  it('reads received and sent transfers by default, newest indexed row first', () => {
    expect(planOf(tokenHistory, {}).field('r0')).toBe(
      `r0: query { received: tokenTransactions(filter: { to: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: PRIMARY_KEY_DESC) ${TRANSFER} sent: tokenTransactions(filter: { from: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: PRIMARY_KEY_DESC) ${TRANSFER} }`,
    );
  });

  it('reads one direction when asked', () => {
    expect(planOf(tokenHistory, { direction: 'out' }).field('r1')).toBe(
      `r1: query { sent: tokenTransactions(filter: { from: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: PRIMARY_KEY_DESC) ${TRANSFER} }`,
    );
    expect(
      planOf(tokenHistory, { direction: 'retired', address: OTHER }).field(
        'r0',
      ),
    ).toBe(
      `r0: query { retired: tokenRetireds(filter: { owner: { equalTo: "${OTHER}" } }, first: 10, orderBy: PRIMARY_KEY_DESC) { pageInfo { hasNextPage } nodes { aid id name amount reason jurisdiction } } }`,
    );
    expect(planOf(tokenHistory, { direction: 'cancelled' }).field('r0')).toBe(
      `r0: query { cancelled: tokenCancelleds(filter: { owner: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: PRIMARY_KEY_DESC) { pageInfo { hasNextPage } nodes { aid id name amount reason } } }`,
    );
  });

  it('validates its arguments', () => {
    expect(refusalOf(tokenHistory, { direction: 'burned' })).toMatch(
      /Invalid args for kind "token_history" \(direction:/,
    );
    expect(refusalOf(tokenHistory, { first: 21 })).toMatch(/first:/);
    expect(refusalOf(tokenHistory, { first: 0 })).toMatch(/first:/);
    expect(refusalOf(tokenHistory, { owner: ADDRESS })).toMatch(/owner/);
    expect(refusalOf(tokenHistory, {}, contextOf(NO_ADDRESS))).toBe(
      'The user has no IXO account address; give one.',
    );
    expect(refusalOf(tokenHistory, { address: 'cosmos1abc' })).toMatch(
      /address must be an ixo1… address/,
    );
  });

  it('writes accounts as literals and refuses one carrying GraphQL syntax', () => {
    expect(refusalOf(tokenHistory, { address: INJECTION })).toMatch(
      /address must be/,
    );
    const plan = planOf(tokenHistory, { address: `did:ixo:${OTHER}` });
    expect(plan.field('r0')).toContain(`{ to: { equalTo: "${OTHER}" } }`);
    expect(plan.field('r0')).not.toContain('contains');
  });

  it('reads the call’s clamped row count, not the request’s', () => {
    const field = planOf(
      tokenHistory,
      { first: 20 },
      contextOf(undefined, 5),
    ).field('r0');
    expect(field.match(/first: 5,/g)).toHaveLength(2);
    expect(field).not.toContain('first: 20');
  });

  it('shapes a recorded mint', async () => {
    const plan = planOf(
      tokenHistory,
      { address: 'ixo1476xwgx5zs0fz57ck33cg7n8vghzfp6ggnt334' },
      contextOf(undefined, 3),
    );
    expect(await answerOf(plan, received)).toEqual({
      ok: true,
      subject: 'other',
      first: 3,
      data: {
        note: TOKEN_DECIMALS_NOTE,
        items: [
          {
            direction: 'received',
            tokenId: '8d664229b4e894b2e9f22f72f4f16280',
            name: 'SUPA-ZMW',
            collection: 'did:ixo:entity:28cfd354b648a10205fd4ad0d137f2aa',
            amount: '41000',
            minted: true,
          },
        ],
      },
    });
  });

  it('shapes recorded retirements and says when there are more', async () => {
    const plan = planOf(
      tokenHistory,
      { direction: 'retired' },
      contextOf(undefined, 3),
    );
    const answer = await answerOf(plan, retired);
    expect(answer.subject).toBe('user');
    expect(answer.data).toEqual({
      note: TOKEN_DECIMALS_NOTE,
      more: true,
      items: [
        {
          direction: 'retired',
          tokenId: '8b6a62d7466c2b27c755099b93586285',
          name: 'SUPA-ZMW',
          amount: '13000',
          reason: 'SUPA payment consumed for bag transfer',
          jurisdiction: 'ZM',
        },
        expect.objectContaining({
          tokenId: '081624d290e89a593ad2b93ad6fa8c17',
        }),
        expect.objectContaining({ direction: 'retired', amount: '13000' }),
      ],
    });
  });

  it('merges received and sent by index order and keeps the newest rows', async () => {
    const row = (aid: number, from: string, to: string) => ({
      aid,
      from,
      to,
      amount: '1',
      tokenId: `t${aid}`,
      token: null,
    });
    const plan = planOf(tokenHistory, {}, contextOf(undefined, 2));
    const answer = await answerOf(plan, {
      received: {
        pageInfo: { hasNextPage: false },
        nodes: [row(9, OTHER, ADDRESS), row(3, OTHER, ADDRESS)],
      },
      sent: {
        pageInfo: { hasNextPage: false },
        nodes: [row(7, ADDRESS, ''), row(1, ADDRESS, OTHER)],
      },
    });
    expect(answer.data).toEqual({
      note: TOKEN_DECIMALS_NOTE,
      more: true,
      items: [
        {
          direction: 'received',
          tokenId: 't9',
          amount: '1',
          counterparty: OTHER,
        },
        { direction: 'sent', tokenId: 't7', amount: '1', burned: true },
      ],
    });
  });

  it('answers an empty history and refuses an unexpected shape', async () => {
    const plan = planOf(tokenHistory, {});
    const empty = { pageInfo: { hasNextPage: false }, nodes: [] };
    expect(
      (await answerOf(plan, { received: empty, sent: empty })).data,
    ).toEqual({
      note: TOKEN_DECIMALS_NOTE,
      items: [],
    });
    expect(await failureOf(plan, null)).toMatchObject({
      reason: 'unavailable',
      retryable: false,
    });
    expect(await failureOf(plan, { received: { nodes: 'x' } })).toMatchObject({
      reason: 'unavailable',
    });
  });

  it('clips long index strings', async () => {
    const plan = planOf(tokenHistory, { direction: 'retired' });
    const answer = await answerOf(plan, {
      retired: {
        nodes: [
          {
            aid: 1,
            id: long(300, 'a'),
            name: long(300, 'n'),
            amount: '5',
            reason: long(500, 'r'),
            jurisdiction: long(100, 'j'),
          },
        ],
      },
    });
    expect(answer.data).toEqual({
      note: TOKEN_DECIMALS_NOTE,
      items: [
        {
          direction: 'retired',
          tokenId: `${long(119, 'a')}…`,
          name: `${long(199, 'n')}…`,
          amount: '5',
          reason: `${long(239, 'r')}…`,
          jurisdiction: `${long(79, 'j')}…`,
        },
      ],
    });
  });
});
