import { describe, expect, it } from 'vitest';
import {
  ENTITIES_ORDER,
  ENTITY_STATUS_NOTE,
  EXCERPT_CHARS,
  ID_CHARS,
  MEMO_CHARS,
  TEXT_CHARS,
  TOKEN_DECIMALS_NOTE,
  shapeResult,
  summarizeMessage,
} from './summaries';

const A = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
const B = 'ixo1x4p6j0h3mzv8e7mhd6q9wquh2vqd9yh5ttnzyg';

describe('summarizeMessage', () => {
  it('summarises a bank send as from, to and coins in base units', () => {
    expect(
      summarizeMessage('/cosmos.bank.v1beta1.MsgSend', {
        fromAddress: A,
        toAddress: B,
        amount: [{ denom: 'uixo', amount: '1000000' }],
      }),
    ).toEqual({
      type: 'MsgSend',
      from: A,
      to: B,
      amount: [{ denom: 'uixo', amountBaseUnits: '1000000' }],
    });
  });

  it('summarises a 1155 transfer', () => {
    expect(
      summarizeMessage('/ixo.token.v1beta1.MsgTransferToken', {
        owner: A,
        recipient: B,
        tokens: [{ id: 'f'.repeat(32), amount: '3' }],
      }),
    ).toEqual({
      type: 'MsgTransferToken',
      from: A,
      to: B,
      tokens: [{ id: 'f'.repeat(32), amount: '3' }],
    });
  });

  it('unwraps an authz MsgExec stored as its inner messages', () => {
    expect(
      summarizeMessage('/cosmos.authz.v1beta1.MsgExec', [
        {
          typeUrl: '/ixo.claims.v1beta1.MsgSubmitClaim',
          value: {
            claimId: 'bafyclaim',
            collectionId: '8250',
            agentAddress: A,
          },
        },
        {
          typeUrl: '/ixo.claims.v1beta1.MsgEvaluateClaim',
          value: { claim_id: 'bafyclaim', collection_id: '8250', status: 1 },
        },
      ]),
    ).toEqual({
      type: 'MsgExec',
      count: 2,
      messages: [
        { type: 'MsgSubmitClaim', claimId: 'bafyclaim', collectionId: '8250' },
        {
          type: 'MsgEvaluateClaim',
          claimId: 'bafyclaim',
          collectionId: '8250',
          status: 'approved',
        },
      ],
    });
  });

  it('caps an exec at five inner messages and one level', () => {
    const inner = {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} }],
    };
    const summary = summarizeMessage(
      '/cosmos.authz.v1beta1.MsgExec',
      Array.from({ length: 7 }, () => inner),
    );
    expect(summary).toMatchObject({ type: 'MsgExec', count: 7 });
    if (!('messages' in summary)) throw new Error('expected an exec summary');
    expect(summary.messages).toHaveLength(5);
    expect(summary.messages[0]).toMatchObject({
      type: 'MsgExec',
      messages: [{ type: 'message' }],
    });
  });

  it('falls back to a short excerpt for anything else', () => {
    const summary = summarizeMessage('/ixo.entity.v1beta1.MsgCreateEntity', {
      entityType: 'dao',
      blob: 'x'.repeat(5_000),
    });
    if (!('excerpt' in summary)) throw new Error('expected an excerpt');
    expect(summary.type).toBe('MsgCreateEntity');
    expect(summary.excerpt).toHaveLength(EXCERPT_CHARS);
    expect(summary.excerpt.endsWith('…')).toBe(true);
    expect(summary.excerpt.startsWith('{"entityType":"dao"')).toBe(true);
  });
});

