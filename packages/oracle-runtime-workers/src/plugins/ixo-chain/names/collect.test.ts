import { describe, expect, it } from 'vitest';
import {
  collectIdentifiers,
  dropLastName,
  MAX_IDENTIFIERS,
  pruneNames,
} from './collect';
import type { NameInfo, NameMap } from './types';

const USER = 'ixo1cra6p0jefu8f907gqngkfzxur26k7f73an4v95';
const ME = { did: `did:ixo:${USER}`, address: USER };
const ALICE = 'ixo1x4p6j0h3mzv8e7mhd6q9wquh2vqd9yh5n8r6gq';
const BOB = 'ixo10d07y265gmmuvt4z0w9aw880jnsr700j9hdhjq';
const CAROL = 'ixo1476xwgx5zs0fz57ck33cg7n8vghzfp6ggnt334';
/** A 32-byte (contract) address. */
const CONTRACT =
  'ixo14g47ggcgge3xgmzddenqzsgr26ckk854gfngz4g908wc29drwussp0k66n';
const VALIDATOR = 'ixovaloper1kr8v9qt46ysltgmzcrtgyw5ckke83up673u2lu';
const entity = (n: number) =>
  `did:ixo:entity:${n.toString(16).padStart(32, '0')}`;

const name = (text: string): NameInfo => ({
  name: text,
  source: 'matrix',
  selfChosen: true,
});

