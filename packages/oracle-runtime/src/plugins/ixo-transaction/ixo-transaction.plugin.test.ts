import { describe, expect, it, vi } from 'vitest';

import { callAgAction } from '@ixo/common';
import { validateManifest } from '../../manifest/validator.js';
import {
  makeBuildCtx,
  makeRuntimeContext,
} from '../../registries/test-fixtures.js';
import type { PluginTool } from '../../plugin-api/types.js';
import { IxoTransactionPlugin } from './ixo-transaction.plugin.js';

vi.mock('@ixo/common', () => ({
  callAgAction: vi.fn(async () => ({ transactionHash: 'TX_OK', code: 0 })),
}));

const ADDRESS = 'ixo1zr8shq3kv9m2tn7wx4yc6da5fg0jl8p3ue2bq9';
const ADDRESS_2 = 'ixo1aq7wt3nz8x5c2v9b6m4k1j0h8g5f3d7s2a9e4r6';
const ENTITY_DID = 'did:ixo:entity:0123456789abcdef0123456789abcdef';
const DID = `did:ixo:${ADDRESS}`;
const DID_2 = `did:ixo:${ADDRESS_2}`;

const confirmedTransfer = {
  command: '/ixo entity transfer',
  value: {
    id: ENTITY_DID,
    ownerDid: DID,
    ownerAddress: ADDRESS,
    recipientDid: DID_2,
  },
  riskConfirmation: {
    confirmed: true,
    acceptedRisks: ['ownership transfer is irreversible'],
  },
};

function getTool(name: string): PluginTool {
  const plugin = new IxoTransactionPlugin();
  const tools = plugin.getTools(makeBuildCtx());
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe('IxoTransactionPlugin', () => {
  it('has a valid identity and manifest', () => {
    const plugin = new IxoTransactionPlugin();
    expect(plugin.name).toBe('ixo-transaction');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.category).toBe('integration');

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('registers exactly the four transaction tools', () => {
    const plugin = new IxoTransactionPlugin();
    const tools = plugin.getTools(makeBuildCtx());
    expect(tools.map((t) => t.name)).toEqual([
      'list_ixo_transaction_routes',
      'classify_ixo_transaction_intent',
      'validate_ixo_transaction_draft',
      'sign_ixo_transaction',
    ]);
  });

  it('validate_ixo_transaction_draft returns the canonical message without signing', async () => {
    const callAgActionMock = vi.mocked(callAgAction);
    callAgActionMock.mockClear();

    const tool = getTool('validate_ixo_transaction_draft');
    const result = await tool.handler(confirmedTransfer, makeRuntimeContext());

    expect(result).toMatchObject({
      status: 'valid',
      message: { typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity' },
    });
    expect(callAgActionMock).not.toHaveBeenCalled();
  });

  describe('sign_ixo_transaction', () => {
    it('dispatches the validated transaction to the sign_transaction action and reports the hash', async () => {
      const callAgActionMock = vi.mocked(callAgAction);
      callAgActionMock.mockClear();
      callAgActionMock.mockResolvedValueOnce({ transactionHash: 'TX_HASH_1' });

      const tool = getTool('sign_ixo_transaction');
      const ctx = makeRuntimeContext({
        session: { id: 'sess-1', client: 'portal', requestId: 'req-1' },
      });
      const result = await tool.handler(confirmedTransfer, ctx);

      expect(result).toMatchObject({
        status: 'signed',
        typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity',
        result: { transactionHash: 'TX_HASH_1' },
      });

      expect(callAgActionMock).toHaveBeenCalledTimes(1);
      const callArgs = callAgActionMock.mock.calls[0]?.[0];
      expect(callArgs?.toolName).toBe('sign_transaction');
      expect(callArgs?.sessionId).toBe('sess-1');
      expect(callArgs?.timeout).toBe(120_000);
      expect(callArgs?.args).toMatchObject({
        messages: [{ typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity' }],
        network: 'testnet',
      });
    });

    it('refuses (validation_error) when risk confirmation is missing — never dispatches', async () => {
      const callAgActionMock = vi.mocked(callAgAction);
      callAgActionMock.mockClear();

      const tool = getTool('sign_ixo_transaction');
      const result = await tool.handler(
        { command: '/ixo entity transfer', value: confirmedTransfer.value },
        makeRuntimeContext(),
      );

      expect(result).toMatchObject({ status: 'validation_error' });
      expect(callAgActionMock).not.toHaveBeenCalled();
    });

    it('returns unavailable when there is no Portal session', async () => {
      const callAgActionMock = vi.mocked(callAgAction);
      callAgActionMock.mockClear();

      const tool = getTool('sign_ixo_transaction');
      const ctx = makeRuntimeContext({
        session: { id: '', client: 'portal', requestId: 'req-1' },
      });
      const result = await tool.handler(confirmedTransfer, ctx);

      expect(result).toMatchObject({ status: 'unavailable' });
      expect(callAgActionMock).not.toHaveBeenCalled();
    });

    it('maps a wallet rejection to status "rejected"', async () => {
      const callAgActionMock = vi.mocked(callAgAction);
      callAgActionMock.mockClear();
      callAgActionMock.mockRejectedValueOnce(
        new Error('User rejected the request'),
      );

      const tool = getTool('sign_ixo_transaction');
      const result = await tool.handler(
        confirmedTransfer,
        makeRuntimeContext(),
      );
      expect(result).toMatchObject({ status: 'rejected' });
    });

    it('maps a timeout to status "timeout"', async () => {
      const callAgActionMock = vi.mocked(callAgAction);
      callAgActionMock.mockClear();
      callAgActionMock.mockRejectedValueOnce(
        new Error('AG-UI action timeout after 120000ms: sign_transaction'),
      );

      const tool = getTool('sign_ixo_transaction');
      const result = await tool.handler(
        confirmedTransfer,
        makeRuntimeContext(),
      );
      expect(result).toMatchObject({ status: 'timeout' });
    });
  });
});
