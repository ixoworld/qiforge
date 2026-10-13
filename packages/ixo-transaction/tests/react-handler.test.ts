import { describe, expect, it, vi } from 'vitest';

import {
  buildBatchSignTransactionActionArgs,
  buildSignTransactionActionArgs,
} from '../src/action.js';
import { findMessageByTypeUrl } from '../src/catalog.js';
import {
  createSignTransactionHandler,
  type EncodedTransactFn,
} from '../src/react/handler.js';
import type { EncodeObject } from '../src/react/proto.js';
import { ADDRESS, draft } from './fixtures.js';
import { podBatchMessages } from './pod-batch.js';

function recordingWallet(result: unknown) {
  const calls: Array<{ messages: readonly EncodeObject[]; memo?: string }> = [];
  const transactSignX: EncodedTransactFn = async (messages, memo) => {
    calls.push({ messages, memo });
    return result;
  };
  return { calls, transactSignX };
}

describe('the Portal sign_transaction handler', () => {
  it('decodes proto-JSON into wallet-ready messages (base64 bytes, Long) and signs once', async () => {
    const wallet = recordingWallet({
      code: 0,
      height: 10,
      transactionHash: 'E'.repeat(64),
      gasUsed: 1n,
      gasWanted: 2n,
    });
    const handler = createSignTransactionHandler({
      chainId: 'pandora-8',
      transactSignX: wallet.transactSignX,
    });
    const args = buildSignTransactionActionArgs(
      draft(
        '/ixo smart-account remove-authenticator',
        { sender: ADDRESS, id: '42' },
        { memo: 'drop old key' },
      ),
    );

    const result = await handler(args);

    expect(result).toEqual({
      success: true,
      transactionHash: 'E'.repeat(64),
      code: 0,
      height: 10,
    });
    expect(wallet.calls).toHaveLength(1);
    const [call] = wallet.calls;
    expect(call?.memo).toBe('drop old key');
    expect(call?.messages[0]?.typeUrl).toBe(
      '/ixo.smartaccount.v1beta1.MsgRemoveAuthenticator',
    );
    const value = call?.messages[0]?.value;
    expect(value).toMatchObject({ sender: ADDRESS });
    // A uint64 decodes to the SDK's `Long`, not the JSON string it arrived as.
    const id: unknown =
      typeof value === 'object' && value !== null && 'id' in value
        ? value.id
        : undefined;
    expect(typeof id).toBe('object');
    expect(String(id)).toBe('42');
  });

  it('decodes every message of a batch and signs them in one wallet call', async () => {
    const wallet = recordingWallet({
      code: 0,
      height: 11,
      transactionHash: 'F'.repeat(64),
    });
    const handler = createSignTransactionHandler({
      chainId: 'pandora-8',
      transactSignX: wallet.transactSignX,
    });
    const messages = podBatchMessages();
    const args = buildBatchSignTransactionActionArgs({
      messages,
      summary: 'Create the Solar POD',
      network: 'testnet',
      memo: 'pod',
      riskConfirmation: {
        confirmed: true,
        acceptedRisks: messages.flatMap(
          (message) => findMessageByTypeUrl(message.typeUrl)?.risks ?? [],
        ),
      },
    });

    await expect(handler(args)).resolves.toEqual({
      success: true,
      transactionHash: 'F'.repeat(64),
      code: 0,
      height: 11,
    });

    expect(wallet.calls).toHaveLength(1);
    const [call] = wallet.calls;
    expect(call?.memo).toBe('pod');
    expect(call?.messages.map((message) => message.typeUrl)).toEqual(
      messages.map((message) => message.typeUrl),
    );
    // Each message went through the SDK's `fromJSON`: a uint64 is a `Long`
    // and the grant's authorization is an encoded `Any`.
    const collection = call?.messages[1]?.value;
    const quota: unknown =
      typeof collection === 'object' &&
      collection !== null &&
      'quota' in collection
        ? collection.quota
        : undefined;
    expect(typeof quota).toBe('object');
    expect(String(quota)).toBe('100');
    const grantMessage = call?.messages[3]?.value;
    const grant: unknown =
      typeof grantMessage === 'object' &&
      grantMessage !== null &&
      'grant' in grantMessage
        ? grantMessage.grant
        : undefined;
    expect(grant).toMatchObject({
      authorization: {
        typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
        value: expect.any(Uint8Array),
      },
    });
  });

  it('refuses another chain than the wallet before the wallet is touched', async () => {
    const transactSignX = vi.fn<EncodedTransactFn>();
    const handler = createSignTransactionHandler({
      chainId: 'ixo-5',
      transactSignX,
    });

    const result = await handler(
      buildSignTransactionActionArgs(
        draft('/ixo smart-account remove-authenticator', {
          sender: ADDRESS,
          id: '42',
        }),
      ),
    );

    expect(transactSignX).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Chain mismatch: the transaction is for pandora-8 (testnet) but this Portal wallet is on ixo-5; nothing was signed',
    );
  });

  it('turns a wallet rejection into success: false with its message', async () => {
    const handler = createSignTransactionHandler({
      chainId: 'pandora-8',
      transactSignX: async () => {
        throw new Error('User rejected the request');
      },
    });

    await expect(
      handler(
        buildSignTransactionActionArgs(
          draft('/ixo smart-account remove-authenticator', {
            sender: ADDRESS,
            id: '42',
          }),
        ),
      ),
    ).resolves.toEqual({
      success: false,
      error: 'User rejected the request',
    });
  });
});