describe('collectIdentifiers', () => {
  it('collects addresses, account DIDs, entity DIDs, validators and collection ids, each once', () => {
    const result = {
      ok: true,
      address: ALICE,
      results: [
        {
          data: {
            admin: ALICE,
            entity: entity(1),
            agentDid: `did:ixo:${BOB}`,
            contract: CONTRACT,
            contractDid: `did:ixo:wasm:${CONTRACT}`,
            validator: VALIDATOR,
            collectionId: '8250',
            token: { collection: '236', amount: '5' },
          },
        },
      ],
    };
    // A token's `collection` is text its minter chose: not a collection id.
    expect(collectIdentifiers(result, ME)).toEqual([
      ALICE,
      entity(1),
      `did:ixo:${BOB}`,
      CONTRACT,
      `did:ixo:wasm:${CONTRACT}`,
      VALIDATOR,
      'collection:8250',
    ]);
  });

  it('takes the id of a claim_collection result and of claim_collections items as collection ids', () => {
    const result = {
      network: 'mainnet',
      results: [
        {
          kind: 'claim_collection',
          source: 'blocksync',
          ok: true,
          data: { id: '236', entity: entity(1), admin: ALICE },
        },
        {
          kind: 'claim_collections',
          source: 'blocksync',
          ok: true,
          data: { totalCount: 2, items: [{ id: '8250' }, { id: '8253' }] },
        },
      ],
    };
    expect(collectIdentifiers(result, ME)).toEqual([
      'collection:236',
      entity(1),
      ALICE,
      'collection:8250',
      'collection:8253',
    ]);
  });

  it('reads no other id as a collection id', () => {
    expect(
      collectIdentifiers(
        {
          results: [
            { kind: 'claims', ok: true, data: { items: [{ id: '1' }] } },
            { kind: 'claim_collection', ok: false, data: { id: '2' } },
            {
              kind: 'claim_collection',
              ok: true,
              data: { id: '3', payments: { id: '4' }, nested: [{ id: '5' }] },
            },
            { kind: 'claim_collections', ok: true, data: { id: '6' } },
          ],
        },
        ME,
      ),
    ).toEqual(['collection:3']);
  });

  it('takes only whole, valid values: no checksum typo, no address inside text, no other prefixes', () => {
    const typo = `${ALICE.slice(0, -1)}${ALICE.endsWith('q') ? 'p' : 'q'}`;
    expect(
      collectIdentifiers(
        {
          typo,
          upper: ALICE.toUpperCase(),
          memo: `sent to ${ALICE} for lunch`,
          cosmos: 'cosmos1x4p6j0h3mzv8e7mhd6q9wquh2vqd9yh5n8r6gq',
          shortEntity: 'did:ixo:entity:abc',
          valoperDid: `did:ixo:${VALIDATOR}`,
          wasmValoper: `did:ixo:wasm:${VALIDATOR}`,
          // Valid bech32, but neither an account (42) nor a contract (62).
          shortAddress: 'ixo1qurswpc8qurswpc8qurswpc8quvxrnsg',
          denom: 'uixo',
          ibc: 'ibc/6BBE9BD4246F8E04948D5A4EEE7164B2630263B9EBB5E7DC5F0A46C62A2FF97B',
          // A collection id only counts under its own field name.
          id: '8250',
          collection: '8251',
          collectionId: 'not-a-number',
          amount: 8250,
        },
        ME,
      ),
    ).toEqual([]);
  });

  it("leaves out the user's own address and DID", () => {
    expect(
      collectIdentifiers(
        { address: USER, did: ME.did, granter: ALICE, signer: USER },
        ME,
      ),
    ).toEqual([ALICE]);
    // A user without an IXO address: only the DID is theirs.
    expect(
      collectIdentifiers(
        { owner: 'did:key:z6Mk', grantee: USER },
        { did: 'did:key:z6Mk', address: null },
      ),
    ).toEqual([USER]);
  });

  it('puts identifiers in the top rows of every list before those further down any of them', () => {
    const result = {
      results: [
        { data: { items: [{ to: ALICE }, { to: BOB }, { to: CAROL }] } },
        { data: { items: [{ owner: entity(1) }, { owner: entity(2) }] } },
      ],
    };
    // Rank: the highest list index on the path (results[i], items[j]).
    expect(collectIdentifiers(result, ME)).toEqual([
      ALICE,
      BOB,
      entity(1),
      entity(2),
      CAROL,
    ]);
  });

  it('ranks an identifier by its best place when it appears more than once', () => {
    const result = {
      items: [{ to: BOB }, { to: CAROL }, { to: ALICE }],
      top: { granter: ALICE },
    };
    // ALICE ranks with BOB (row 0), after him: he appeared first.
    expect(collectIdentifiers(result, ME)).toEqual([BOB, ALICE, CAROL]);
  });

  it(`asks for at most ${MAX_IDENTIFIERS}, the best placed`, () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      entity: entity(index),
    }));
    const collected = collectIdentifiers({ items }, ME);
    expect(collected).toHaveLength(MAX_IDENTIFIERS);
    expect(collected).toEqual(
      items.slice(0, MAX_IDENTIFIERS).map((row) => row.entity),
    );
  });

  it('never reads a names map already on the result', () => {
    expect(
      collectIdentifiers({ address: ALICE, names: { [BOB]: name(CAROL) } }, ME),
    ).toEqual([ALICE]);
  });

  it('never names who raised a dispute', () => {
    expect(
      collectIdentifiers(
        {
          items: [
            {
              claimId: 'bafyclaim',
              disputer: BOB,
              disputerDid: `did:ixo:${BOB}`,
              resolution: { adjudicator: CAROL },
            },
          ],
        },
        ME,
      ),
    ).toEqual([CAROL]);
  });
});

describe('pruneNames and dropLastName', () => {
  it('keeps only the names of identifiers still in the answer, in their order', () => {
    const answer: { items: string[]; names?: NameMap } = {
      items: [ALICE, CAROL],
      names: {
        [ALICE]: name('Alice'),
        [BOB]: name('Bob'),
        [CAROL]: name('Carol'),
      },
    };
    pruneNames(answer);
    expect(answer.names).toEqual({
      [ALICE]: name('Alice'),
      [CAROL]: name('Carol'),
    });
    expect(Object.keys(answer.names ?? {})).toEqual([ALICE, CAROL]);
  });

  it('leaves out the last name until none is left', () => {
    const answer: { names?: NameMap } = {
      names: { [ALICE]: name('Alice'), [BOB]: name('Bob') },
    };
    expect(dropLastName(answer)).toBe(true);
    expect(answer.names).toEqual({ [ALICE]: name('Alice') });
    expect(dropLastName(answer)).toBe(true);
    expect(answer.names).toEqual({});
    expect(dropLastName(answer)).toBe(false);
    expect(dropLastName({})).toBe(false);
  });
});
