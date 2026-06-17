import { describe, expect, it, vi } from 'vitest';

import {
  buildSignTransactionActionArgs,
  signIxoTransactionWithWallet,
} from '../src/action.js';
import { validateTransactionDraft } from '../src/validate.js';
import {
  ADDRESS,
  ADDRESS_2,
  DID,
  DID_2,
  ENTITY_DID,
  draft,
  riskConfirmation,
  verification,
} from './fixtures.js';

describe('validation and signing action args', () => {
  it('builds MsgCreateEntity as validated sign_transaction action args', () => {
    const actionArgs = buildSignTransactionActionArgs(
      draft('/ixo entity create', {
        entityType: 'protocol',
        verification,
        ownerDid: DID,
        ownerAddress: ADDRESS,
        relayerNode: ENTITY_DID,
        controller: [DID],
      }),
    );

    expect(actionArgs).toEqual({
      action: 'sign_transaction',
      network: 'testnet',
      messages: [
        {
          typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
          value: {
            entityType: 'protocol',
            verification,
            ownerDid: DID,
            ownerAddress: ADDRESS,
            relayerNode: ENTITY_DID,
            controller: [DID],
          },
        },
      ],
      intent: {
        source: 'slash-command',
        module: 'entity',
        action: 'create',
        messageName: 'MsgCreateEntity',
        typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
        confidence: 1,
        ambiguities: [],
      },
      risks: [
        'Creates a new entity, admin account, DID document, and ownership NFT. The entity DID is chain-derived and cannot be chosen.',
      ],
      riskLevel: 'high',
      requiresConfirmation: true,
      riskConfirmation,
    });
  });

  it.each([
    draft('/ixo entity transfer', {
      id: ENTITY_DID,
      ownerDid: DID,
      ownerAddress: ADDRESS,
      recipientDid: DID_2,
    }),
    draft('/ixo iid add-linked-resource', {
      id: ENTITY_DID,
      signer: ADDRESS,
      linkedResource: {
        id: '{id}#pro',
        type: 'Settings',
        serviceEndpoint: 'https://cellnode.example/profile.json',
      },
    }),
    draft('/ixo claims submit', {
      collectionId: 'collection-1',
      claimId: 'claim-1',
      agentAddress: ADDRESS,
      agentDid: DID,
      adminAddress: ADDRESS_2,
    }),
    draft('/ixo token retire', {
      owner: ADDRESS,
      tokens: [{ id: 'CREDIT-1', amount: '10' }],
      jurisdiction: 'Global',
      reason: 'offset',
    }),
    draft('/ixo names register', {
      name: 'sample',
      namespace: 'ixo',
      ownerDid: DID,
      ownerAddress: ADDRESS,
    }),
    draft('/ixo smart-account add-authenticator', {
      sender: ADDRESS,
      authenticatorType: 'SignatureVerification',
      data: '0x1234',
    }),
  ])('validates positive fixture %#', (fixture) => {
    expect(validateTransactionDraft(fixture).message.typeUrl).toMatch(
      /^\/ixo\./,
    );
  });

  it('rejects conflicting typeUrl', () => {
    expect(() =>
      validateTransactionDraft(
        draft(
          '/ixo token retire',
          {
            owner: ADDRESS,
            tokens: [{ id: 'CREDIT-1', amount: '10' }],
            jurisdiction: 'Global',
            reason: 'offset',
          },
          { typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity' },
        ),
      ),
    ).toThrow(/typeUrl conflict/);
  });

  it('rejects missing required fields', () => {
    expect(() =>
      validateTransactionDraft(
        draft('/ixo entity transfer', {
          id: ENTITY_DID,
          ownerDid: DID,
          ownerAddress: ADDRESS,
        }),
      ),
    ).toThrow();
  });

  it('rejects invalid DID and address values', () => {
    expect(() =>
      validateTransactionDraft(
        draft('/ixo entity transfer', {
          id: 'not-a-did',
          ownerDid: DID,
          ownerAddress: ADDRESS,
          recipientDid: DID_2,
        }),
      ),
    ).toThrow();
    expect(() =>
      validateTransactionDraft(
        draft('/ixo entity transfer', {
          id: ENTITY_DID,
          ownerDid: DID,
          ownerAddress: 'cosmos1bad',
          recipientDid: DID_2,
        }),
      ),
    ).toThrow();
  });

  it('rejects decimal token amounts', () => {
    expect(() =>
      validateTransactionDraft(
        draft('/ixo token retire', {
          owner: ADDRESS,
          tokens: [{ id: 'CREDIT-1', amount: '1.5' }],
          jurisdiction: 'Global',
          reason: 'offset',
        }),
      ),
    ).toThrow();
  });

  it('rejects invalid timestamps', () => {
    expect(() =>
      validateTransactionDraft(
        draft('/ixo entity update', {
          id: ENTITY_DID,
          controllerDid: DID,
          controllerAddress: ADDRESS,
          startDate: 'tomorrow',
        }),
      ),
    ).toThrow();
  });

  it('rejects invalid verification material oneofs', () => {
    const badVerification = [
      {
        relationships: ['authentication'],
        method: {
          id: `${DID}#key-1`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          controller: DID,
          blockchainAccountID: ADDRESS,
          publicKeyHex: 'abcdef',
        },
      },
    ];
    expect(() =>
      validateTransactionDraft(
        draft('/ixo entity create', {
          entityType: 'protocol',
          verification: badVerification,
          ownerDid: DID,
          ownerAddress: ADDRESS,
          relayerNode: ENTITY_DID,
        }),
      ),
    ).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() =>
      validateTransactionDraft(
        draft('/ixo entity transfer', {
          id: ENTITY_DID,
          ownerDid: DID,
          ownerAddress: ADDRESS,
          recipientDid: DID_2,
          extraField: true,
        }),
      ),
    ).toThrow();
  });

  it('blocks mainnet without testnet receipt or explicit override', () => {
    expect(() =>
      validateTransactionDraft(
        draft(
          '/ixo entity transfer',
          {
            id: ENTITY_DID,
            ownerDid: DID,
            ownerAddress: ADDRESS,
            recipientDid: DID_2,
          },
          { network: 'mainnet', riskConfirmation },
        ),
      ),
    ).toThrow(/Mainnet draft blocked/);
  });

  it('allows mainnet with successful testnet receipt', () => {
    const validated = validateTransactionDraft(
      draft(
        '/ixo entity transfer',
        {
          id: ENTITY_DID,
          ownerDid: DID,
          ownerAddress: ADDRESS,
          recipientDid: DID_2,
        },
        {
          network: 'mainnet',
          testnetReceipt: {
            network: 'testnet',
            transactionHash: 'A'.repeat(64),
            code: 0,
          },
        },
      ),
    );
    expect(validated.network).toBe('mainnet');
  });

  it('calls transactSignX with validated action messages and memo', async () => {
    const actionArgs = buildSignTransactionActionArgs(
      draft(
        '/ixo token retire',
        {
          owner: ADDRESS,
          tokens: [{ id: 'CREDIT-1', amount: '10' }],
          jurisdiction: 'Global',
          reason: 'offset',
        },
        { memo: 'retire credits' },
      ),
    );
    const transactSignX = vi.fn().mockResolvedValue({
      transactionHash: 'B'.repeat(64),
      code: 0,
      height: 123,
    });

    const result = await signIxoTransactionWithWallet(
      actionArgs,
      transactSignX,
    );

    expect(transactSignX).toHaveBeenCalledWith(
      actionArgs.messages,
      'retire credits',
    );
    expect(result).toMatchObject({
      success: true,
      transactionHash: 'B'.repeat(64),
      code: 0,
      height: 123,
    });
  });

  it('requires risk confirmation before signing action dispatch', () => {
    const noConfirmation = {
      command: '/ixo entity transfer',
      network: 'testnet',
      value: {
        id: ENTITY_DID,
        ownerDid: DID,
        ownerAddress: ADDRESS,
        recipientDid: DID_2,
      },
    };
    expect(() => buildSignTransactionActionArgs(noConfirmation)).toThrow(
      /Risk confirmation required/,
    );
  });
});
