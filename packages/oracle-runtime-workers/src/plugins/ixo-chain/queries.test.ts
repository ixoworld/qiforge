import { describe, expect, it } from 'vitest';
import type { UserIdentity } from '../../core/user-identity';
import {
  CORE_ARGS,
  accountOf,
  firstOf,
  isBech32,
  literal,
  requestField,
  type ChainRequest,
} from './queries';

const ADDRESS = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
const USER: UserIdentity = { did: `did:ixo:${ADDRESS}`, address: ADDRESS };
/** Another mainnet account. */
const OTHER = 'ixo1rtjje8u0ctwwcdk8x07f4zgmexnjcmk8w6dgvq';
/** A 32-byte mainnet account: the PAY pool's proxy account. */
const CONTRACT =
  'ixo1pyf300wuv4wnmjut9g30yea474mer2djm36xzuf8u9ek2966cstq8khlez';
const NO_ADDRESS: UserIdentity = {
  did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  address: null,
};

/** The plan of a request alone in its call (a list reads its own `first`, default 10). */
const field = (request: ChainRequest, identity = USER) => {
  const rows = firstOf('first' in request ? request.first : undefined, 1);
  const plan = requestField(request, identity, rows);
  if (!plan.ok) throw new Error(`unexpected invalid plan: ${plan.detail}`);
  return plan;
};
const detailOf = (request: ChainRequest, identity = USER) => {
  const plan = requestField(request, identity, 10);
  if (plan.ok) throw new Error('expected an invalid plan');
  return plan.detail;
};

