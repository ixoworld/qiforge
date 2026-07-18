import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import {
  clearMemoryToolDefsCache,
  createDefaultMemoryMcpFactory,
  MEMORY_ADD_MCP_NAME,
  MEMORY_SEARCH_MCP_NAME,
} from './memory-tools.js';

const getToolsSpy = vi.hoisted(() => vi.fn());
const clientCtorSpy = vi.hoisted(() => vi.fn());

vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    constructor(config: unknown) {
      clientCtorSpy(config);
    }
    getTools() {
      return getToolsSpy();
    }
  },
}));

const MEMORY_MCP_URL = 'https://memory.test/mcp';

function upstreamTool(name: string, invoke = vi.fn(async () => ({ ok: true }))) {
  return {
    name,
    description: `upstream ${name}`,
    schema: z.object({}).passthrough(),
    invoke,
  };
}

function ctx() {
  return makeRuntimeContext({
    config: {
      MEMORY_MCP_URL,
      MEMORY_ENGINE_URL: 'https://memory.test/api',
    },
  });
}

describe('createDefaultMemoryMcpFactory tool-definition cache', () => {
  beforeEach(() => {
    clearMemoryToolDefsCache();
    getToolsSpy.mockReset();
    clientCtorSpy.mockReset();
  });

  it('lists tools over MCP on the first request and serves later requests from the cache', async () => {
    getToolsSpy.mockResolvedValue([
      upstreamTool(MEMORY_SEARCH_MCP_NAME),
      upstreamTool(MEMORY_ADD_MCP_NAME),
    ]);

    const cold = await createDefaultMemoryMcpFactory(MEMORY_MCP_URL)(ctx());
    expect(cold?.map((t) => t.name)).toEqual([
      MEMORY_SEARCH_MCP_NAME,
      MEMORY_ADD_MCP_NAME,
    ]);
    expect(clientCtorSpy).toHaveBeenCalledTimes(1);
    expect(getToolsSpy).toHaveBeenCalledTimes(1);

    const warm = await createDefaultMemoryMcpFactory(MEMORY_MCP_URL)(ctx());
    expect(warm?.map((t) => t.name)).toEqual([
      MEMORY_SEARCH_MCP_NAME,
      MEMORY_ADD_MCP_NAME,
    ]);
    // Warm path binds cached definitions without opening a client.
    expect(clientCtorSpy).toHaveBeenCalledTimes(1);
    expect(getToolsSpy).toHaveBeenCalledTimes(1);
  });

  it('warm-path tools connect lazily on first invoke and share one client per request', async () => {
    const searchInvoke = vi.fn(async () => ({ hits: [] }));
    const addInvoke = vi.fn(async () => ({ id: 'mem-1' }));
    getToolsSpy.mockResolvedValue([
      upstreamTool(MEMORY_SEARCH_MCP_NAME, searchInvoke),
      upstreamTool(MEMORY_ADD_MCP_NAME, addInvoke),
    ]);

    await createDefaultMemoryMcpFactory(MEMORY_MCP_URL)(ctx());
    const warm = await createDefaultMemoryMcpFactory(MEMORY_MCP_URL)(ctx());
    expect(clientCtorSpy).toHaveBeenCalledTimes(1);

    const search = warm?.find((t) => t.name === MEMORY_SEARCH_MCP_NAME);
    const add = warm?.find((t) => t.name === MEMORY_ADD_MCP_NAME);
    await search?.invoke({ query: 'q' });
    await add?.invoke({ fact: 'f' });

    // One additional client serves BOTH invocations of this request.
    expect(clientCtorSpy).toHaveBeenCalledTimes(2);
    expect(searchInvoke).toHaveBeenCalledWith({ query: 'q' });
    expect(addInvoke).toHaveBeenCalledWith({ fact: 'f' });
  });

  it('still gates on per-request auth: no headers → null, and nothing is cached from that request', async () => {
    getToolsSpy.mockResolvedValue([upstreamTool(MEMORY_SEARCH_MCP_NAME)]);
    const unauthorizedCtx = makeRuntimeContext({
      config: {
        MEMORY_MCP_URL,
        MEMORY_ENGINE_URL: 'https://memory.test/api',
      },
      ucan: {
        hasCapability: () => true,
        requireCapability: () => undefined,
        mintInvocation: async () => 'invocation-cid',
        // did:web resolution failing means no headers can be built.
        resolveServiceDid: async () => null,
        hasSigningKey: () => true,
        createInvocationFromDelegation: async () => ({
          invocation: 'invocation-car',
        }),
        mintSelfSignedInvocation: async () => ({
          invocation: 'invocation-car',
        }),
        getServiceDelegation: async () => ({ error: 'no-delegation' as const }),
      },
    });

    const denied =
      await createDefaultMemoryMcpFactory(MEMORY_MCP_URL)(unauthorizedCtx);
    expect(denied).toBeNull();
    expect(clientCtorSpy).not.toHaveBeenCalled();
  });

  it('a failed lazy connect does not poison later invocations', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    getToolsSpy.mockResolvedValue([upstreamTool(MEMORY_SEARCH_MCP_NAME, invoke)]);

    await createDefaultMemoryMcpFactory(MEMORY_MCP_URL)(ctx());
    const warm = await createDefaultMemoryMcpFactory(MEMORY_MCP_URL)(ctx());
    const search = warm?.find((t) => t.name === MEMORY_SEARCH_MCP_NAME);

    getToolsSpy.mockRejectedValueOnce(new Error('connect refused'));
    await expect(search?.invoke({ query: 'q' })).rejects.toThrow(
      'connect refused',
    );

    // Second attempt reconnects instead of replaying the cached rejection.
    await expect(search?.invoke({ query: 'q' })).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
