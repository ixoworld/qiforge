import { describe, expect, it } from 'vitest';
import { SubAgentRegistry } from './subagent-registry.js';
import {
  makeBuildCtx,
  makePlugin,
  makeRuntimeContext,
  makeSubAgent,
} from './test-fixtures.js';

describe('SubAgentRegistry', () => {
  it('collects sub-agents from a single plugin', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );

    const collected = await reg.collect(makeBuildCtx());

    expect(collected).toHaveLength(1);
    expect(collected[0]?.subAgent.name).toBe('call_memory_agent');
    expect(collected[0]?.pluginName).toBe('memory');
  });

  it('tags each entry with its contributing plugin name', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );
    reg.register(
      makePlugin({
        name: 'portal',
        getSubAgents: () => [makeSubAgent('call_portal_agent')],
      }),
    );

    const collected = await reg.collect(makeBuildCtx());

    expect(collected.map((c) => `${c.pluginName}:${c.subAgent.name}`)).toEqual([
      'memory:call_memory_agent',
      'portal:call_portal_agent',
    ]);
    reg.assertNoCollisions();
  });

  it('forwards the supplied PluginContext to plugin getSubAgents', async () => {
    const reg = new SubAgentRegistry();
    let received: string | null = null;
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: (ctx) => {
          received = ctx.identity.name;
          return [makeSubAgent('call_memory_agent')];
        },
      }),
    );

    await reg.collect(
      makeBuildCtx({
        identity: {
          name: 'OracleX',
          org: 'Acme',
          description: 'd',
          entityDid: 'did:ixo:x',
        },
      }),
    );
    expect(received).toBe('OracleX');
  });

  it('throws on sub-agent name collision, naming both plugins', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );
    reg.register(
      makePlugin({
        name: 'memory-experimental',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );

    await reg.collect(makeBuildCtx());

    expect(() => reg.assertNoCollisions()).toThrow(/call_memory_agent/);
    expect(() => reg.assertNoCollisions()).toThrow(/memory/);
    expect(() => reg.assertNoCollisions()).toThrow(/memory-experimental/);
  });

  it('throws when assertNoCollisions is called before collect', () => {
    const reg = new SubAgentRegistry();
    expect(() => reg.assertNoCollisions()).toThrow(/before collect/);
  });

  it('merges boot-time getSubAgents with request-time getRequestSubAgents when rtCtx is supplied', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'agui',
        getSubAgents: () => [makeSubAgent('call_agui_static_agent')],
        getRequestSubAgents: (rtCtx) => {
          const actions =
            (rtCtx.history.state as { agActions?: string[] }).agActions ?? [];
          return actions.map((a) => makeSubAgent(`call_agui_${a}_agent`));
        },
      }),
    );

    const rtCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], agActions: ['plan'] },
      },
    });
    const collected = await reg.collect(makeBuildCtx(), rtCtx);
    expect(collected.map((c) => c.subAgent.name)).toEqual([
      'call_agui_static_agent',
      'call_agui_plan_agent',
    ]);
  });
});
