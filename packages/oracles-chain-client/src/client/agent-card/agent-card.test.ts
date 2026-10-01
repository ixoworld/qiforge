import { type LinkedResource } from '@ixo/impactxclient-sdk/codegen/ixo/iid/v1beta1/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findLinkedResource = vi.fn();
const fetchLinkedResourceDoc = vi.fn();

vi.mock('../../utils/get-settings-resouce.js', () => ({
  findLinkedResource: (...args: unknown[]) => findLinkedResource(...args),
  fetchLinkedResourceDoc: (...args: unknown[]) =>
    fetchLinkedResourceDoc(...args),
}));

const { getOracleAgentCard } = await import('./agent-card.js');

const oracleDid = 'did:ixo:entity:numerix-corvus-001';

const cardResource = {
  id: '{id}#acard',
  type: 'agentCard',
  proof: 'bafkreidjc4w27nkrducpjejlyxmxej4xqfd2dhelef2ttxoipml6l5chiy',
  mediaType: 'application/json',
  description: 'Agent Card',
  serviceEndpoint:
    'https://devmx.ixo.earth/_matrix/media/v3/download/devmx.ixo.earth/DYDvAJvyxtRplVpqYcxJzePy',
} as LinkedResource;

/** The published card shape, trimmed to what a consumer reads. */
const cardDoc = {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://w3id.org/ixo/ns/agent-card/v1',
  ],
  id: `${oracleDid}#acard`,
  type: ['VerifiableCredential', 'ixo:AgentCard'],
  issuer: { id: 'did:ixo:entity:numerix-master-did' },
  validFrom: '2024-01-01T00:00:00.000Z',
  credentialSubject: {
    id: oracleDid,
    name: 'Corvus',
    description: 'Specialized AI agent for Numerix Financial.',
    version: '1.1.0',
    services: [
      {
        id: 'expense-report-automation',
        name: 'Automated Expense Reporting',
        description: 'Ingests raw transaction data or receipts.',
        price: { amount: 50, currency: 'PAY' },
        deliverables: 'A validated General Ledger (GL) report.',
        doneMeans: ['Receipts ingested', 'Reconciliation report generated'],
      },
      {
        id: 'tax-compliance-filing',
        name: 'Tax Compliance & Filing Preparation',
        price: { amount: 250, currency: 'PAY' },
        deliverables: 'Completed jurisdictional tax forms.',
      },
    ],
  },
};

/** The `#acard` predicate `getOracleAgentCard` handed to `findLinkedResource`. */
function capturedMatcher(): (resource: LinkedResource) => boolean {
  return findLinkedResource.mock.calls[0]?.[1] as (
    resource: LinkedResource,
  ) => boolean;
}

describe('getOracleAgentCard', () => {
  beforeEach(() => {
    findLinkedResource.mockReset();
    fetchLinkedResourceDoc.mockReset();
    findLinkedResource.mockResolvedValue(cardResource);
    fetchLinkedResourceDoc.mockResolvedValue(cardDoc);
  });

  it('resolves the card, its services and the on-chain proof', async () => {
    const resolved = await getOracleAgentCard(oracleDid);

    expect(resolved).not.toBeNull();
    expect(resolved?.oracleDid).toBe(oracleDid);
    expect(resolved?.cardProof).toBe(cardResource.proof);
    expect(resolved?.card.credentialSubject.name).toBe('Corvus');
    expect(
      resolved?.card.credentialSubject.services.map((s) => s.price.amount),
    ).toEqual([50, 250]);
  });

  it('passes the caller Matrix credentials through to the document fetch', async () => {
    await getOracleAgentCard(oracleDid, 'token-123', 'mx.example.org');

    expect(fetchLinkedResourceDoc).toHaveBeenCalledWith(
      cardResource,
      'token-123',
      'mx.example.org',
    );
  });

  it('matches only the agentCard `#acard` resource', async () => {
    await getOracleAgentCard(oracleDid);
    const matches = capturedMatcher();

    expect(matches(cardResource)).toBe(true);
    expect(matches({ ...cardResource, id: '{id}#fee', type: 'settings' })).toBe(
      false,
    );
    // Right type, wrong anchor — not the entity's own card.
    expect(matches({ ...cardResource, id: '{id}#other' })).toBe(false);
    // Right anchor, wrong type.
    expect(matches({ ...cardResource, type: 'settings' })).toBe(false);
  });

  it('returns null when the oracle publishes no card', async () => {
    findLinkedResource.mockResolvedValue(undefined);
    await expect(getOracleAgentCard(oracleDid)).resolves.toBeNull();
  });

  it('returns null when the entity read fails', async () => {
    findLinkedResource.mockRejectedValue(new Error('blocksync unreachable'));
    await expect(getOracleAgentCard(oracleDid)).resolves.toBeNull();
  });

  it('returns null when the card document cannot be fetched', async () => {
    fetchLinkedResourceDoc.mockRejectedValue(new Error('404'));
    await expect(getOracleAgentCard(oracleDid)).resolves.toBeNull();
  });

  it('rejects a card with no services', async () => {
    fetchLinkedResourceDoc.mockResolvedValue({
      credentialSubject: { id: oracleDid, name: 'Corvus', services: [] },
    });
    await expect(getOracleAgentCard(oracleDid)).resolves.toBeNull();
  });

  it('rejects a service missing a numeric price', async () => {
    fetchLinkedResourceDoc.mockResolvedValue({
      credentialSubject: {
        id: oracleDid,
        name: 'Corvus',
        services: [
          {
            id: 'a',
            name: 'A',
            price: { amount: '50' },
            deliverables: 'thing',
          },
        ],
      },
    });
    await expect(getOracleAgentCard(oracleDid)).resolves.toBeNull();
  });

  it('rejects a card anchored on one entity but describing another', async () => {
    fetchLinkedResourceDoc.mockResolvedValue({
      ...cardDoc,
      credentialSubject: {
        ...cardDoc.credentialSubject,
        id: 'did:ixo:entity:someone-else',
      },
    });
    await expect(getOracleAgentCard(oracleDid)).resolves.toBeNull();
  });

  it('treats a missing proof as an empty version string', async () => {
    findLinkedResource.mockResolvedValue({ ...cardResource, proof: '' });
    const resolved = await getOracleAgentCard(oracleDid);
    expect(resolved?.cardProof).toBe('');
  });
});
