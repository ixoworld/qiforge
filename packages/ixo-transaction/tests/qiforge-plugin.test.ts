import { callAgAction } from '@ixo/common/ai/tools/action-caller';
import { describe, expect, it, vi } from 'vitest';

import { ADDRESS, DID, DID_2, ENTITY_DID, draft } from './fixtures.js';

vi.mock('@ixo/common/ai/tools/action-caller', () => ({
  callAgAction: vi.fn(),
}));

async function loadPluginModule() {
  return import('../src/qiforge/index.js');
}

describe('Qiforge plugin', () => {
  it('exposes a Qiforge OraclePlugin manifest and tools', async () => {
    const { IxoTransactionPlugin, createIxoTransactionPlugin } =
      await loadPluginModule();
    const plugin = createIxoTransactionPlugin();
    const tools = await plugin.getTools({} as never);

    expect(plugin).toBeInstanceOf(IxoTransactionPlugin);
    expect(plugin.name).toBe('ixo-transaction');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(tools.map((entry) => entry.name)).toEqual([
      'list_ixo_transaction_routes',
      'classify_ixo_transaction_intent',
      'validate_ixo_transaction_draft',
      'sign_ixo_transaction',
    ]);
  });

  it('classifies natural language intent through a plugin tool', async () => {
    const { IxoTransactionPlugin } = await loadPluginModule();
    const plugin = new IxoTransactionPlugin();
    const tools = await plugin.getTools({} as never);
    const classify = tools.find(
      (entry) => entry.name === 'classify_ixo_transaction_intent',
    );

    const result = await classify?.handler(
      { input: 'I want to create a new domain' },
      {} as never,
    );

    expect(result).toMatchObject({
      module: 'entity',
      action: 'create',
      messageName: 'MsgCreateEntity',
      typeUrl: '/ixo.entity.v1beta1.MsgCreateEntity',
    });
  });

  it('dispatches the validated draft to the frontend sign_transaction action', async () => {
    vi.mocked(callAgAction).mockResolvedValueOnce({
      success: true,
      transactionHash: 'A'.repeat(64),
    });
    const { IxoTransactionPlugin } = await loadPluginModule();
    const plugin = new IxoTransactionPlugin();
    const tools = await plugin.getTools({} as never);
    const sign = tools.find((entry) => entry.name === 'sign_ixo_transaction');

    const result = await sign?.handler(
      draft('/ixo entity transfer', {
        id: ENTITY_DID,
        ownerDid: DID,
        ownerAddress: ADDRESS,
        recipientDid: DID_2,
      }),
      { session: { id: 'session-1', requestId: 'req-1' } } as never,
    );

    expect(result).toMatchObject({
      success: true,
      transactionHash: 'A'.repeat(64),
    });
    expect(callAgAction).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        toolName: 'sign_transaction',
        timeout: 120000,
        args: expect.objectContaining({
          action: 'sign_transaction',
          network: 'testnet',
          riskLevel: 'critical',
          requiresConfirmation: true,
          riskConfirmation: expect.objectContaining({ confirmed: true }),
          messages: [
            {
              typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity',
              value: expect.objectContaining({
                id: ENTITY_DID,
                ownerDid: DID,
                ownerAddress: ADDRESS,
                recipientDid: DID_2,
              }),
            },
          ],
        }),
      }),
    );
  });
});
