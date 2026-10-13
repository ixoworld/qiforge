import { describe, expect, it, vi } from 'vitest';
import {
  ManifestRegistry,
  MiddlewareRegistry,
  SharedStateRegistry,
  SubAgentRegistry,
  ToolRegistry,
  createRegistries,
  dropShadowingRequestEntries,
} from './registries';
import {
  makeBuildCtx,
  makeManifest,
  makeMiddleware,
  makePlugin,
  makeRuntimeContext,
  makeSubAgent,
  makeTool,
} from './test-fixtures';

describe('ToolRegistry', () => {
  it('collects boot tools in registration order, cached across calls', async () => {
    let bootCalls = 0;
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getTools: () => {
          bootCalls += 1;
          return [makeTool('store_memory'), makeTool('search_memory')];
        },
      }),
    );
    reg.register(
      makePlugin({ name: 'portal', getTools: () => [makeTool('open_url')] }),
    );

    const first = await reg.collect(makeBuildCtx());
    const second = await reg.collect(makeBuildCtx());
    expect(
      first.map((c) => `${c.pluginName}:${c.tool.name}:${c.origin}`),
    ).toEqual([
      'memory:store_memory:boot',
      'memory:search_memory:boot',
      'portal:open_url:boot',
    ]);
    expect(second).toEqual(first);
    expect(bootCalls).toBe(1);
    expect(reg.toolNamesForPlugin('memory')).toEqual([
      'store_memory',
      'search_memory',
    ]);
    expect(reg.toolNames()).toHaveLength(3);
  });

  it('throws on a cross-plugin tool name collision naming both plugins', async () => {
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({ name: 'slack', getTools: () => [makeTool('send_message')] }),
    );
    reg.register(
      makePlugin({
        name: 'matrix',
        getTools: () => [makeTool('send_message')],
      }),
    );
    await reg.collect(makeBuildCtx());
    expect(() => reg.assertNoCollisions()).toThrow(
      /Tool "send_message" registered by both "slack" and "matrix"/,
    );
  });

  it('throws when asserting before any collection', () => {
    expect(() => new ToolRegistry().assertNoCollisions()).toThrow(
      /before collect/,
    );
  });

  it('runs request hooks concurrently, keeps registration order, isolates failures', async () => {
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
        name: 'broken',
        getRequestTools: async () => {
          started.push('broken');
          throw new Error('hook exploded');
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

    const error = vi.fn();
    const rtCtx = makeRuntimeContext({
      logger: { log: vi.fn(), warn: vi.fn(), error, debug: vi.fn() },
    });
    const pending = reg.collectRequest(rtCtx);
    await Promise.resolve();
    expect(started).toEqual(['slow', 'broken', 'fast']);

    releaseSlow?.();
    const tools = await pending;
    expect(tools.map((t) => `${t.tool.name}:${t.origin}`)).toEqual([
      'slow_tool:request',
      'fast_tool:request',
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('"broken"');
    expect(String(error.mock.calls[0]?.[0])).toContain('hook exploded');
  });

  it('merges boot + request tools and skips request hooks without rtCtx', async () => {
    let requestCalls = 0;
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'agui',
        getTools: () => [makeTool('agui_baseline')],
        getRequestTools: (rtCtx) => {
          requestCalls += 1;
          const actions =
            (rtCtx.history.state as { agActions?: string[] }).agActions ?? [];
          return actions.map((name) => makeTool(`agui_${name}`));
        },
      }),
    );

    expect((await reg.collect(makeBuildCtx())).map((c) => c.tool.name)).toEqual(
      ['agui_baseline'],
    );
    expect(requestCalls).toBe(0);

    const rtCtx = makeRuntimeContext(
      {},
      { state: { messages: [], agActions: ['submit', 'cancel'] } },
    );
    expect(
      (await reg.collect(makeBuildCtx(), rtCtx)).map((c) => c.tool.name),
    ).toEqual(['agui_baseline', 'agui_submit', 'agui_cancel']);
    expect(requestCalls).toBe(1);
  });

  const warningLogger = () => {
    const warn = vi.fn();
    return {
      warn,
      rtCtx: makeRuntimeContext({
        logger: { log: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      }),
    };
  };

  it('drops a request-time tool that shadows a server tool, with one warning, and the turn goes on', async () => {
    // A client-declared browser tool must not take the name of a server
    // tool (the model would call one while the runtime ran the other), and a
    // client release that declares one must not break every turn either.
    const reg = new ToolRegistry();
    const serverTool = makeTool('mutate_topic');
    reg.register(makePlugin({ name: 'topics', getTools: () => [serverTool] }));
    reg.register(
      makePlugin({
        name: 'portal',
        getRequestTools: () => [makeTool('mutate_topic'), makeTool('open_url')],
      }),
    );
    const { warn, rtCtx } = warningLogger();
    const tools = await reg.collect(makeBuildCtx(), rtCtx);
    expect(tools.map((t) => `${t.pluginName}:${t.tool.name}`)).toEqual([
      'topics:mutate_topic',
      'portal:open_url',
    ]);
    expect(tools[0]?.tool).toBe(serverTool);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /request tool "mutate_topic" of plugin "portal" dropped .* plugin "topics"/,
    );
    // The shared registry keeps the boot-time names only; the turn's request
    // tools belong to that turn (one isolate serves every user).
    expect(reg.toolNames()).toEqual(['mutate_topic']);
  });

  it('reserves runtime-bound names against boot-time tools as well', async () => {
    // The domain-context tools exist only on observe turns, so no boot check
    // sees them: a plugin tool of the same name is dropped for the turn
    // rather than bound twice, whichever hook contributed it.
    const reg = new ToolRegistry();
    reg.register(
      makePlugin({
        name: 'docs',
        getTools: () => [
          makeTool('read_domain_document'),
          makeTool('search_docs'),
        ],
      }),
    );
    reg.register(
      makePlugin({
        name: 'portal',
        getRequestTools: () => [makeTool('refresh_domain_context')],
      }),
    );
    const { warn, rtCtx } = warningLogger();
    const collected = await reg.collect(makeBuildCtx(), rtCtx);
    const { tools } = dropShadowingRequestEntries({
      tools: collected,
      requestSubAgents: [],
      reservedNames: ['search_docs'],
      runtimeNames: ['read_domain_document', 'refresh_domain_context'],
      logger: { warn },
    });
    expect(tools.map((t) => `${t.pluginName}:${t.tool.name}`)).toEqual([
      'docs:search_docs',
    ]);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining(
        'plugin "docs" tool "read_domain_document" dropped for this turn',
      ),
      expect.stringContaining(
        'plugin "portal" request-time tool "refresh_domain_context" dropped',
      ),
    ]);
    // Without runtime names a boot-time tool is never dropped.
    expect(
      dropShadowingRequestEntries({
        tools: collected,
        requestSubAgents: [],
        reservedNames: ['read_domain_document', 'search_docs'],
        logger: { warn },
      }).tools.map((t) => t.tool.name),
    ).toEqual([
      'read_domain_document',
      'search_docs',
      'refresh_domain_context',
    ]);
  });

  it('keeps the first of two request-time tools with one name and warns once', async () => {
    const reg = new ToolRegistry();
    const first = makeTool('open_url');
    reg.register(
      makePlugin({
        name: 'portal',
        getRequestTools: () => [first, makeTool('open_url')],
      }),
    );
    const { warn, rtCtx } = warningLogger();
    const tools = await reg.collect(makeBuildCtx(), rtCtx);
    expect(tools.map((t) => t.tool)).toEqual([first]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'request tool "open_url" of plugin "portal" dropped',
    );
  });
});

