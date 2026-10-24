import { createAgentToolsHost, catalog } from '@ixo/agent-tools';
import { createIXOSourceAdapters } from '@ixo/agent-tools-sources';

const topic = '__TOPIC_BYTES__';

export default {
  async fetch(_request, env) {
    const now = new Date().toISOString();
    const context = {
      userDid: 'did:ixo:alice',
      oracleDid: 'did:ixo:companion',
      network: 'devnet',
      sessionId: 'session-a',
      roomId: '!room:ixo.test',
      visibility: 'private',
      timezone: 'Asia/Singapore',
    };
    const revision = `sha256:${'a'.repeat(64)}`;
    let minted = 0;
    const authority = {
      subscriptions: async () =>
        `subscriptions-${++minted}-${globalThis.crypto.randomUUID()}`,
      memory: async () =>
        `memory-${++minted}-${globalThis.crypto.randomUUID()}`,
      vfs: async () => `vfs-${++minted}-${globalThis.crypto.randomUUID()}`,
      yellowcard: async () =>
        `yellowcard-${++minted}-${globalThis.crypto.randomUUID()}`,
    };
    const fetcher = async (input, init) => {
      const url = new globalThis.URL(input);
      if (url.hostname === 'docs.ixo.world')
        return new globalThis.Response(topic);
      return globalThis.fetch(input, init);
    };
    const sources = createIXOSourceAdapters({
      network: 'devnet',
      origins: {
        subscriptions: env.SOURCE_ORIGIN,
        memory: env.SOURCE_ORIGIN,
        vfs: env.SOURCE_ORIGIN,
        yellowcard: env.SOURCE_ORIGIN,
      },
      authority,
      fetch: fetcher,
      attachments: {
        inventory: async () => ({
          receipts: [],
          complete: true,
          reference: 'attachments:session-a',
          revision,
          observedAt: now,
        }),
        current: async () => true,
      },
    });
    const host = createAgentToolsHost({
      ...sources,
      readGrants: () =>
        catalog.map(({ name }) => ({
          ...context,
          tool: name,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })),
    });
    const token = host.bindContext(context);
    const scenarios = [
      ['ixo_account_get', {}],
      ['ixo_credits_get', {}],
      ['ixo_concept_get', { concept: 'Topic' }],
      ['ixo_files_find', { query: 'invoice', when: 'yesterday' }],
      ['ixo_memory_personal_search', { query: 'my goals' }],
      ['ixo_memory_oracle_search', { query: 'program' }],
      ['ixo_operation_get', { operationId: 'operation-a' }],
      ['ixo_error_explain', { errorId: 'error-a' }],
      ['ixo_offramp_options', { asset: 'USDC', country: 'ZM' }],
      [
        'ixo_offramp_quote',
        { asset: 'USDC', amount: '10.000001', corridor: 'ZM:bank' },
      ],
    ];
    const results = [];
    for (const [name, input] of scenarios)
      results.push({ name, result: await host.invoke(token, name, input) });
    return globalThis.Response.json({
      runtime: globalThis.navigator.userAgent,
      results,
      minted,
    });
  },
};
