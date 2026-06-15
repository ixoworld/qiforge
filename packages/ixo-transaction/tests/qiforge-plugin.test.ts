import { describe, expect, it } from 'vitest';

import { ADDRESS, DID, DID_2, ENTITY_DID, draft } from './fixtures.js';

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
      'render_ixo_transaction_payload',
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

  it('renders the core signxTransaction payload through a plugin tool', async () => {
    const { IxoTransactionPlugin } = await loadPluginModule();
    const plugin = new IxoTransactionPlugin();
    const tools = await plugin.getTools({} as never);
    const render = tools.find(
      (entry) => entry.name === 'render_ixo_transaction_payload',
    );

    const result = await render?.handler(
      draft('/ixo entity transfer', {
        id: ENTITY_DID,
        ownerDid: DID,
        ownerAddress: ADDRESS,
        recipientDid: DID_2,
      }),
      {} as never,
    );

    expect(result).toMatchObject({
      transport: 'portal.signxTransaction',
      payload: {
        type: 'signxTransaction',
        messages: [
          {
            typeUrl: '/ixo.entity.v1beta1.MsgTransferEntity',
          },
        ],
      },
    });
  });
});