describe('SubAgentRegistry', () => {
  it('collects, exposes wrapped names per plugin and detects collisions', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('Memory Agent')],
      }),
    );
    reg.register(
      makePlugin({
        name: 'memory-experimental',
        getSubAgents: () => [makeSubAgent('Memory Agent')],
      }),
    );
    await reg.collect(makeBuildCtx());
    expect(reg.subAgentNamesForPlugin('memory')).toEqual(['call_memory_agent']);
    expect(() => reg.assertNoCollisions()).toThrow(
      /"Memory Agent" registered by both "memory" and "memory-experimental"/,
    );
  });

  it('isolates a failing getRequestSubAgents hook to its plugin', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'broken',
        getRequestSubAgents: async () => {
          throw new Error('nope');
        },
      }),
    );
    reg.register(
      makePlugin({
        name: 'ok',
        getRequestSubAgents: () => [makeSubAgent('ok_agent')],
      }),
    );
    const error = vi.fn();
    const rtCtx = makeRuntimeContext({
      logger: { log: vi.fn(), warn: vi.fn(), error },
    });
    const collected = await reg.collect(makeBuildCtx(), rtCtx);
    expect(collected.map((c) => c.subAgent.name)).toEqual(['ok_agent']);
    expect(String(error.mock.calls[0]?.[0])).toContain('"broken"');
  });
});

