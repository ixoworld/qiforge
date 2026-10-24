import { catalog, type HostFacts, type ToolName } from '@ixo/agent-tools';
import { FakeToolCallingModel } from 'langchain';
import type { OraclePlugin } from '../src/plugin-api/oracle-plugin';
import { createRuntimeCore } from '../src/core';
import { createNoopAmbient } from '../src/core/runtime-context';
import { makeEnv } from '../src/core/test-fixtures';
import { readIxoToolsConfig } from '../src/ixo-tools/config';
import {
  createTurnIxoTools,
  type VerifiedIxoDelegation,
} from '../src/ixo-tools/turn-host';
import { IxoToolsPlugin } from '../src/plugins/ixo-tools';
import topic from '../../agent-tools-sources/tests/fixtures/topics.md?raw';
import { protocolResponse } from '../../agent-tools-sources/test/source-server.mjs';

export const facts: HostFacts & { network: 'devnet' } = {
  userDid: 'did:ixo:alice',
  oracleDid: 'did:ixo:companion',
  network: 'devnet',
  sessionId: 'session-a',
  roomId: '!room:ixo.test',
  visibility: 'private',
  timezone: 'Asia/Singapore',
};
export const argsByName: Record<ToolName, Record<string, unknown>> = {
  ixo_account_get: {},
  ixo_credits_get: {},
  ixo_concept_get: { concept: 'Topic' },
  ixo_error_explain: { errorId: 'error-a' },
  ixo_files_find: { query: 'invoice', when: 'yesterday' },
  ixo_offramp_options: { asset: 'USDC', country: 'ZM' },
  ixo_offramp_quote: {
    asset: 'USDC',
    amount: '10.000001',
    corridor: 'ZM:bank',
  },
  ixo_operation_get: { operationId: 'operation-a' },
  ixo_memory_personal_search: { query: 'my goals' },
  ixo_memory_oracle_search: { query: 'program' },
};
export type Call = { name: string; args: Record<string, unknown>; id: string };
export type Script = Call[][];

export class ObservedToolCallingModel extends FakeToolCallingModel {
  readonly boundNames: string[][];
  constructor(script: Script, boundNames: string[][] = []) {
    super({ toolCalls: script });
    this.boundNames = boundNames;
  }
  override bindTools(tools: Parameters<FakeToolCallingModel['bindTools']>[0]) {
    this.boundNames.push(tools.map((tool) => tool.name));
    return super.bindTools(tools);
  }
}

