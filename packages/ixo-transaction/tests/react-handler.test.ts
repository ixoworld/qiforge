import { describe, expect, it, vi } from 'vitest';

import { buildSignTransactionActionArgs } from '../src/action.js';
import {
  createSignTransactionHandler,
  type EncodedTransactFn,
} from '../src/react/handler.js';
import type { EncodeObject } from '../src/react/proto.js';
import { ADDRESS, draft } from './fixtures.js';

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
