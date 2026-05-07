import { describe, expect, it } from 'vitest';
import { makeBuildCtx, makePlugin, makeTool } from './test-fixtures.js';
import { ToolRegistry } from './tool-registry.js';

describe('ToolRegistry', () => {
  it('collects tools from a single plugin in registration order', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getTools: () => [makeTool('store_memory'), makeTool('search_memory')],
      }),
    );

    const collected = await reg.collect(makeBuildCtx());

    expect(collected.map((c) => c.tool.name)).toEqual([
      'store_memory',
      'search_memory',
    ]);
    expect(collected.every((c) => c.pluginName === 'memory')).toBe(true);
  });

  it('collects tools from two plugins contributing different tools', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getTools: () => [makeTool('store_memory')],
      }),
    );
    reg.register(
      makePlugin({
        name: 'portal',
        getTools: () => [makeTool('open_browser')],
      }),
    );

    const collected = await reg.collect(makeBuildCtx());

    expect(collected.map((c) => `${c.pluginName}:${c.tool.name}`)).toEqual([
      'memory:store_memory',
      'portal:open_browser',
    ]);
    reg.assertNoCollisions();
  });

  it('forwards the supplied PluginContext to each plugin getTools', async () => {
    const reg = new ToolRegistry();
    let captured: { config: unknown; identityName: string } | null = null;
    reg.register(
      makePlugin({
        name: 'memory',
        getTools: (ctx) => {
          captured = { config: ctx.config, identityName: ctx.identity.name };
          return [makeTool('store_memory')];
        },
      }),
    );

    const ctx = makeBuildCtx({
      config: { FOO: 'bar' },
      identity: {
        name: 'CustomOracle',
        org: 'Acme',
        description: 'd',
        entityDid: 'did:ixo:c',
      },
    });
    await reg.collect(ctx);

    expect(captured).toEqual({
      config: { FOO: 'bar' },
      identityName: 'CustomOracle',
    });
  });

  it('throws on tool name collision across plugins, naming both plugins', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'slack',
        getTools: () => [makeTool('send_message')],
      }),
    );
    reg.register(
      makePlugin({
        name: 'matrix',
        getTools: () => [makeTool('send_message')],
      }),
    );

    await reg.collect(makeBuildCtx());

    expect(() => reg.assertNoCollisions()).toThrow(/send_message/);
    expect(() => reg.assertNoCollisions()).toThrow(/slack/);
    expect(() => reg.assertNoCollisions()).toThrow(/matrix/);
  });

  it('throws when assertNoCollisions called before collect', () => {
    const reg = new ToolRegistry();
    expect(() => reg.assertNoCollisions()).toThrow(/before collect/);
  });

  it('exposes per-plugin tool names after collect', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getTools: () => [makeTool('store_memory'), makeTool('search_memory')],
      }),
    );
    reg.register(
      makePlugin({ name: 'portal', getTools: () => [makeTool('open_url')] }),
    );

    await reg.collect(makeBuildCtx());

    expect(reg.toolNamesForPlugin('memory')).toEqual([
      'store_memory',
      'search_memory',
    ]);
    expect(reg.toolNamesForPlugin('portal')).toEqual(['open_url']);
    expect(reg.toolNamesForPlugin('unknown')).toEqual([]);
    expect(reg.toolNames()).toEqual([
      'store_memory',
      'search_memory',
      'open_url',
    ]);
  });
});
