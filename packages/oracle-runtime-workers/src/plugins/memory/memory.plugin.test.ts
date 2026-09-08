import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  clearMemoryToolDefsCache,
  DEFAULT_MEMORY_TOOLS,
  MEMORY_ADD_MCP_NAME,
} from './memory-tools';
import { MemoryPlugin } from './memory.plugin';

interface FakeUpstreamTool {
  name: string;
  description: string;
  schema: z.ZodType;
  invoke: (input: unknown) => Promise<unknown>;
}

/** Constructor configs + instances of the mocked MCP client. */
const clientRecords: Array<{ config: unknown; closed: boolean }> = [];
let upstreamTools: FakeUpstreamTool[] = [];

vi.mock('@langchain/mcp-adapters', () => {
  class MultiServerMCPClient {
    readonly config: unknown;
    closed = false;
    constructor(config: unknown) {
      this.config = config;
      clientRecords.push(this);
    }
    async getTools(): Promise<FakeUpstreamTool[]> {
      return upstreamTools;
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  return { MultiServerMCPClient };
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function serverConfigOf(
  config: unknown,
  server: string,
): Record<string, unknown> {
  if (!isRecord(config) || !isRecord(config.mcpServers)) {
    throw new Error('mock client received a malformed config');
  }
  const entry = config.mcpServers[server];
  if (!isRecord(entry)) throw new Error(`no server entry for "${server}"`);
  return entry;
}

const MEMORY_URL = 'https://memory.example/mcp';

function makeCtx(overrides: Partial<UcanAdapter> = {}): RuntimeContext {
  const ucan: UcanAdapter = {
    ...createUnsignedUcanAdapter(),
    hasSigningKey: () => true,
    resolveServiceDid: async () => 'did:web:memory.example',
    mintInvocation: async () => 'mem-token',
    ...overrides,
  };
  return makeRuntimeContext(
    {},
    {
      ambient: {
        ucan,
        config: {
          MEMORY_MCP_URL: MEMORY_URL,
          MEMORY_ENGINE_URL: 'https://engine.example',
        },
      },
      runConfig: {
        context: {
          user: {
            did: 'did:ixo:user1',
            matrixUserId: '@did-ixo-user1:ixo.world',
            ucanDelegation: { raw: 'delegation' },
          },
          session: {
            id: 'session-1',
            client: 'matrix',
            requestId: 'req-1',
            roomId: '!room:example.org',
          },
        },
      },
    },
  );
}

function fakeTool(name: string): FakeUpstreamTool {
  return {
    name,
    description: `upstream ${name}`,
    schema: z.object({ q: z.string().optional() }),
    invoke: vi.fn(async (input: unknown) => ({ echoed: input, from: name })),
  };
}

describe('MemoryPlugin (Workers port)', () => {
  beforeEach(() => {
    clearMemoryToolDefsCache();
    clientRecords.length = 0;
    upstreamTools = [
      fakeTool('memory-engine__search_memory_engine'),
      fakeTool('memory-engine__add_memory'),
      fakeTool('memory-engine__delete_episode'),
      fakeTool('memory-engine__delete_edge'),
      fakeTool('memory-engine__clear'),
      fakeTool('memory-engine__add_oracle_knowledge'),
    ];
  });

  it('autoDetects on MEMORY_MCP_URL', () => {
    const plugin = new MemoryPlugin();
    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetect({ MEMORY_MCP_URL: MEMORY_URL })).toBe(true);
    // A non-string binding must not count.
    expect(plugin.autoDetect({ MEMORY_MCP_URL: { some: 'binding' } })).toBe(
      false,
    );
  });

  it('registers the default upstream tool selection verbatim', async () => {
    const plugin = new MemoryPlugin();
    const tools = await plugin.getRequestTools(makeCtx());

    expect(tools.map((t) => t.name).sort()).toEqual(
      [...DEFAULT_MEMORY_TOOLS].sort(),
    );
    // Descriptions + schemas pass through from upstream untouched.
    const add = tools.find((t) => t.name === MEMORY_ADD_MCP_NAME);
    expect(add?.description).toBe(`upstream ${MEMORY_ADD_MCP_NAME}`);
    const upstreamAdd = upstreamTools.find(
      (t) => t.name === MEMORY_ADD_MCP_NAME,
    );
    expect(add?.schema).toBe(upstreamAdd?.schema);
  });

  it('sends the two-hop UCAN header set (Bearer + X-Auth-Type + x-room-id)', async () => {
    const plugin = new MemoryPlugin();
    await plugin.getRequestTools(makeCtx());

    expect(clientRecords.length).toBe(1);
    const server = serverConfigOf(clientRecords[0]?.config, 'memory-engine');
    expect(server.url).toBe(MEMORY_URL);
    expect(server.transport).toBe('http');
    expect(server.headers).toEqual({
      Authorization: 'Bearer mem-token',
      'X-Auth-Type': 'ucan',
      'User-Agent': 'LangChain-MCP-Client/1.0',
      'x-room-id': '!room:example.org',
    });
    // The defs-listing client is closed once the definitions are snapshotted.
    expect(clientRecords[0]?.closed).toBe(true);
  });

  it('proxies a happy-path call to the upstream tool', async () => {
    const plugin = new MemoryPlugin();
    const ctx = makeCtx();
    const tools = await plugin.getRequestTools(ctx);
    const add = tools.find((t) => t.name === MEMORY_ADD_MCP_NAME);

    const result = await add?.handler({ name: 'fact', content: 'x' }, ctx);

    const upstreamAdd = upstreamTools.find(
      (t) => t.name === MEMORY_ADD_MCP_NAME,
    );
    expect(upstreamAdd?.invoke).toHaveBeenCalledWith({
      name: 'fact',
      content: 'x',
    });
    expect(result).toEqual({
      echoed: { name: 'fact', content: 'x' },
      from: MEMORY_ADD_MCP_NAME,
    });
    // The lazy invocation opened its own authenticated client.
    expect(clientRecords.length).toBe(2);
  });

  it('contributes no tools when the service DID cannot be resolved', async () => {
    const plugin = new MemoryPlugin();
    const tools = await plugin.getRequestTools(
      makeCtx({ resolveServiceDid: async () => null }),
    );
    expect(tools).toEqual([]);
    expect(clientRecords.length).toBe(0);
  });

  it('exposes userProfile shared state backed by state.userContext', () => {
    const plugin = new MemoryPlugin();
    const accessors = plugin.getSharedState();
    const profile = accessors.userProfile?.(
      { userContext: { name: 'Ada' } },
      makeCtx(),
    );
    expect(profile).toEqual({ name: 'Ada' });
  });
});