describe('literal', () => {
  it('writes JSON values as GraphQL literals with bare keys', () => {
    expect(literal({ toAddress: ADDRESS })).toBe(`{ toAddress: "${ADDRESS}" }`);
    expect(literal([{ value: { toAddress: ADDRESS } }])).toBe(
      `[{ value: { toAddress: "${ADDRESS}" } }]`,
    );
    expect(literal({ a: 1, b: true, c: null })).toBe(
      '{ a: 1, b: true, c: null }',
    );
  });

  it('escapes quotes and backslashes the way JSON does', () => {
    expect(literal('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(literal({ k: '"} r1: x { "' })).toBe('{ k: "\\"} r1: x { \\"" }');
  });

  it('refuses a key that is not a GraphQL name', () => {
    expect(() => literal({ 'a b': 1 })).toThrow('not a GraphQL name');
    expect(() => literal({ 'x: 1 } y': 1 })).toThrow('not a GraphQL name');
  });
});

describe('requestField', () => {
  it('reads claims by the indexed agent address, newest first, with a page cursor', () => {
    const plan = field({
      kind: 'claims',
      collectionId: '8250',
      first: 5,
      after: 'WyJuYXR1cmFsIiwxXQ==',
    });
    expect(plan.subject).toBe('user');
    expect(plan.first).toBe(5);
    expect(plan.field).toBe(
      `claims(filter: { agentAddress: { equalTo: "${ADDRESS}" }, collectionId: { equalTo: "8250" } }, first: 5, after: "WyJuYXR1cmFsIiwxXQ==", orderBy: SUBMISSION_DATE_DESC) { totalCount pageInfo { hasNextPage endCursor } nodes { claimId collectionId agentDid agentAddress submissionDate paymentsStatus schemaType useIntent amount currentEvaluationId evaluation { status evaluationDate } } }`,
    );
  });

  it('takes an agent as an address or a did:ixo account DID', () => {
    expect(field({ kind: 'claims', agent: OTHER }).subject).toBe('other');
    const byDid = field({ kind: 'claims', agent: `did:ixo:${OTHER}` });
    expect(byDid.subject).toBe('other');
    expect(byDid.field).toContain(`agentAddress: { equalTo: "${OTHER}" }`);
    expect(field({ kind: 'claims', agent: ADDRESS }).subject).toBe('user');
  });

  it('reads one claim with its current evaluation', () => {
    expect(
      field({
        kind: 'claim',
        claimId: 'bafkreido4unh2l34n5zy5sy3nhyc3nhih65eysmal5dlq6j56m3eecntfm',
      }).field,
    ).toBe(
      'claim(claimId: "bafkreido4unh2l34n5zy5sy3nhyc3nhih65eysmal5dlq6j56m3eecntfm") { claimId collectionId agentDid agentAddress submissionDate paymentsStatus schemaType useIntent amount currentEvaluationId evaluation { status evaluationDate oracle agentDid agentAddress reason amount } }',
    );
  });

  it('reads collections (newest start date first), entities and DID documents', () => {
    const one = field({ kind: 'claim_collection', id: '8250' });
    expect(one.field).toBe(
      'claimCollection(id: "8250") { id entity admin protocol startDate endDate quota count evaluated approved rejected disputed state payments }',
    );
    // A by-id request learns whose record it is only from the answer.
    expect(one.subject).toBeUndefined();
    expect(one.first).toBeUndefined();
    expect(field({ kind: 'claim_collections' }).field).toBe(
      `claimCollections(filter: { admin: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: START_DATE_DESC) { totalCount nodes { id entity admin protocol startDate endDate quota count evaluated approved rejected disputed state } }`,
    );
    const entity = `did:ixo:entity:${'a'.repeat(32)}`;
    const byEntity = field({ kind: 'claim_collections', entity });
    expect(byEntity.subject).toBeUndefined();
    expect(byEntity.field).toContain(
      `filter: { entity: { equalTo: "${entity}" } }`,
    );
    expect(field({ kind: 'entities', type: 'dao', first: 3 }).field).toBe(
      `entities(filter: { owner: { equalTo: "${ADDRESS}" }, type: { equalTo: "dao" } }, first: 3, orderBy: ID_DESC) { totalCount nodes { id type status owner metadata } }`,
    );
    expect(field({ kind: 'entity', id: entity }).field).toBe(
      `entity(id: "${entity}") { id type status owner accounts settings linkedResource linkedEntity controller service }`,
    );
    const own = field({ kind: 'did_document' });
    expect(own.subject).toBe('user');
    expect(own.field).toBe(
      `iid(id: "did:ixo:${ADDRESS}") { id controller verificationMethod linkedResource alsoKnownAs }`,
    );
    expect(field({ kind: 'did_document', id: entity }).subject).toBe('other');
  });

  it('reads 1155 balances with their class through tokenClassByName', () => {
    expect(field({ kind: 'token_balances' }).field).toBe(
      `tokenBalances(filter: { address: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: AMOUNT_DESC) { totalCount nodes { tokenId amount retired token { name collection tokenClassByName { contractAddress class } } } }`,
    );
  });

  it('reads signed transactions from the signer table, five messages each', () => {
    expect(field({ kind: 'transactions' }).field).toBe(
      `transactionSigners(filter: { signerAddress: { equalTo: "${ADDRESS}" } }, first: 10, orderBy: TRANSACTION_ID_DESC) { totalCount nodes { transactionHash transaction { hash height time code memo messagesByTransactionHash(first: 5, orderBy: INDEX_ASC) { totalCount nodes { typeUrl index value } } } } }`,
    );
  });

  it('reads received messages by the indexed recipient column', () => {
    expect(
      field({ kind: 'transactions', direction: 'received', first: 4 }).field,
    ).toBe(
      `messages(filter: { to: { equalTo: "${ADDRESS}" } }, first: 4, orderBy: ID_DESC) { totalCount nodes { typeUrl index value transactionHash transactionByTransactionHash { hash height time code memo } } }`,
    );
  });

  it('reads one transaction by its upper-cased hash, with its signers', () => {
    const hash = 'ab'.repeat(32);
    expect(field({ kind: 'transaction', hash }).field).toBe(
      `transactions(filter: { hash: { equalTo: "${hash.toUpperCase()}" } }, first: 1) { nodes { hash height time code memo fee transactionSignersByTransactionId(first: 10) { nodes { signerAddress } } messagesByTransactionHash(first: 50, orderBy: INDEX_ASC) { totalCount nodes { typeUrl index value } } } }`,
    );
  });

  it('refuses ids that do not match their kind, so nothing unchecked reaches the document', () => {
    expect(detailOf({ kind: 'claim', claimId: 'x" } r1: claims { "' })).toMatch(
      /claimId/,
    );
    expect(detailOf({ kind: 'claim_collection', id: '82a' })).toMatch(
      /collection/,
    );
    expect(detailOf({ kind: 'entity', id: 'did:ixo:entity:XYZ' })).toMatch(
      /entity/,
    );
    expect(detailOf({ kind: 'transaction', hash: 'abc' })).toMatch(/hash/);
    expect(detailOf({ kind: 'claims', after: 'a b' })).toMatch(/after/);
    expect(detailOf({ kind: 'claims', collectionId: '1"' })).toMatch(
      /collectionId/,
    );
    expect(detailOf({ kind: 'entities', type: 'dao" }' })).toMatch(/type/);
    expect(detailOf({ kind: 'token_balances', address: 'cosmos1abc' })).toMatch(
      /ixo1/,
    );
    expect(
      detailOf({ kind: 'did_document', id: 'did:web:example.com' }),
    ).toMatch(/did:ixo/);
  });

  it('needs an explicit account when the user has no IXO address', () => {
    expect(detailOf({ kind: 'token_balances' }, NO_ADDRESS)).toBe(
      'The user has no IXO account address; give one.',
    );
    expect(detailOf({ kind: 'did_document' }, NO_ADDRESS)).toMatch(
      /not a did:ixo/,
    );
    expect(
      field({ kind: 'token_balances', address: OTHER }, NO_ADDRESS).subject,
    ).toBe('other');
  });

  it('reads first rows (default 10), capped by how many requests share the document', () => {
    expect(firstOf(undefined, 1)).toBe(10);
    expect(firstOf(20, 1)).toBe(20);
    expect(firstOf(20, 2)).toBe(20);
    expect(firstOf(20, 3)).toBe(13);
    expect(firstOf(20, 4)).toBe(10);
    expect(firstOf(3, 4)).toBe(3);
    expect(firstOf(undefined, 8)).toBe(5);
    expect(firstOf(1, 8)).toBe(1);
    const plan = requestField(
      { kind: 'token_balances', first: 20 },
      USER,
      firstOf(20, 8),
    );
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.first).toBe(5);
    expect(plan.field).toContain('first: 5,');
  });
});

describe('bech32 addresses', () => {
  it('accepts valid ixo addresses of 20 and 32 bytes', () => {
    for (const address of [ADDRESS, OTHER, CONTRACT])
      expect(isBech32(address, 'ixo')).toBe(true);
  });

  it('refuses a changed character, a wrong prefix, mixed case and characters outside bech32', () => {
    const typo = `${ADDRESS.slice(0, 10)}${ADDRESS[10] === 'q' ? 'p' : 'q'}${ADDRESS.slice(11)}`;
    for (const address of [
      typo,
      ADDRESS.slice(0, -1),
      ADDRESS.replace(/^ixo1/, 'cosmos1'),
      ADDRESS.toUpperCase(),
      `${OTHER.slice(0, -2)}${OTHER.slice(-2).toUpperCase()}`,
      'ixo1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'ixo1qqqqqq',
      'ixo1',
    ])
      expect(isBech32(address, 'ixo')).toBe(false);
    expect(isBech32(ADDRESS, 'cosmos')).toBe(false);
  });

  it('refuses data that does not convert to whole bytes', () => {
    // A valid checksum over 33 five-bit groups: 165 bits, 5 of padding.
    expect(isBech32('ixo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8qtf7x', 'ixo')).toBe(
      false,
    );
  });

  it('refuses an address argument whose checksum does not match, as an address or a DID', () => {
    const typo = ADDRESS.replace(/5$/, '6');
    const refused = {
      ok: false,
      detail:
        'agent is not a valid ixo1… address: its checksum does not match. Check it for a typo.',
    };
    expect(accountOf(typo, USER, 'agent')).toEqual(refused);
    expect(accountOf(`did:ixo:${typo}`, USER, 'agent')).toEqual(refused);
    expect(accountOf(OTHER, USER, 'agent')).toEqual({
      ok: true,
      address: OTHER,
      subject: 'other',
    });
    expect(detailOf({ kind: 'token_balances', address: typo })).toBe(
      'address is not a valid ixo1… address: its checksum does not match. Check it for a typo.',
    );
  });
});

describe('core arguments', () => {
  it('asks no Message.value containment (they time out on account addresses)', () => {
    const every: ChainRequest[] = [
      { kind: 'claims' },
      { kind: 'claim', claimId: 'x'.repeat(20) },
      { kind: 'claim_collection', id: '1' },
      { kind: 'claim_collections' },
      { kind: 'entities' },
      { kind: 'entity', id: `did:ixo:entity:${'a'.repeat(32)}` },
      { kind: 'did_document' },
      { kind: 'token_balances' },
      { kind: 'transactions' },
      { kind: 'transactions', direction: 'received' },
      { kind: 'transaction', hash: 'A'.repeat(64) },
    ];
    for (const request of every)
      expect(field(request).field).not.toContain('contains');
  });

  it('rejects unknown fields (an account by `agentDid` is not `agent`)', () => {
    expect(CORE_ARGS.claims.safeParse({ agentDid: USER.did }).success).toBe(
      false,
    );
    expect(CORE_ARGS.claim.safeParse({}).success).toBe(false);
    expect(CORE_ARGS.claims.safeParse({ agent: USER.did }).success).toBe(true);
  });

  it('takes first only as an integer from 1 to 20', () => {
    for (const first of [0, 21, 2.5, '5'])
      expect(CORE_ARGS.claims.safeParse({ first }).success).toBe(false);
    expect(CORE_ARGS.claims.safeParse({ first: 20 }).success).toBe(true);
  });
});
