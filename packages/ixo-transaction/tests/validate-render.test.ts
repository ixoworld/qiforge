import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHAIN_IDS,
  buildSignTransactionActionArgs,
  signIxoTransactionWithWallet,
} from '../src/action.js';
import {
  describeValidationError,
  validateTransactionDraft,
} from '../src/validate.js';
import {
  ADDRESS,
  ADDRESS_2,
  DID,
  DID_2,
  ENTITY_DID,
  RECEIPT,
  acceptAllRisks,
  draft,
  verification,
} from './fixtures.js';

const TESTNET = { walletChainId: 'pandora-8' };

function retireDraft() {
  return draft('/ixo token retire', {
    owner: ADDRESS,
    tokens: [{ id: 'CREDIT-1', amount: '10' }],
    jurisdiction: 'Global',
    reason: 'offset',
  });
}

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
      chainId: 'pandora-8',
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
      riskConfirmation: acceptAllRisks('/ixo entity create'),
    });
  });

  it('names the chain each network signs on, verified against the RPC status', () => {
    expect(DEFAULT_CHAIN_IDS).toEqual({
      devnet: 'devnet-1',
      testnet: 'pandora-8',
      mainnet: 'ixo-5',
    });
    const mainnetArgs = buildSignTransactionActionArgs(
      { ...retireDraft(), network: 'mainnet', testnetReceipt: RECEIPT },
      { allowMainnet: true },
    );
    expect(mainnetArgs.chainId).toBe('ixo-5');
    expect(
      buildSignTransactionActionArgs(retireDraft(), {
        chainIds: { ...DEFAULT_CHAIN_IDS, testnet: 'pandora-9' },
      }).chainId,
    ).toBe('pandora-9');
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
    draft('/ixo smart-account add-authenticator', {
      sender: ADDRESS,
      authenticatorType: 'SignatureVerification',
      // base64 of [0x12, 0x34]
      data: 'EjQ=',
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

  it('refuses mainnet unless the caller allows it, even with a testnet receipt', () => {
    const mainnetWithReceipt = draft(
      '/ixo entity transfer',
      {
        id: ENTITY_DID,
        ownerDid: DID,
        ownerAddress: ADDRESS,
        recipientDid: DID_2,
      },
      {
        network: 'mainnet',
        testnetReceipt: RECEIPT,
      },
    );
    expect(() => validateTransactionDraft(mainnetWithReceipt)).toThrow(
      /Mainnet transactions are disabled/,
    );
    expect(() =>
      buildSignTransactionActionArgs(mainnetWithReceipt, {
        allowMainnet: false,
      }),
    ).toThrow(/Mainnet transactions are disabled/);
  });

  it('blocks allowed mainnet without a testnet receipt', () => {
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
          { network: 'mainnet' },
        ),
        { allowMainnet: true },
      ),
    ).toThrow(/Mainnet draft blocked/);
  });

  it('allows mainnet with successful testnet receipt when mainnet is allowed', () => {
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
          testnetReceipt: RECEIPT,
        },
      ),
      { allowMainnet: true },
    );
    expect(validated.network).toBe('mainnet');
  });

  it('has no mainnet override: an override field is an unknown key', () => {
    expect(() =>
      validateTransactionDraft(
        {
          ...draft('/ixo entity transfer', {
            id: ENTITY_DID,
            ownerDid: DID,
            ownerAddress: ADDRESS,
            recipientDid: DID_2,
          }),
          network: 'mainnet',
          overrideMainnet: true,
          overrideReason: 'User asked for mainnet without a testnet run.',
        },
        { allowMainnet: true },
      ),
    ).toThrow(/overrideMainnet/);
  });

  it('requires every risk of the route accepted word for word', () => {
    const transfer = (acceptedRisks: string[]) =>
      buildSignTransactionActionArgs(
        draft(
          '/ixo entity transfer',
          {
            id: ENTITY_DID,
            ownerDid: DID,
            ownerAddress: ADDRESS,
            recipientDid: DID_2,
          },
          { riskConfirmation: { confirmed: true, acceptedRisks } },
        ),
      );
    expect(() => transfer(['ok'])).toThrow(
      /Risk confirmation required before signing MsgTransferEntity: the user must accept, word for word, "Transfers the entity ownership NFT/,
    );
    expect(
      transfer(acceptAllRisks('/ixo entity transfer').acceptedRisks).messages,
    ).toHaveLength(1);
  });

  it('rejects bytes that are not padded base64 (hex would decode to other bytes)', () => {
    expect(() =>
      validateTransactionDraft(
        draft('/ixo smart-account add-authenticator', {
          sender: ADDRESS,
          authenticatorType: 'SignatureVerification',
          data: '0x1234',
        }),
      ),
    ).toThrow(/base64/);
  });

  it('describes a schema failure as path: message', () => {
    let caught: unknown;
    try {
      validateTransactionDraft(
        draft('/ixo entity transfer', {
          id: ENTITY_DID,
          ownerDid: DID,
          ownerAddress: 'cosmos1bad',
          recipientDid: DID_2,
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(describeValidationError(caught)).toMatch(
      /^ownerAddress: Expected an IXO bech32 account address/,
    );
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
      TESTNET,
    );

    expect(transactSignX).toHaveBeenCalledWith(
      actionArgs.messages,
      'retire credits',
    );
    expect(result).toEqual({
      success: true,
      transactionHash: 'B'.repeat(64),
      code: 0,
      height: 123,
    });
  });

  it('refuses a transaction for another chain than the wallet, without signing', async () => {
    const actionArgs = buildSignTransactionActionArgs(retireDraft());
    const transactSignX = vi.fn();

    const result = await signIxoTransactionWithWallet(
      actionArgs,
      transactSignX,
      { walletChainId: 'ixo-5' },
    );

    expect(transactSignX).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error:
        'Chain mismatch: the transaction is for pandora-8 (testnet) but this Portal wallet is on ixo-5; nothing was signed',
    });
  });

  it('returns a JSON-safe summary of a DeliverTxResponse with bigint gas fields', async () => {
    const actionArgs = buildSignTransactionActionArgs(retireDraft());
    const deliverTxResponse = {
      code: 0,
      height: 77,
      txIndex: 0,
      transactionHash: 'C'.repeat(64),
      events: [],
      msgResponses: [],
      gasUsed: 81234n,
      gasWanted: 100000n,
    };

    const result = await signIxoTransactionWithWallet(
      actionArgs,
      vi.fn().mockResolvedValue(deliverTxResponse),
      TESTNET,
    );

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      success: true,
      transactionHash: 'C'.repeat(64),
      code: 0,
      height: 77,
    });
  });

  it('returns an included-but-failed transaction as delivered, keeping its hash and code', async () => {
    const actionArgs = buildSignTransactionActionArgs(retireDraft());

    await expect(
      signIxoTransactionWithWallet(
        actionArgs,
        vi.fn().mockResolvedValue({
          code: 5,
          transactionHash: 'D'.repeat(64),
          rawLog: 'insufficient funds',
        }),
        TESTNET,
      ),
    ).resolves.toEqual({
      success: true,
      delivered: { code: 5, transactionHash: 'D'.repeat(64) },
      error: 'insufficient funds',
    });
  });

  it('reports a wallet rejection and an empty wallet answer as success: false', async () => {
    const actionArgs = buildSignTransactionActionArgs(retireDraft());

    await expect(
      signIxoTransactionWithWallet(
        actionArgs,
        vi.fn().mockRejectedValue(new Error('Request rejected by user')),
        TESTNET,
      ),
    ).resolves.toEqual({ success: false, error: 'Request rejected by user' });

    await expect(
      signIxoTransactionWithWallet(
        actionArgs,
        vi.fn().mockResolvedValue(undefined),
        TESTNET,
      ),
    ).resolves.toEqual({
      success: false,
      error: 'Portal wallet did not return a transaction result',
    });
  });

  it('refuses a message outside the catalog, with an unknown field, or a second message', async () => {
    const args = buildSignTransactionActionArgs(retireDraft());
    const message = args.messages[0];
    if (!message) throw new Error('no message');
    const transactSignX = vi.fn();
    const sign = (messages: unknown[]) =>
      signIxoTransactionWithWallet(
        { ...args, messages },
        transactSignX,
        TESTNET,
      );

    await expect(
      sign([{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} }]),
    ).resolves.toEqual({
      success: false,
      error:
        'Unsupported message typeUrl /cosmos.bank.v1beta1.MsgSend: not in the IXO transaction catalog',
    });
    await expect(
      sign([{ ...message, value: { ...message.value, feeGranter: ADDRESS } }]),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/feeGranter/),
    });
    await expect(
      sign([{ ...message, value: { ...message.value, owner: 'cosmos1bad' } }]),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^owner: Expected an IXO bech32/),
    });
    await expect(sign([message, message])).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/messages/),
    });
    expect(transactSignX).not.toHaveBeenCalled();
  });

  it('answers malformed action args with success: false instead of calling the wallet', async () => {
    const transactSignX = vi.fn();
    const result = await signIxoTransactionWithWallet(
      { action: 'sign_transaction', network: 'testnet', messages: [] },
      transactSignX,
      TESTNET,
    );

    expect(transactSignX).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/messages/);
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
