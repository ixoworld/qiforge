import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { MemoryPlugin } from './memory.plugin.js';
import {
  MEMORY_ADD_MCP_NAME,
  MEMORY_CLEAR_MCP_NAME,
  MEMORY_DELETE_EPISODE_MCP_NAME,
  MEMORY_SEARCH_MCP_NAME,
  type MemoryMcpFactory,
  type UpstreamMcpTool,
} from './memory-tools.js';

const MEMORY_MCP_URL = 'https://memory.test/mcp';
const MEMORY_ENGINE_URL = 'https://memory.test/api';

function stubFactory(
  tools: UpstreamMcpTool[],
): (url: string) => MemoryMcpFactory {
  return () => async () => tools;
}

function fakeMcpTool(
  name: string,
  invoke: UpstreamMcpTool['invoke'] = async () => ({}),
): UpstreamMcpTool {
  return {
    name,
    description: `upstream ${name}`,
    schema: z.object({}).passthrough(),
    invoke,
  };
}

function ctxWithConfig() {
  return makeRuntimeContext({
    config: { MEMORY_MCP_URL, MEMORY_ENGINE_URL },
  });
}

describe('MemoryPlugin', () => {
  it('has the expected identity, manifest, configSchema, and exposes static NAME', () => {
    const plugin = new MemoryPlugin({ mcpFactory: stubFactory([]) });

    expect(MemoryPlugin.NAME).toBe('memory');
    expect(plugin.name).toBe('memory');
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

  it('getRequestTools surfaces the upstream MCP tools (default selection: search + add + delete-episode)', async () => {
    const upstream: UpstreamMcpTool[] = [
      fakeMcpTool(MEMORY_SEARCH_MCP_NAME),
      fakeMcpTool(MEMORY_ADD_MCP_NAME),
      fakeMcpTool(MEMORY_DELETE_EPISODE_MCP_NAME),
      fakeMcpTool(MEMORY_CLEAR_MCP_NAME),
    ];
    const plugin = new MemoryPlugin({ mcpFactory: stubFactory(upstream) });

    expect(plugin.getSubAgents).toBeUndefined();

    const tools = await plugin.getRequestTools!(ctxWithConfig());
    expect(tools.map((t) => t.name)).toEqual([
      MEMORY_SEARCH_MCP_NAME,
      MEMORY_ADD_MCP_NAME,
      MEMORY_DELETE_EPISODE_MCP_NAME,
    ]);
  });

  it('handlers passthrough to the upstream invoke with the raw args (no schema translation)', async () => {
    const searchInvoke = vi.fn(async () => ({ hits: [{ id: 'mem-1' }] }));
    const addInvoke = vi.fn(async () => ({ id: 'mem-2' }));
    const deleteInvoke = vi.fn(async () => ({ deleted: true }));
    const upstream: UpstreamMcpTool[] = [
      fakeMcpTool(MEMORY_SEARCH_MCP_NAME, searchInvoke),
      fakeMcpTool(MEMORY_ADD_MCP_NAME, addInvoke),
      fakeMcpTool(MEMORY_DELETE_EPISODE_MCP_NAME, deleteInvoke),
    ];
    const factoryFn = vi.fn(stubFactory(upstream));
    const plugin = new MemoryPlugin({ mcpFactory: factoryFn });

    const ctx = ctxWithConfig();
    const tools = await plugin.getRequestTools!(ctx);
    expect(factoryFn).toHaveBeenCalledWith(MEMORY_MCP_URL);

    const search = tools.find((t) => t.name === MEMORY_SEARCH_MCP_NAME)!;
    const save = tools.find((t) => t.name === MEMORY_ADD_MCP_NAME)!;
    const remove = tools.find((t) => t.name === MEMORY_DELETE_EPISODE_MCP_NAME)!;

    const searchResult = await search.handler(
      { query: 'morning routine', limit: 3 },
      ctx,
    );
    expect(searchResult).toEqual({ hits: [{ id: 'mem-1' }] });
    expect(searchInvoke).toHaveBeenCalledWith({
      query: 'morning routine',
      limit: 3,
    });

    await save.handler(
      { episode_body: 'User prefers dark mode.' },
      ctx,
    );
    expect(addInvoke).toHaveBeenCalledWith({
      episode_body: 'User prefers dark mode.',
    });

    await remove.handler({ episode_id: 'mem-9' }, ctx);
    expect(deleteInvoke).toHaveBeenCalledWith({ episode_id: 'mem-9' });
  });

  it('respects an explicit selectedTools list (e.g. include clear)', async () => {
    const upstream: UpstreamMcpTool[] = [
      fakeMcpTool(MEMORY_SEARCH_MCP_NAME),
      fakeMcpTool(MEMORY_CLEAR_MCP_NAME),
    ];
    const plugin = new MemoryPlugin({
      mcpFactory: stubFactory(upstream),
      selectedTools: [MEMORY_SEARCH_MCP_NAME, MEMORY_CLEAR_MCP_NAME],
    });

    const tools = await plugin.getRequestTools!(ctxWithConfig());
    expect(tools.map((t) => t.name)).toEqual([
      MEMORY_SEARCH_MCP_NAME,
      MEMORY_CLEAR_MCP_NAME,
    ]);
  });

  it('returns an empty tool list when the factory cannot mint auth', async () => {
    const plugin = new MemoryPlugin({
      mcpFactory: () => async () => null,
    });
    const tools = await plugin.getRequestTools!(ctxWithConfig());
    expect(tools).toEqual([]);
  });

  it('uses runtime.ucan.resolveServiceDid + mintInvocation for memory auth (no inline did:web)', async () => {
    const resolveServiceDid = vi.fn(async () => 'did:web:memory.test');
    const mintInvocation = vi.fn(async () => 'inv-token');

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

    const profile = accessors.userProfile!(
      { userContext: { identity: { name: 'Yousef' } } },
      makeRuntimeContext(),
    );
    expect(profile).toEqual({ identity: { name: 'Yousef' } });

    await rt.close();
  });

  it('boots through createTestRuntime with visibility=always and registers no eager tools (tools come per-request)', async () => {
    const rt = await createTestRuntime({
      plugins: [new MemoryPlugin({ mcpFactory: stubFactory([]) })],
      config: { MEMORY_MCP_URL, MEMORY_ENGINE_URL },
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();

    const listing = rt.listCapabilities().find((c) => c.name === 'memory');
    expect(listing?.visibility).toBe('always');
    expect(listing?.loaded).toBe(true);

    // Tools are sourced from `getRequestTools` per request, so the boot-time
    // tool listing is empty for the memory plugin.
    expect(rt.listTools('memory')).toEqual([]);

    await rt.close();
  });
});
