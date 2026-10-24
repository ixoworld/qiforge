import { createAgentToolsHost, nativeTools, mcpTools } from '@ixo/agent-tools';

export default {
  async fetch() {
    const scope = {
      userDid: 'did:ixo:alice',
      oracleDid: 'did:ixo:companion',
      network: 'devnet',
      sessionId: 'session-a',
      roomId: 'room-a',
      visibility: 'private',
      timezone: 'Asia/Singapore',
    };
    let granted = true;
    const host = createAgentToolsHost({
      now: () => Date.parse('2026-10-24T12:00:00Z'),
      readGrants: async () =>
        granted
          ? [
              {
                ...scope,
                tool: 'ixo_credits_get',
                expiresAt: '2026-10-24T13:00:00Z',
              },
            ]
          : [],
      adapters: {
        ixo_credits_get: async () => ({
          version: 1,
          status: 'available',
          scope,
          value: {
            lookupStatus: 'confirmed',
            amount: '123456789012345678901001',
            denomination: 'upay',
            decimals: 3,
            ledger: 'subscription_credits',
            network: 'devnet',
          },
          evidence: [
            {
              source: 'subscriptions',
              reference: 'balance:alice',
              revision: 'revision-1',
              observedAt: '2026-10-24T12:00:00Z',
              freshness: 'current',
            },
          ],
        }),
      },
    });
    const token = host.bindContext(scope);
    const available = await host.invoke(token, 'ixo_credits_get', {});
    const invalid = await host.invoke(token, 'ixo_credits_get', {
      userDid: 'did:ixo:bob',
    });
    const forged = await host.invoke({}, 'ixo_credits_get', {});
    granted = false;
    const revoked = await host.invoke(token, 'ixo_credits_get', {});
    const project = (tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
    });
    return globalThis.Response.json({
      runtime:
        globalThis.navigator.userAgent === 'Cloudflare-Workers'
          ? 'workerd'
          : 'unexpected-runtime',
      availableAmount:
        available.status === 'available'
          ? available.value.amount
          : available.status,
      invalidArguments: invalid.reason,
      forgedContext: forged.reason,
      revoked: revoked.reason,
      catalogParity:
        JSON.stringify(nativeTools().map(project)) ===
        JSON.stringify(mcpTools().map(project)),
    });
  },
};