describe('shapeResult', () => {
  it('shapes claims with their status words and a cursor only when there is more', () => {
    const shaped = shapeResult(
      { kind: 'claims' },
      {
        totalCount: 5,
        pageInfo: { hasNextPage: true, endCursor: 'WyJ4Il0=' },
        nodes: [
          {
            claimId: 'bafyclaim',
            collectionId: '8253',
            agentDid: `did:ixo:${A}`,
            agentAddress: A,
            submissionDate: '2026-09-20T09:00:00.000',
            paymentsStatus: {
              approval: 'NO_PAYMENT',
              evaluation: 'PAID',
              rejection: 'NO_PAYMENT',
              submission: 'NO_PAYMENT',
            },
            schemaType: null,
            useIntent: false,
            amount: null,
            currentEvaluationId: '327834',
            evaluation: {
              status: 2,
              evaluationDate: '2026-09-20T09:38:05.794',
            },
          },
        ],
      },
    );
    expect(shaped).toEqual({
      ok: true,
      data: {
        totalCount: 5,
        hasNextPage: true,
        endCursor: 'WyJ4Il0=',
        items: [
          {
            claimId: 'bafyclaim',
            collectionId: '8253',
            agentDid: `did:ixo:${A}`,
            agentAddress: A,
            submissionDate: '2026-09-20T09:00:00.000',
            paymentsStatus: {
              approval: 'NO_PAYMENT',
              evaluation: 'PAID',
              rejection: 'NO_PAYMENT',
              submission: 'NO_PAYMENT',
            },
            useIntent: false,
            currentEvaluationId: '327834',
            evaluation: {
              status: 'rejected',
              evaluationDate: '2026-09-20T09:38:05.794',
            },
          },
        ],
      },
    });
  });

  it('answers not_found for a missing single object', () => {
    expect(
      shapeResult({ kind: 'claim', claimId: 'x'.repeat(20) }, null),
    ).toMatchObject({
      ok: false,
      failure: { reason: 'not_found' },
    });
    expect(
      shapeResult({ kind: 'transaction', hash: 'A'.repeat(64) }, { nodes: [] }),
    ).toMatchObject({ ok: false, failure: { reason: 'not_found' } });
  });

  it('says whose a by-id record is: the claim agent, the collection admin, the entity owner', () => {
    const claim = shapeResult(
      { kind: 'claim', claimId: 'x'.repeat(20) },
      { claimId: 'bafyclaim', collectionId: '1', agentAddress: A },
    );
    expect(claim).toMatchObject({ ok: true, ownedBy: [A] });
    const collection = shapeResult(
      { kind: 'claim_collection', id: '1' },
      { id: '1', admin: B, state: 0 },
    );
    expect(collection).toMatchObject({ ok: true, ownedBy: [B] });
    const entity = shapeResult(
      { kind: 'entity', id: `did:ixo:entity:${'c'.repeat(32)}` },
      { id: 'did:ixo:entity:c', owner: null },
    );
    expect(entity).toMatchObject({ ok: true, ownedBy: [] });
  });

  it("shapes a collection's payments with bank and cw20 amounts in base units", () => {
    const shaped = shapeResult(
      { kind: 'claim_collection', id: '8250' },
      {
        id: '8250',
        admin: A,
        state: 0,
        payments: {
          approval: {
            account: B,
            amount: [{ denom: 'uixo', amount: '5000000' }],
            cw20_payment: [{ address: 'ixo1cw20', amount: '7' }],
            cw1155_payment: [
              { address: 'ixo1cw1155', token_id: ['t1'], amount: '2' },
            ],
            is_oracle_payment: true,
            timeout_ns: '0s',
            contract_1155_payment: null,
          },
          submission: { account: B, amount: [] },
          evaluation: null,
        },
      },
    );
    expect(shaped).toEqual({
      ok: true,
      ownedBy: [A],
      data: {
        id: '8250',
        admin: A,
        state: 'open',
        payments: {
          approval: {
            account: B,
            amount: [{ denom: 'uixo', amountBaseUnits: '5000000' }],
            cw20: [{ address: 'ixo1cw20', amountBaseUnits: '7' }],
            cw1155: [{ address: 'ixo1cw1155', tokenIds: ['t1'], amount: '2' }],
            oraclePayment: true,
          },
          submission: { account: B },
        },
      },
    });
  });

  it('clips every indexed string: ids, names, memos', () => {
    const long = 'z'.repeat(1_000);
    const claims = shapeResult(
      { kind: 'claims' },
      {
        totalCount: 1,
        nodes: [{ claimId: long, collectionId: long, agentAddress: long }],
      },
    );
    if (!claims.ok) throw new Error('expected claims');
    const [claim] = JSON.parse(JSON.stringify(claims.data)).items;
    expect(claim.claimId).toHaveLength(ID_CHARS);
    expect(claim.agentAddress).toHaveLength(ID_CHARS);
    const tokens = shapeResult(
      { kind: 'token_balances' },
      {
        totalCount: 1,
        nodes: [
          {
            tokenId: long,
            amount: '1',
            token: { name: long, collection: long },
          },
        ],
      },
    );
    if (!tokens.ok) throw new Error('expected tokens');
    const [token] = JSON.parse(JSON.stringify(tokens.data)).items;
    expect(token.tokenId).toHaveLength(ID_CHARS);
    expect(token.name).toHaveLength(TEXT_CHARS);
    expect(token.collection).toHaveLength(ID_CHARS);
    const tx = shapeResult(
      { kind: 'transaction', hash: 'A'.repeat(64) },
      { nodes: [{ hash: long, height: 1, time: long, code: 0, memo: long }] },
    );
    if (!tx.ok) throw new Error('expected a transaction');
    const row = JSON.parse(JSON.stringify(tx.data));
    expect(row.hash).toHaveLength(ID_CHARS);
    expect(row.time).toHaveLength(ID_CHARS);
    expect(row.memo).toHaveLength(MEMO_CHARS);
    expect(row.memo.endsWith('…')).toBe(true);
  });

  it('shows 1155 balances as whole units with the class from its relation', () => {
    expect(
      shapeResult(
        { kind: 'token_balances' },
        {
          totalCount: 1,
          nodes: [
            {
              tokenId: 'a'.repeat(32),
              amount: '12',
              retired: '3',
              token: {
                name: 'CARBON',
                collection: 'did:ixo:entity:c',
                tokenClassByName: {
                  contractAddress: 'ixo1contract',
                  class: 'did:ixo:entity:k',
                },
              },
            },
          ],
        },
      ),
    ).toEqual({
      ok: true,
      data: {
        totalCount: 1,
        note: TOKEN_DECIMALS_NOTE,
        items: [
          {
            tokenId: 'a'.repeat(32),
            name: 'CARBON',
            class: 'did:ixo:entity:k',
            collection: 'did:ixo:entity:c',
            amount: '12',
            retired: '3',
            contractAddress: 'ixo1contract',
          },
        ],
      },
    });
  });

  it('lists a signed transaction once even when it names the signer twice', () => {
    const transaction = {
      hash: 'H1',
      height: 10,
      time: '2026-10-01T00:00:00',
      code: 0,
      memo: '',
      messagesByTransactionHash: {
        totalCount: 21,
        nodes: [
          {
            typeUrl: '/cosmos.bank.v1beta1.MsgSend',
            index: 0,
            value: { fromAddress: A, toAddress: B, amount: [] },
          },
        ],
      },
    };
    expect(
      shapeResult(
        { kind: 'transactions' },
        {
          totalCount: 2,
          nodes: [
            { transactionHash: 'H1', transaction },
            { transactionHash: 'H1', transaction },
          ],
        },
      ),
    ).toEqual({
      ok: true,
      data: {
        totalCount: 2,
        items: [
          {
            hash: 'H1',
            height: 10,
            time: '2026-10-01T00:00:00',
            code: 0,
            succeeded: true,
            messages: [{ type: 'MsgSend', from: A, to: B, amount: [] }],
            messageCount: 21,
          },
        ],
      },
    });
  });

  it('groups received messages by transaction and says whether it succeeded', () => {
    const tx = { hash: 'H2', height: 11, time: 't', code: 5, memo: 'thanks' };
    const send = {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: B,
        toAddress: A,
        amount: [{ denom: 'uixo', amount: '5' }],
      },
    };
    expect(
      shapeResult(
        { kind: 'transactions', direction: 'received' },
        {
          totalCount: 2,
          nodes: [
            {
              ...send,
              index: 0,
              transactionHash: 'H2',
              transactionByTransactionHash: tx,
            },
            {
              ...send,
              index: 1,
              transactionHash: 'H2',
              transactionByTransactionHash: tx,
            },
          ],
        },
      ),
    ).toEqual({
      ok: true,
      data: {
        totalCount: 2,
        items: [
          {
            hash: 'H2',
            height: 11,
            time: 't',
            code: 5,
            succeeded: false,
            memo: 'thanks',
            messages: [
              {
                type: 'MsgSend',
                from: B,
                to: A,
                amount: [{ denom: 'uixo', amountBaseUnits: '5' }],
              },
              {
                type: 'MsgSend',
                from: B,
                to: A,
                amount: [{ denom: 'uixo', amountBaseUnits: '5' }],
              },
            ],
          },
        ],
      },
    });
  });

  it('trims an entity to what it is and where its resources live', () => {
    const shaped = shapeResult(
      { kind: 'entity', id: `did:ixo:entity:${'b'.repeat(32)}` },
      {
        id: 'did:ixo:entity:b',
        type: 'dao',
        status: 0,
        owner: A,
        accounts: [{ name: 'admin', address: B }],
        settings: {
          Profile: {
            id: '{id}#profile',
            type: 'Settings',
            proof: 'bafy',
            serviceEndpoint: 'ipfs://x',
          },
        },
        linkedResource: Array.from({ length: 30 }, (_, i) => ({
          id: `{id}#r${i}`,
          type: 'Document',
          description: 'd'.repeat(500),
          serviceEndpoint: 'ipfs://y',
          proof: 'bafy',
        })),
        linkedEntity: [],
        controller: [`did:ixo:${A}`],
        service: [],
      },
    );
    if (!shaped.ok) throw new Error('expected an entity');
    expect(shaped.ownedBy).toEqual([A]);
    expect(shaped.data).toMatchObject({
      id: 'did:ixo:entity:b',
      status: 0,
      statusNote: ENTITY_STATUS_NOTE,
      accounts: [{ name: 'admin', address: B }],
      settings: [
        {
          key: 'Profile',
          id: '{id}#profile',
          type: 'Settings',
          serviceEndpoint: 'ipfs://x',
        },
      ],
      controller: [`did:ixo:${A}`],
    });
    const data = shaped.data;
    if (!data || typeof data !== 'object' || !('linkedResource' in data))
      throw new Error('expected linked resources');
    const linked = data.linkedResource;
    expect(Array.isArray(linked) && linked.length).toBe(20);
    expect(JSON.stringify(linked)).not.toContain('proof');
  });

  it('lists entities with how they are ordered and what status means', () => {
    expect(
      shapeResult(
        { kind: 'entities' },
        {
          totalCount: 1,
          nodes: [
            {
              id: 'did:ixo:entity:e',
              type: 'dao',
              status: 1,
              owner: A,
              metadata: { created: '2026-01-01T00:00:00Z', versionId: 'v' },
            },
          ],
        },
      ),
    ).toEqual({
      ok: true,
      data: {
        totalCount: 1,
        orderedBy: ENTITIES_ORDER,
        statusNote: ENTITY_STATUS_NOTE,
        items: [
          {
            id: 'did:ixo:entity:e',
            type: 'dao',
            status: 1,
            owner: A,
            created: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
  });

  it('names a transaction’s signers once each, with its fee in base units', () => {
    expect(
      shapeResult(
        { kind: 'transaction', hash: 'A'.repeat(64) },
        {
          nodes: [
            {
              hash: 'H3',
              height: 12,
              time: 't',
              code: 0,
              memo: '',
              fee: { amount: [{ denom: 'uixo', amount: '5000' }], gas: '1' },
              transactionSignersByTransactionId: {
                nodes: [{ signerAddress: A }, { signerAddress: A }],
              },
              messagesByTransactionHash: { totalCount: 0, nodes: [] },
            },
          ],
        },
      ),
    ).toEqual({
      ok: true,
      ownedBy: [A],
      data: {
        hash: 'H3',
        height: 12,
        time: 't',
        code: 0,
        succeeded: true,
        messages: [],
        signers: [A],
        fee: [{ denom: 'uixo', amountBaseUnits: '5000' }],
      },
    });
  });
});
