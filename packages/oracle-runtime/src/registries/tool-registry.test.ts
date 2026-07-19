import { describe, expect, it } from 'vitest';
import {
  makeBuildCtx,
  makePlugin,
  makeRuntimeContext,
  makeTool,
} from './test-fixtures.js';
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

  it('merges boot-time getTools with request-time getRequestTools when rtCtx is supplied', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'agui',
        // Boot-time contributes a baseline tool.
        getTools: () => [makeTool('agui_baseline')],
        // Request-time contributes additional tools derived from state.
        getRequestTools: (rtCtx) => {
          const actions =
            (rtCtx.history.state as { agActions?: string[] }).agActions ?? [];
          return actions.map((name) => makeTool(`agui_${name}`));
        },
      }),
    );

    const rtCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], agActions: ['submit', 'cancel'] },
      },
    });
    const collected = await reg.collect(makeBuildCtx(), rtCtx);
    expect(collected.map((c) => c.tool.name)).toEqual([
      'agui_baseline',
      'agui_submit',
      'agui_cancel',
    ]);
    expect(collected.every((c) => c.pluginName === 'agui')).toBe(true);
  });

  it('skips request-time hooks when rtCtx is not supplied', async () => {
    const reg = new ToolRegistry();
    let requestCalls = 0;
    reg.register(
      makePlugin({
        name: 'agui',
        getTools: () => [makeTool('agui_baseline')],
        getRequestTools: () => {
          requestCalls += 1;
          return [makeTool('agui_dynamic')];
        },
      }),
    );

    const collected = await reg.collect(makeBuildCtx());
    expect(collected.map((c) => c.tool.name)).toEqual(['agui_baseline']);
    expect(requestCalls).toBe(0);
  });

  it('keeps concurrent request collections isolated from each other and from boot introspection', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'agui',
        getTools: () => [makeTool('agui_baseline')],
        getRequestTools: (rtCtx) => {
          const actions =
            (rtCtx.history.state as { agActions?: string[] }).agActions ?? [];
          return actions.map((name) => makeTool(`agui_${name}`));
        },
      }),
    );

    const rtCtxFor = (action: string) =>
      makeRuntimeContext({
        history: {
          messages: [],
          recent: () => [],
          userContext: {},
          state: { messages: [], agActions: [action] },
        },
      });

    // Two "requests" collect back-to-back — as concurrent users would.
    const forUserA = await reg.collect(makeBuildCtx(), rtCtxFor('submit'));
    const forUserB = await reg.collect(makeBuildCtx(), rtCtxFor('cancel'));

    expect(forUserA.map((c) => c.tool.name)).toEqual([
      'agui_baseline',
      'agui_submit',
    ]);
    expect(forUserB.map((c) => c.tool.name)).toEqual([
      'agui_baseline',
      'agui_cancel',
    ]);
    // User B's collection did not mutate user A's returned list...
    expect(forUserA.map((c) => c.tool.name)).not.toContain('agui_cancel');
    // ...and the shared registry exposes boot-time contributions only.
    expect(reg.toolNamesForPlugin('agui')).toEqual(['agui_baseline']);
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

  it('runs request-time hooks concurrently, not one-after-another', async () => {
    const reg = new ToolRegistry();
    const started: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    reg.register(
      makePlugin({
        name: 'slow',
        getRequestTools: async () => {
          started.push('slow');
          await slowGate;
          return [makeTool('slow_tool')];
        },
      }),
    );
    reg.register(
      makePlugin({
        name: 'fast',
        getRequestTools: () => {
          started.push('fast');
          return [makeTool('fast_tool')];
        },
      }),
    );

    const pending = reg.collectRequest(makeRuntimeContext());
    // Both hooks must have started before the slow one resolves — a serial
    // loop would not reach 'fast' until 'slow' finished.
    await Promise.resolve();
    expect(started).toEqual(['slow', 'fast']);

    releaseSlow?.();
    const tools = await pending;
    // Output order stays plugin-registration order even though 'fast'
    // resolved first.
    expect(tools.map((t) => t.tool.name)).toEqual(['slow_tool', 'fast_tool']);
  });

  it('propagates a request-time hook rejection as a collection failure', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'broken',
        getRequestTools: async () => {
          throw new Error('hook exploded');
        },
      }),
    );
    reg.register(
      makePlugin({ name: 'ok', getRequestTools: () => [makeTool('ok_tool')] }),
    );

    await expect(reg.collectRequest(makeRuntimeContext())).rejects.toThrow(
      'hook exploded',
    );
  });
});