describe('MiddlewareRegistry', () => {
  it('collects in registration order and forwards the build context', () => {
    const m1 = makeMiddleware('m1');
    const m2 = makeMiddleware('m2');
    let seenConfig: unknown;
    const reg = new MiddlewareRegistry();
    reg.register(
      makePlugin({
        name: 'first',
        getMiddlewares: (ctx) => {
          seenConfig = ctx.config;
          return [m1];
        },
      }),
    );
    reg.register(makePlugin({ name: 'second', getMiddlewares: () => [m2] }));
    const collected = reg.collect(makeBuildCtx({ config: { OBSERVED: true } }));
    expect(collected.map((c) => c.middleware)).toEqual([m1, m2]);
    expect(seenConfig).toEqual({ OBSERVED: true });
  });
});

describe('ManifestRegistry', () => {
  it('applies fork overrides and cross-checks example tools per plugin', async () => {
    const tools = new ToolRegistry();
    const subAgents = new SubAgentRegistry();
    const climate = makePlugin({
      name: 'climate',
      manifest: makeManifest({
        title: 'Climate',
        visibility: 'always',
        examples: [
          { user: 'q1', tool: 'get_emissions' },
          { user: 'q2', tool: 'call_climate_agent' },
          { user: 'q3', tool: 'open_url' },
        ],
      }),
      getTools: () => [makeTool('get_emissions')],
      getSubAgents: () => [makeSubAgent('Climate Agent')],
    });
    const portal = makePlugin({
      name: 'portal',
      getTools: () => [makeTool('open_url')],
    });
    for (const p of [climate, portal]) {
      tools.register(p);
      subAgents.register(p);
    }
    await tools.collect(makeBuildCtx());
    await subAgents.collect(makeBuildCtx());

    const manifests = new ManifestRegistry();
    manifests.register(climate, { visibility: 'on-demand' });
    manifests.register(portal);

    expect(manifests.collect()[0]?.manifest.visibility).toBe('on-demand');
    expect(manifests.collect()[0]?.manifest.title).toBe('Climate');

    const cross = manifests.validateAgainstTools(tools, subAgents);
    // Own tool and own sub-agent (wrapped name) resolve; another plugin's
    // tool does not.
    expect(cross.errors).toHaveLength(1);
    expect(cross.errors[0]).toContain('[climate] examples[2].tool');
    expect(cross.errors[0]).toContain('open_url');
  });
});

describe('SharedStateRegistry', () => {
  it('builds lazy accessors over state + runtime context and detects key collisions', () => {
    const reg = new SharedStateRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSharedState: () => ({
          userProfile: (state: { userContext?: unknown }) => state.userContext,
          sessionId: (_state, runCtx) => runCtx.session.id,
          boom: () => {
            throw new Error('accessor failed');
          },
        }),
      }),
    );
    const runCtx = makeRuntimeContext();
    const accessors = reg.build({ userContext: { name: 'Alice' } }, runCtx);
    expect(accessors.userProfile).toEqual({ name: 'Alice' });
    expect(accessors.sessionId).toBe('session-1');
    // A throwing accessor only affects its own key.
    expect(() => accessors.boom).toThrow('accessor failed');
    expect(accessors.sessionId).toBe('session-1');

    reg.register(
      makePlugin({
        name: 'cache',
        getSharedState: () => ({ userProfile: () => ({ source: 'cache' }) }),
      }),
    );
    expect(() => reg.assertNoCollisions()).toThrow(
      /"userProfile" registered by both "memory" and "cache"/,
    );
  });
});

describe('createRegistries', () => {
  it('returns independent instances per call', () => {
    const a = createRegistries();
    const b = createRegistries();
    expect(a.tools).not.toBe(b.tools);
    expect(a.manifests).not.toBe(b.manifests);
  });
});
