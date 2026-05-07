import { describe, expect, it } from 'vitest';
import { SubAgentRegistry } from './subagent-registry.js';
import { makeBuildCtx, makePlugin, makeSubAgent } from './test-fixtures.js';

describe('SubAgentRegistry', () => {
  it('collects sub-agents from a single plugin', () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );

    const collected = reg.collect(makeBuildCtx());

    expect(collected).toHaveLength(1);
    expect(collected[0]?.subAgent.name).toBe('call_memory_agent');
    expect(collected[0]?.pluginName).toBe('memory');
  });

  it('tags each entry with its contributing plugin name', () => {
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

    const collected = reg.collect(makeBuildCtx());

    expect(
      collected.map((c) => `${c.pluginName}:${c.subAgent.name}`),
    ).toEqual(['memory:call_memory_agent', 'portal:call_portal_agent']);
    reg.assertNoCollisions();
  });

  it('forwards the supplied PluginContext to plugin getSubAgents', () => {
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

    reg.collect(
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

  it('throws on sub-agent name collision, naming both plugins', () => {
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

    reg.collect(makeBuildCtx());

    expect(() => reg.assertNoCollisions()).toThrow(/call_memory_agent/);
    expect(() => reg.assertNoCollisions()).toThrow(/memory/);
    expect(() => reg.assertNoCollisions()).toThrow(/memory-experimental/);
  });

  it('throws when assertNoCollisions is called before collect', () => {
    const reg = new SubAgentRegistry();
    expect(() => reg.assertNoCollisions()).toThrow(/before collect/);
  });
});
