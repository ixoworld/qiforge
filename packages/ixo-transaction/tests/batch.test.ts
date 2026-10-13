/**
 * The batch form of `sign_transaction`: several catalogued messages signed
 * in one wallet transaction. Conversational drafts stay single-message.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SignTransactionActionArgsSchema,
  buildBatchSignTransactionActionArgs,
  buildSignTransactionActionArgs,
  signIxoTransactionWithWallet,
} from '../src/action.js';
import { findMessageByTypeUrl } from '../src/catalog.js';
import { MAX_BATCH_MESSAGES, type ITrxMsg } from '../src/schemas.js';
import {
  describeValidationError,
  validateTransactionBatch,
  validateTransactionDraft,
} from '../src/validate.js';
import { ADDRESS, ENTITY_DID, draft } from './fixtures.js';
import { podBatchMessages } from './pod-batch.js';

const TESTNET = { walletChainId: 'pandora-8' };

const CREATE_ACCOUNT: ITrxMsg = {
  typeUrl: '/ixo.entity.v1beta1.MsgCreateEntityAccount',
  value: { id: ENTITY_DID, name: 'payments', ownerAddress: ADDRESS },
};

function risksOf(messages: readonly ITrxMsg[]): string[] {
  return [
    ...new Set(
      messages.flatMap(
        (message) => findMessageByTypeUrl(message.typeUrl)?.risks ?? [],
      ),
    ),
  ];
}

function batch(
  messages: readonly ITrxMsg[],
  extra: Record<string, unknown> = {},
) {
  return {
    messages,
    summary: 'Create the Solar POD: entity, claim collection and grants',
    network: 'testnet',
    riskConfirmation: { confirmed: true, acceptedRisks: risksOf(messages) },
    ...extra,
  };
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return describeValidationError(error);
  }
  return 'accepted';
}

describe('conversational drafts stay single-message', () => {
  it('a draft cannot carry a list of messages', () => {
    expect(
      failure(() =>
        validateTransactionDraft({
          command: '/ixo entity create-account',
          value: CREATE_ACCOUNT.value,
          messages: [CREATE_ACCOUNT, CREATE_ACCOUNT],
        }),
      ),
    ).toMatch(/Unrecognized key.*messages/);
  });

  it('builds the single form, which the schema keeps to one message', () => {
    const args = buildSignTransactionActionArgs(
      draft('/ixo entity create-account', CREATE_ACCOUNT.value),
    );
    expect(args.intent.source).toBe('slash-command');
    expect(args.messages).toHaveLength(1);
    expect(
      failure(() =>
        SignTransactionActionArgsSchema.parse({
          ...args,
          messages: [CREATE_ACCOUNT, CREATE_ACCOUNT],
        }),
      ),
    ).toBe(
      "messages: A single-message request carries exactly one message; several are sent as a batch (intent.source 'batch')",
    );
  });
});

describe('validateTransactionBatch', () => {
  it(`accepts 1 to ${MAX_BATCH_MESSAGES} messages and nothing outside that`, () => {
    const many = (count: number) =>
      Array.from({ length: count }, () => CREATE_ACCOUNT);
    expect(validateTransactionBatch(batch(many(1))).messages).toHaveLength(1);
    expect(
      validateTransactionBatch(batch(many(MAX_BATCH_MESSAGES))).messages,
    ).toHaveLength(MAX_BATCH_MESSAGES);
    expect(failure(() => validateTransactionBatch(batch([])))).toMatch(
      /^messages: Too small/,
    );
    expect(
      failure(() =>
        validateTransactionBatch(batch(many(MAX_BATCH_MESSAGES + 1))),
      ),
    ).toMatch(/^messages: Too big/);
  });

  it('needs a summary of at most 1000 characters', () => {
    expect(
      failure(() =>
        validateTransactionBatch(batch([CREATE_ACCOUNT], { summary: '  ' })),
      ),
    ).toMatch(/^summary: Too small/);
    expect(
      failure(() =>
        validateTransactionBatch(
          batch([CREATE_ACCOUNT], { summary: 'x'.repeat(1001) }),
        ),
      ),
    ).toMatch(/^summary: Too big/);
  });

  it('validates every message against the catalog, naming the one that fails', () => {
    expect(
      failure(() =>
        validateTransactionBatch(
          batch([
            CREATE_ACCOUNT,
            { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} },
          ]),
        ),
      ),
    ).toBe(
      'Unsupported message typeUrl /cosmos.bank.v1beta1.MsgSend: not in the IXO transaction catalog',
    );
    expect(
      failure(() =>
        validateTransactionBatch(
          batch([
            CREATE_ACCOUNT,
            {
              ...CREATE_ACCOUNT,
              value: { ...CREATE_ACCOUNT.value, ownerAddress: 'cosmos1bad' },
            },
          ]),
        ),
      ),
    ).toMatch(/^ownerAddress: Expected an IXO bech32/);
  });

  it('derives the risks from every message: each once, in order, at the highest level', () => {
    const [entity, , , grant] = podBatchMessages();
    if (!entity || !grant) throw new Error('fixture is short');

    const medium = validateTransactionBatch(
      batch([CREATE_ACCOUNT, CREATE_ACCOUNT]),
    );
    expect(medium.riskLevel).toBe('medium');
    expect(medium.risks).toEqual([
      'Creates a deterministic module account controlled by the entity.',
    ]);

    const high = validateTransactionBatch(batch([CREATE_ACCOUNT, entity]));
    expect(high.riskLevel).toBe('high');
    expect(high.requiresConfirmation).toBe(true);

    const critical = validateTransactionBatch(
      batch([entity, CREATE_ACCOUNT, grant, CREATE_ACCOUNT]),
    );
    expect(critical.riskLevel).toBe('critical');
    expect(critical.risks).toEqual([
      'Creates a new entity, admin account, DID document, and ownership NFT. The entity DID is chain-derived and cannot be chosen.',
      'Creates a deterministic module account controlled by the entity.',
      'Grants another address authority from an entity account. Scope, expiration, and message type must be reviewed.',
    ]);
    expect(critical.routes.map((route) => route.messageName)).toEqual([
      'MsgCreateEntity',
      'MsgCreateEntityAccount',
      'MsgGrantEntityAccountAuthz',
      'MsgCreateEntityAccount',
    ]);
  });

  it('requires every risk of every message accepted word for word when signing', () => {
    const messages = podBatchMessages();
    const all = risksOf(messages);
    const sign = (acceptedRisks: string[], confirmed: true = true) =>
      failure(() =>
        validateTransactionBatch(
          batch(messages, { riskConfirmation: { confirmed, acceptedRisks } }),
          { requireRiskConfirmation: true },
        ),
      );

    expect(sign(all)).toBe('accepted');
    expect(sign(all.slice(1))).toBe(
      `Risk confirmation required before signing the batch of 4 messages: the user must accept, word for word, ${JSON.stringify(all[0])}`,
    );
    expect(
      failure(() =>
        validateTransactionBatch(
          batch(messages, { riskConfirmation: undefined }),
          {
            requireRiskConfirmation: true,
          },
        ),
      ),
    ).toMatch(/^Risk confirmation required before signing the batch/);
    // Validation alone only reports the risks.
    expect(
      validateTransactionBatch(batch(messages, { riskConfirmation: undefined }))
        .risks,
    ).toEqual(all);
  });

  it('refuses mainnet unless the caller allows it, and takes no testnet receipt', () => {
    const mainnet = batch([CREATE_ACCOUNT], { network: 'mainnet' });
    expect(failure(() => validateTransactionBatch(mainnet))).toBe(
      'Mainnet transactions are disabled for this oracle: prepare the transaction on testnet instead',
    );
    expect(
      validateTransactionBatch(mainnet, { allowMainnet: true }).network,
    ).toBe('mainnet');
    expect(
      failure(() =>
        validateTransactionBatch(
          batch([CREATE_ACCOUNT], {
            testnetReceipt: {
              transactionHash: 'A'.repeat(64),
              receiptId: 'blob_0123456789abcdef',
            },
          }),
        ),
      ),
    ).toMatch(/Unrecognized key.*testnetReceipt/);
  });
});

describe('buildBatchSignTransactionActionArgs', () => {
  it('renders the batch form with the chain id of the network', () => {
    const messages = podBatchMessages();
    const args = buildBatchSignTransactionActionArgs(
      batch(messages, { memo: 'pod' }),
    );

    expect(args).toEqual({
      action: 'sign_transaction',
      network: 'testnet',
      chainId: 'pandora-8',
      messages,
      memo: 'pod',
      intent: {
        source: 'batch',
        summary: 'Create the Solar POD: entity, claim collection and grants',
        messages: [
          {
            module: 'entity',
            action: 'create',
            messageName: 'MsgCreateEntity',
            typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
          },
          {
            module: 'claims',
            action: 'create-collection',
            messageName: 'MsgCreateCollection',
            typeUrl: '/ixo.claims.v1beta1.MsgCreateCollection',
          },
          {
            module: 'claims',
            action: 'create-claim-authorization',
            messageName: 'MsgCreateClaimAuthorization',
            typeUrl: '/ixo.claims.v1beta1.MsgCreateClaimAuthorization',
          },
          {
            module: 'entity',
            action: 'grant-account-authz',
            messageName: 'MsgGrantEntityAccountAuthz',
            typeUrl: '/ixo.entity.v1beta1.MsgGrantEntityAccountAuthz',
          },
        ],
      },
      risks: risksOf(messages),
      riskLevel: 'critical',
      requiresConfirmation: true,
      riskConfirmation: { confirmed: true, acceptedRisks: risksOf(messages) },
    });
    expect(
      buildBatchSignTransactionActionArgs(
        batch(messages, { network: 'devnet' }),
        { chainIds: { devnet: 'devnet-2', testnet: 'x', mainnet: 'y' } },
      ).chainId,
    ).toBe('devnet-2');
  });

  it('refuses to build without the risk confirmation', () => {
    expect(
      failure(() =>
        buildBatchSignTransactionActionArgs(
          batch(podBatchMessages(), { riskConfirmation: undefined }),
        ),
      ),
    ).toMatch(/^Risk confirmation required before signing the batch/);
  });

  it('the args schema refuses a batch whose intent misnames its messages or that cites a receipt', () => {
    const args = buildBatchSignTransactionActionArgs(batch(podBatchMessages()));
    expect(
      failure(() =>
        SignTransactionActionArgsSchema.parse({
          ...args,
          messages: [...args.messages].reverse(),
        }),
      ),
    ).toBe(
      'intent.messages: The batch intent must name every message, in order',
    );
    expect(
      failure(() =>
        SignTransactionActionArgsSchema.parse({
          ...args,
          testnetReceipt: {
            transactionHash: 'A'.repeat(64),
            receiptId: 'blob_0123456789abcdef',
          },
        }),
      ),
    ).toBe('testnetReceipt: A batch carries no testnet receipt');
  });
});

describe('the Portal side of a batch', () => {
  it('validates every message and signs them all in one wallet call', async () => {
    const args = buildBatchSignTransactionActionArgs(
      batch(podBatchMessages(), { memo: 'pod' }),
    );
    const transactSignX = vi.fn().mockResolvedValue({
      transactionHash: 'B'.repeat(64),
      code: 0,
      height: 9,
    });

    await expect(
      signIxoTransactionWithWallet(args, transactSignX, TESTNET),
    ).resolves.toEqual({
      success: true,
      transactionHash: 'B'.repeat(64),
      code: 0,
      height: 9,
    });
    expect(transactSignX).toHaveBeenCalledTimes(1);
    expect(transactSignX).toHaveBeenCalledWith(args.messages, 'pod');
  });

  it('refuses the whole batch when one message is outside the catalog', async () => {
    const args = buildBatchSignTransactionActionArgs(batch(podBatchMessages()));
    const transactSignX = vi.fn();
    const smuggled = { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} };

    await expect(
      signIxoTransactionWithWallet(
        {
          ...args,
          messages: [...args.messages, smuggled],
          intent: {
            ...args.intent,
            messages: [
              ...args.intent.messages,
              {
                module: 'bank',
                action: 'send',
                messageName: 'MsgSend',
                typeUrl: smuggled.typeUrl,
              },
            ],
          },
        },
        transactSignX,
        TESTNET,
      ),
    ).resolves.toEqual({
      success: false,
      error:
        'Unsupported message typeUrl /cosmos.bank.v1beta1.MsgSend: not in the IXO transaction catalog',
    });
    expect(transactSignX).not.toHaveBeenCalled();
  });

  it('still refuses another chain than the wallet', async () => {
    const transactSignX = vi.fn();
    await expect(
      signIxoTransactionWithWallet(
        buildBatchSignTransactionActionArgs(batch(podBatchMessages())),
        transactSignX,
        { walletChainId: 'ixo-5' },
      ),
    ).resolves.toEqual({
      success: false,
      error:
        'Chain mismatch: the transaction is for pandora-8 (testnet) but this Portal wallet is on ixo-5; nothing was signed',
    });
    expect(transactSignX).not.toHaveBeenCalled();
  });
});