export function loopFixture(
  options: {
    grants?: readonly ToolName[];
    modules?: readonly ToolName[];
    context?: typeof facts;
    oracleKnowledge?: 'public' | 'private';
    plugins?: OraclePlugin[];
    lifetimeSignal?: AbortSignal;
    onFetch?: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response | undefined>;
  } = {},
) {
  const context = options.context ?? facts;
  const requests: string[] = [];
  const grants = new Set(options.grants ?? catalog.map((entry) => entry.name));
  const modules = options.modules ?? catalog.map((entry) => entry.name);
  const revision = {};
  let active = true;
  let audience: 'private' | 'shared' = context.visibility;
  let creditsBaseUnits = '1234';
  let failedPath: string | null = null;
  let privateMemoryInShared = false;
  const delegation: VerifiedIxoDelegation = {
    raw: 'fixture-verified-delegation',
    revision,
    expiration: Math.floor(Date.now() / 1000) + 600,
    capabilities: [
      ...catalog.map(({ name }) => ({
        with: 'ixo:agent-tools',
        can: `agent-tools/${name}`,
      })),
      { with: 'ixo:subscriptions', can: 'subscriptions/read' },
      { with: 'ixo:memory', can: 'memory/search' },
      { with: 'ixo:yellowcard', can: 'yellowcard/agent-read' },
      { with: 'ixo:yellowcard', can: 'yellowcard/agent-quote' },
    ],
  };
  const config = readIxoToolsConfig({
    IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: 'https://subscriptions.ixo.test',
    IXO_TOOLS_MEMORY_ORIGIN: 'https://memory.ixo.test',
    IXO_TOOLS_VFS_ORIGIN: 'https://vfs.ixo.test',
    IXO_TOOLS_YELLOWCARD_ORIGIN: 'https://yellowcard.ixo.test',
    IXO_TOOLS_UCAN_STORE_ORIGIN: 'https://store.ixo.test',
    IXO_TOOLS_MODULES: modules.join(','),
    IXO_TOOLS_ORACLE_KNOWLEDGE: options.oracleKnowledge ?? 'public',
  });
  const binding = createTurnIxoTools({
    context,
    lifetimeSignal: options.lifetimeSignal,
    config,
    currentVerifiedDelegation: async () =>
      active
        ? {
            ...delegation,
            capabilities: delegation.capabilities.filter(
              (capability) =>
                capability.with !== 'ixo:agent-tools' ||
                catalog.some(
                  ({ name }) =>
                    grants.has(name) &&
                    capability.can === `agent-tools/${name}`,
                ),
            ),
          }
        : null,
    currentAudience: async () => audience,
    ucan: {
      hasSigningKey: () => true,
      createInvocationFromDelegation: async () => ({
        invocation: 'fixture-source-token',
      }),
      resolveServiceDid: async () => 'did:web:store.ixo.test',
      getServiceDelegation: async () => ({
        token: 'fixture-store-token',
        with: 'ixo:filesystem',
      }),
    },
    attachments: {
      inventory: async () => ({
        receipts: [],
        complete: true,
        reference: `attachments:${context.sessionId}`,
        revision: `sha256:${'a'.repeat(64)}`,
        observedAt: new Date().toISOString(),
      }),
      current: async () => true,
    },
    fetch: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const intercepted = await options.onFetch?.(url, init);
      if (intercepted) return intercepted;
      if (failedPath && url.includes(failedPath))
        return new Response('source unavailable', { status: 503 });
      if (privateMemoryInShared && url.endsWith('/agent/search')) {
        const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
        const query =
          body &&
          typeof body === 'object' &&
          'query' in body &&
          typeof body.query === 'string'
            ? body.query
            : '';
        return Response.json({
          representation: 1,
          scope: {
            userDid: context.userDid,
            oracleDid: context.oracleDid,
            knowledgeScope: 'oracle_private',
          },
          observedAt: new Date().toISOString(),
          facts: [
            {
              reference: 'memory:secret',
              revision: `sha256:${'a'.repeat(64)}`,
              text: 'PRIVATE SECRET',
              scope: {
                userDid: context.userDid,
                oracleDid: context.oracleDid,
                knowledgeScope: 'oracle_private',
              },
            },
          ],
          observation: {
            reference: 'memory:observation:private',
            revision: `sha256:${'a'.repeat(64)}`,
            query,
            limit: 10,
            coverage: 'bounded',
            empty: false,
          },
        });
      }
      if (url === 'https://docs.ixo.world/articles/topics.md')
        return new Response(topic);
      if (
        url.includes('/api/v1/subscriptions/account?') &&
        context.userDid !== facts.userDid
      ) {
        const address = context.userDid.split(':').at(-1);
        return Response.json({
          representation: 1,
          scope: {
            userDid: context.userDid,
            network: context.network,
            userAddress: address,
          },
          address,
          addressType: 'ixo_account',
          binding: 'verified_root_did',
          observedAt: new Date().toISOString(),
        });
      }
      if (
        url.includes('/api/v1/subscriptions?') &&
        creditsBaseUnits !== '1234'
      ) {
        const units = BigInt(creditsBaseUnits);
        return Response.json({
          representation: 2,
          scope: {
            userDid: context.userDid,
            network: context.network,
            userAddress: 'alice',
          },
          balance: {
            availability: 'available',
            ledger: {
              kind: 'subscription_credits',
              denom: 'upay',
              baseUnitsPerCredit: '1000',
              presentationUnit: 'credits',
            },
            account: { role: 'subscription_admin', address: 'admin' },
            amountBaseUnits: creditsBaseUnits,
            credits: `${units / 1000n}.${(units % 1000n).toString().padStart(3, '0')}`,
            observedAt: new Date().toISOString(),
            source: { kind: 'cosmos_bank', chainFreshness: 'unknown' },
          },
        });
      }
      return protocolResponse(url, init);
    },
  });
  const core = createRuntimeCore({
    config: { name: 'Companion', org: 'IXO' },
    plugins: [new IxoToolsPlugin(), ...(options.plugins ?? [])],
    env: makeEnv({
      ORACLE_DID: context.oracleDid,
      IXO_TOOLS_SUBSCRIPTIONS_ORIGIN: config.origins.subscriptions,
      IXO_TOOLS_MEMORY_ORIGIN: config.origins.memory,
      IXO_TOOLS_VFS_ORIGIN: config.origins.vfs,
      IXO_TOOLS_YELLOWCARD_ORIGIN: config.origins.yellowcard,
      IXO_TOOLS_UCAN_STORE_ORIGIN: config.storeUrl,
      IXO_TOOLS_MODULES: modules.join(','),
      IXO_TOOLS_ORACLE_KNOWLEDGE: config.oracleKnowledge,
    }),
  });
  function ambient(script: Script, boundNames: string[][] = []) {
    const model = new ObservedToolCallingModel(script, boundNames);
    const ambient = createNoopAmbient({
      config: core.validatedEnv,
      identity: core.identity,
      availablePlugins: core.availablePlugins,
      llm: { get: () => model },
    });
    ambient.ixoTools = binding;
    return ambient;
  }
  const requestCtx = {
    user: {
      did: context.userDid,
      matrixUserId: '@alice:ixo.test',
      ucanDelegation: { raw: 'fixture-verified-delegation' },
      timezone: context.timezone,
      currentTime: new Date().toISOString(),
    },
    session: {
      id: context.sessionId,
      roomId: context.roomId,
      client: 'portal' as const,
      requestId: 'req-ixo',
    },
  };
  return {
    core,
    binding,
    context,
    requests,
    grants,
    ambient,
    requestCtx,
    revoke: () => {
      active = false;
    },
    setAudience: (value: 'private' | 'shared') => {
      audience = value;
    },
    setCreditsBaseUnits: (value: string) => {
      creditsBaseUnits = value;
    },
    failPath: (value: string) => {
      failedPath = value;
    },
    servePrivateMemoryInShared: () => {
      privateMemoryInShared = true;
    },
  };
}
