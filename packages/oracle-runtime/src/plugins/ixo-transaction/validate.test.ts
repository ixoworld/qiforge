import { describe, expect, it } from 'vitest';

import { validateTransactionDraft } from './validate.js';

const ADDRESS = 'ixo1zr8shq3kv9m2tn7wx4yc6da5fg0jl8p3ue2bq9';
const ADDRESS_2 = 'ixo1aq7wt3nz8x5c2v9b6m4k1j0h8g5f3d7s2a9e4r6';
const ENTITY_DID = 'did:ixo:entity:0123456789abcdef0123456789abcdef';
const DID = `did:ixo:${ADDRESS}`;
const DID_2 = `did:ixo:${ADDRESS_2}`;
const TX_HASH =
  'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';

function transferDraft(overrides: Record<string, unknown> = {}) {
  return {
    command: '/ixo entity transfer',
    value: {
      id: ENTITY_DID,
      ownerDid: DID,
      ownerAddress: ADDRESS,
      recipientDid: DID_2,
    },
    ...overrides,
  };
}

describe('validateTransactionDraft', () => {
  it('validates and canonicalizes a draft into an EncodeObject', () => {
    const result = validateTransactionDraft(transferDraft());
    expect(result.message).toEqual({
      typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity',
      value: {
        id: ENTITY_DID,
        ownerDid: DID,
        ownerAddress: ADDRESS,
        recipientDid: DID_2,
      },
    });
    expect(result.requiresConfirmation).toBe(true);
    expect(result.network).toBe('testnet');
  });

  it('rejects a missing required field', () => {
    expect(() =>
      validateTransactionDraft({
        command: '/ixo entity transfer',
        value: { id: ENTITY_DID, ownerDid: DID, ownerAddress: ADDRESS },
      }),
    ).toThrow();
  });

  it('rejects an unknown field (strict)', () => {
    expect(() =>
      validateTransactionDraft(
        transferDraft({
          value: {
            id: ENTITY_DID,
            ownerDid: DID,
            ownerAddress: ADDRESS,
            recipientDid: DID_2,
            surprise: 'nope',
          },
        }),
      ),
    ).toThrow();
  });

  it('rejects a malformed address', () => {
    expect(() =>
      validateTransactionDraft(
        transferDraft({
          value: {
            id: ENTITY_DID,
            ownerDid: DID,
            ownerAddress: 'cosmos1notanixoaddress',
            recipientDid: DID_2,
          },
        }),
      ),
    ).toThrow();
  });

  it('uses the verified iid field name serviceData (not service)', () => {
    const result = validateTransactionDraft({
      command: '/ixo iid add-service',
      value: {
        id: DID,
        serviceData: {
          id: '#svc1',
          type: 'LinkedDomains',
          serviceEndpoint: 'https://example.com',
        },
        signer: ADDRESS,
      },
    });
    expect(result.message.typeUrl).toBe('/ixo.iid.v1beta1.MsgAddService');
    expect(result.message.value).toHaveProperty('serviceData');
  });

  describe('risk gate', () => {
    it('refuses to finalize a risky tx without confirmation', () => {
      expect(() =>
        validateTransactionDraft(transferDraft(), {
          requireRiskConfirmation: true,
        }),
      ).toThrow(/Risk confirmation required/);
    });

    it('passes with explicit risk confirmation', () => {
      const result = validateTransactionDraft(
        transferDraft({
          riskConfirmation: {
            confirmed: true,
            acceptedRisks: ['ownership transfer is irreversible'],
          },
        }),
        { requireRiskConfirmation: true },
      );
      expect(result.message.typeUrl).toBe(
        '/ixo.entity.v1beta1.MsgTransferEntity',
      );
    });
  });

  describe('mainnet gate', () => {
    const confirmed = {
      riskConfirmation: {
        confirmed: true as const,
        acceptedRisks: ['mainnet transfer'],
      },
    };

    it('blocks a mainnet draft without a testnet receipt or override', () => {
      expect(() =>
        validateTransactionDraft(
          transferDraft({ network: 'mainnet', ...confirmed }),
          { requireRiskConfirmation: true },
        ),
      ).toThrow(/Mainnet draft blocked/);
    });

    it('allows mainnet with a successful testnet receipt', () => {
      const result = validateTransactionDraft(
        transferDraft({
          network: 'mainnet',
          ...confirmed,
          testnetReceipt: {
            network: 'testnet',
            transactionHash: TX_HASH,
            code: 0,
          },
        }),
        { requireRiskConfirmation: true },
      );
      expect(result.network).toBe('mainnet');
    });

    it('allows mainnet with an explicit recorded override', () => {
      const result = validateTransactionDraft(
        transferDraft({
          network: 'mainnet',
          ...confirmed,
          overrideMainnet: true,
          overrideReason: 'User explicitly requested mainnet without testnet.',
        }),
        { requireRiskConfirmation: true },
      );
      expect(result.network).toBe('mainnet');
    });
  });

  it('rejects a typeUrl that conflicts with the resolved intent', () => {
    expect(() =>
      validateTransactionDraft(
        transferDraft({ typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity' }),
      ),
    ).toThrow(/typeUrl conflict/);
  });
});
