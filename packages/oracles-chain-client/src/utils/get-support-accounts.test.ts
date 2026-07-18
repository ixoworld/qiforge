import { describe, expect, it, vi } from 'vitest';
import { graphqlClient } from '../gql/index.js';
import {
  getSupportAccounts,
  getSupportRoomAlias,
  parseSupportAccounts,
} from './get-support-accounts.js';

vi.mock('../gql/index.js', () => ({
  graphqlClient: { request: vi.fn() },
}));

const requestMock = vi.mocked(graphqlClient.request);

const supportEntry = {
  type: 'individual',
  id: 'did:ixo:ixo1support',
  relationship: 'support',
  service: 'matrix',
};

describe('parseSupportAccounts', () => {
  it('keeps only matrix/support entries with DID ids', () => {
    const accounts = parseSupportAccounts([
      supportEntry,
      { ...supportEntry, id: 'did:x:second' },
      { ...supportEntry, relationship: 'admin' },
      { ...supportEntry, service: 'email' },
      { ...supportEntry, id: 'ixo1notadid' },
    ]);

    expect(accounts).toEqual([
      {
        did: 'did:ixo:ixo1support',
        relationship: 'support',
        service: 'matrix',
      },
      { did: 'did:x:second', relationship: 'support', service: 'matrix' },
    ]);
  });

  it('skips malformed entries instead of throwing', () => {
    const accounts = parseSupportAccounts([
      null,
      42,
      'support',
      { relationship: 'support', service: 'matrix' },
      supportEntry,
    ]);

    expect(accounts).toHaveLength(1);
  });

  it('returns [] for non-array input', () => {
    expect(parseSupportAccounts(undefined)).toEqual([]);
    expect(parseSupportAccounts(null)).toEqual([]);
    expect(parseSupportAccounts({ id: 'did:x:y' })).toEqual([]);
  });
});

describe('getSupportAccounts', () => {
  it('fetches linkedEntity for the DID and filters it', async () => {
    requestMock.mockResolvedValueOnce({
      entity: { linkedEntity: [supportEntry, { junk: true }] },
    });

    const accounts = await getSupportAccounts('did:ixo:entity:fetch1');

    expect(accounts).toEqual([
      {
        did: 'did:ixo:ixo1support',
        relationship: 'support',
        service: 'matrix',
      },
    ]);
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringContaining('linkedEntity'),
      {
        id: 'did:ixo:entity:fetch1',
      },
    );
  });

  it('returns [] when the entity does not exist', async () => {
    requestMock.mockResolvedValueOnce({ entity: null });

    await expect(
      getSupportAccounts('did:ixo:entity:missing1'),
    ).resolves.toEqual([]);
  });

  it('caches the lookup per entity DID', async () => {
    requestMock.mockResolvedValue({
      entity: { linkedEntity: [supportEntry] },
    });

    await getSupportAccounts('did:ixo:entity:cached1');
    await getSupportAccounts('did:ixo:entity:cached1');

    const calls = requestMock.mock.calls.filter(
      ([, vars]) => (vars as { id: string }).id === 'did:ixo:entity:cached1',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('getSupportRoomAlias', () => {
  it('hyphenates the entity DID and appends -sup', () => {
    expect(getSupportRoomAlias('did:ixo:entity:abc123', 'mx.ixo.earth')).toBe(
      '#did-ixo-entity-abc123-sup:mx.ixo.earth',
    );
  });
});
