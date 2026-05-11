import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import type { PluginContext, PluginTool } from '../../plugin-api/types.js';
import {
  makeBuildCtx,
  makeRuntimeContext,
} from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { MemoryPlugin } from './memory.plugin.js';
import {
  MEMORY_ADD_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
  MEMORY_CLEAR_TOOL,
  MEMORY_DELETE_MCP_NAME,
  MEMORY_DELETE_TOOL,
  MEMORY_READ_TOOL,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_MCP_NAME,
  MEMORY_SEARCH_TOOL,
  type MemoryMcpFactory,
  type MemoryMcpProxyTool,
} from './memory-tools.js';

const MEMORY_MCP_URL = 'https://memory.test/mcp';
const MEMORY_ENGINE_URL = 'https://memory.test/api';

function stubFactory(
  tools: MemoryMcpProxyTool[],
): (url: string) => MemoryMcpFactory {
  return () => async () => tools;
}

function ctxWithConfig(): PluginContext {
  return makeBuildCtx({
    config: {
      MEMORY_MCP_URL,
      MEMORY_ENGINE_URL,
    },
  });
}

async function getToolsOf(plugin: MemoryPlugin): Promise<PluginTool[]> {
  const result = await plugin.getTools(ctxWithConfig());
  return result;
}

describe('MemoryPlugin', () => {
  it('has the expected identity, manifest, configSchema, and exposes static NAME', () => {
    const plugin = new MemoryPlugin({ mcpFactory: stubFactory([]) });

    expect(MemoryPlugin.NAME).toBe('memory');
    expect(plugin.name).toBe('memory');
    expect(plugin.name).toBe(MemoryPlugin.NAME);
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Memory');
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('memory');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('declares MEMORY_MCP_URL and MEMORY_ENGINE_URL in its configSchema', () => {
    const plugin = new MemoryPlugin({ mcpFactory: stubFactory([]) });
    expect(plugin.configSchema).toBeDefined();
    expect(plugin.configSchema!.safeParse({}).success).toBe(false);
    expect(
      plugin.configSchema!.safeParse({ MEMORY_MCP_URL }).success,
    ).toBe(false);
    expect(
      plugin.configSchema!.safeParse({
        MEMORY_MCP_URL: 'not-a-url',
        MEMORY_ENGINE_URL,
      }).success,
    ).toBe(false);
    expect(
      plugin.configSchema!.safeParse({
        MEMORY_MCP_URL,
        MEMORY_ENGINE_URL,
      }).success,
    ).toBe(true);
  });

  it('getTools returns all five tools including clear_memory and exposes no sub-agent', async () => {
    const plugin = new MemoryPlugin({ mcpFactory: stubFactory([]) });

    expect(plugin.getSubAgents).toBeUndefined();

    const tools = await getToolsOf(plugin);
    expect(tools.map((t) => t.name)).toEqual([
      MEMORY_SEARCH_TOOL,
      MEMORY_SAVE_TOOL,
      MEMORY_READ_TOOL,
      MEMORY_DELETE_TOOL,
      MEMORY_CLEAR_TOOL,
    ]);
  });

  it('proxies tool invocations through the injected MCP factory', async () => {
    const searchInvoke = vi.fn(async () => ({ hits: [{ id: 'mem-1' }] }));
    const addInvoke = vi.fn(async () => ({ id: 'mem-2' }));
    const deleteInvoke = vi.fn(async () => ({ deleted: true }));
    const clearInvoke = vi.fn(async () => ({ cleared: true }));
    const mcpTools: MemoryMcpProxyTool[] = [
      { name: MEMORY_SEARCH_MCP_NAME, invoke: searchInvoke },
      { name: MEMORY_ADD_MCP_NAME, invoke: addInvoke },
      { name: MEMORY_DELETE_MCP_NAME, invoke: deleteInvoke },
      { name: MEMORY_CLEAR_MCP_NAME, invoke: clearInvoke },
    ];
    const factoryFn = vi.fn(stubFactory(mcpTools));
    const plugin = new MemoryPlugin({ mcpFactory: factoryFn });

    const tools = await getToolsOf(plugin);
    const search = tools.find((t) => t.name === MEMORY_SEARCH_TOOL)!;
    const save = tools.find((t) => t.name === MEMORY_SAVE_TOOL)!;
    const remove = tools.find((t) => t.name === MEMORY_DELETE_TOOL)!;
    const clear = tools.find((t) => t.name === MEMORY_CLEAR_TOOL)!;

    expect(factoryFn).toHaveBeenCalledWith(MEMORY_MCP_URL);

    const searchResult = await search.handler(
      { query: 'morning routine', limit: 3 },
      makeRuntimeContext(),
    );
    expect(searchResult).toEqual({ hits: [{ id: 'mem-1' }] });
    expect(searchInvoke).toHaveBeenCalledWith({
      query: 'morning routine',
      limit: 3,
    });

    await save.handler(
      { content: 'User prefers dark mode.' },
      makeRuntimeContext(),
    );
    expect(addInvoke).toHaveBeenCalledWith({
      content: 'User prefers dark mode.',
    });

    await remove.handler({ memory_id: 'mem-9' }, makeRuntimeContext());
    expect(deleteInvoke).toHaveBeenCalledWith({ episode_id: 'mem-9' });

    await clear.handler({ confirm: true }, makeRuntimeContext());
    expect(clearInvoke).toHaveBeenCalledWith({});

    await expect(
      search.handler({ query: '' }, makeRuntimeContext()),
    ).rejects.toThrow();
    await expect(
      clear.handler({ confirm: false }, makeRuntimeContext()),
    ).rejects.toThrow();
  });

  it('uses runtime.ucan.resolveServiceDid + mintInvocation for memory auth (no inline did:web)', async () => {
    // Drive the *default* factory path so we exercise buildMemoryHeaders.
    // We never reach the MCP HTTP call because the factory short-circuits to
    // null when no DID is resolved, but we can still observe the UCAN calls.
    const resolveServiceDid = vi.fn(async () => 'did:web:memory.test');
    const mintInvocation = vi.fn(async () => 'inv-token');

    // Build a memory plugin without overriding the mcpFactory so the default
    // implementation runs. We can't easily intercept the MCP client itself
    // here, so we stub `MultiServerMCPClient` at module level via a wrapped
    // factory that calls buildMemoryHeaders explicitly.
    const { buildMemoryHeaders } = await import('./memory-ucan.js');
    const ctx = makeRuntimeContext({
      ucan: {
        requireCapability: () => undefined,
        hasCapability: () => true,
        mintInvocation,
        resolveServiceDid,
      },
      session: {
        id: 'sess-1',
        client: 'matrix',
        requestId: 'req-1',
        roomId: '!room:ixo.world',
      },
    });

    const headers = await buildMemoryHeaders(ctx, MEMORY_MCP_URL);
    expect(resolveServiceDid).toHaveBeenCalledWith(MEMORY_MCP_URL);
    expect(mintInvocation).toHaveBeenCalledWith({
      did: 'did:web:memory.test',
      capability: 'ixo:memory',
    });
    expect(headers).toEqual({
      Authorization: 'Bearer inv-token',
      'X-Auth-Type': 'ucan',
      'User-Agent': 'LangChain-MCP-Client/1.0',
      'x-room-id': '!room:ixo.world',
    });
  });

  it('middleware preloads userContext on the first model call and skips when already populated', async () => {
    const stored = { identity: { name: 'Yousef' } };
    const get = vi.fn(async () => stored);

    const rt = await createTestRuntime({
      plugins: [
        new MemoryPlugin({
          mcpFactory: stubFactory([]),
          userContextReader: { get },
        }),
      ],
      config: { MEMORY_MCP_URL, MEMORY_ENGINE_URL },
    });

    const loaded = await rt.invokeMiddleware(
      'MemoryMiddleware',
      {},
      { context: { session: { roomId: '!room:ixo' } } },
    );
    expect(get).toHaveBeenCalledWith('!room:ixo');
    expect(loaded.before).toEqual({ userContext: stored });

    const alreadyPopulated = await rt.invokeMiddleware(
      'MemoryMiddleware',
      { userContext: { identity: { name: 'Pre-hydrated' } } },
      { context: { session: { roomId: '!room:ixo' } } },
    );
    // Only the first call should have triggered the reader.
    expect(get).toHaveBeenCalledTimes(1);
    expect(alreadyPopulated.before).toBeUndefined();

    const noRoom = await rt.invokeMiddleware(
      'MemoryMiddleware',
      {},
      { context: {} },
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(noRoom.before).toBeUndefined();

    await rt.close();
  });

  it('exposes a `userProfile` shared-state accessor that reads from state.userContext', async () => {
    const plugin = new MemoryPlugin({ mcpFactory: stubFactory([]) });
    const accessors = plugin.getSharedState();
    expect(Object.keys(accessors)).toEqual(['userProfile']);

    const rt = await createTestRuntime({
      plugins: [plugin],
      config: { MEMORY_MCP_URL, MEMORY_ENGINE_URL },
      state: { userContext: { identity: { name: 'Yousef' } } },
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();

    // The accessor is the reader the registry will use to build
    // `ctx.shared.userProfile`. Invoking it directly with a state shape that
    // includes `userContext` returns it unchanged.
    const profile = accessors.userProfile!(
      { userContext: { identity: { name: 'Yousef' } } },
      makeRuntimeContext(),
    );
    expect(profile).toEqual({ identity: { name: 'Yousef' } });

    await rt.close();
  });

  it('boots through createTestRuntime with visibility=always and registers all five tools (no sub-agent)', async () => {
    const rt = await createTestRuntime({
      plugins: [new MemoryPlugin({ mcpFactory: stubFactory([]) })],
      config: { MEMORY_MCP_URL, MEMORY_ENGINE_URL },
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();

    const listing = rt.listCapabilities().find((c) => c.name === 'memory');
    expect(listing?.visibility).toBe('always');
    expect(listing?.loaded).toBe(true);

    const toolNames = rt.listTools('memory').map((t) => t.name);
    expect(toolNames).toEqual([
      MEMORY_SEARCH_TOOL,
      MEMORY_SAVE_TOOL,
      MEMORY_READ_TOOL,
      MEMORY_DELETE_TOOL,
      MEMORY_CLEAR_TOOL,
    ]);

    await rt.close();
  });
});
