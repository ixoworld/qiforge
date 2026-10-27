import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createUnsignedUcanAdapter,
  type UcanAdapter,
} from '../../core/runtime-context';
import { createRuntimeCore } from '../../core';
import { makeEnv, makeRuntimeContext } from '../../core/test-fixtures';
import type { RuntimeContext } from '../../plugin-api/types';
import {
  clearMemoryToolDefsCache,
  DEFAULT_MEMORY_TOOLS,
  MEMORY_ADD_MCP_NAME,
  MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
  MEMORY_DELETE_EDGE_MCP_NAME,
} from './memory-tools';
import { MemoryPlugin } from './memory.plugin';

const DOCUMENT_TOOL_NAMES = [
  'add_oracle_document',
  'list_oracle_documents',
  'delete_oracle_document',
];

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
/** The oracle's configured domain entity (`ORACLE_ENTITY_DID`). */
const ENTITY_DID = 'did:ixo:entity:0123456789abcdef0123456789abcdef';

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
          ORACLE_ENTITY_DID: ENTITY_DID,
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
      [...DEFAULT_MEMORY_TOOLS, ...DOCUMENT_TOOL_NAMES].sort(),
    );
    // The default surface carries the oracle-knowledge write (the engine
    // gates it on chain) but not `delete_edge`.
    expect(tools.map((t) => t.name)).toContain(
      MEMORY_ADD_ORACLE_KNOWLEDGE_MCP_NAME,
    );
    expect(tools.map((t) => t.name)).not.toContain(MEMORY_DELETE_EDGE_MCP_NAME);
    // Descriptions + schemas pass through from upstream untouched.
    const add = tools.find((t) => t.name === MEMORY_ADD_MCP_NAME);
    expect(add?.description).toBe(`upstream ${MEMORY_ADD_MCP_NAME}`);
    const upstreamAdd = upstreamTools.find(
      (t) => t.name === MEMORY_ADD_MCP_NAME,
    );
    expect(add?.schema).toBe(upstreamAdd?.schema);
  });

  it('sends the two-hop UCAN header set (Bearer + X-Auth-Type + x-oracle-entity-did + x-room-id)', async () => {
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
      'x-oracle-entity-did': ENTITY_DID,
      'x-room-id': '!room:example.org',
    });
    // The defs-listing client is closed once the definitions are snapshotted.
    expect(clientRecords[0]?.closed).toBe(true);
  });

  it('hands a custom factory the configured entity', async () => {
    const seen: Array<[string, string]> = [];
    const plugin = new MemoryPlugin({
      mcpFactory: (url, entityDid) => {
        seen.push([url, entityDid]);
        return async () => [];
      },
    });
    await plugin.getRequestTools(makeCtx());
    expect(seen).toEqual([[MEMORY_URL, ENTITY_DID]]);
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
    // The second argument carries the MCP request timeout; without it the
    // MCP SDK ends the call at its 60 s default.
    expect(upstreamAdd?.invoke).toHaveBeenCalledWith(
      { name: 'fact', content: 'x' },
      { metadata: { timeoutMs: 420_000 } },
    );
    expect(result).toEqual({
      echoed: { name: 'fact', content: 'x' },
      from: MEMORY_ADD_MCP_NAME,
    });
    // The lazy invocation opened its own authenticated client.
    expect(clientRecords.length).toBe(2);
  });

  it('lists the document tools next to the upstream tools, native and ungated', async () => {
    const plugin = new MemoryPlugin();
    const tools = await plugin.getRequestTools(makeCtx());
    for (const name of DOCUMENT_TOOL_NAMES) {
      expect(tools.map((t) => t.name)).toContain(name);
    }
    // The document tools come first, so a file never lands on the upstream
    // add_oracle_knowledge by position; the upstream tools follow.
    expect(
      tools.slice(0, DOCUMENT_TOOL_NAMES.length).map((t) => t.name),
    ).toEqual([...DOCUMENT_TOOL_NAMES]);
    expect(
      tools
        .slice(DOCUMENT_TOOL_NAMES.length)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...DEFAULT_MEMORY_TOOLS].sort());
  });

  it('leaves the document tools out when documentTools is false', async () => {
    const plugin = new MemoryPlugin({ documentTools: false });
    const tools = await plugin.getRequestTools(makeCtx());
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...DEFAULT_MEMORY_TOOLS].sort(),
    );
  });

  it('teaches the grouped-or-loose rule in the manifest', () => {
    const { whenToUse, whenNotToUse } = new MemoryPlugin().manifest;
    const use = whenToUse.join('\n');
    expect(use).toContain('add_oracle_document');
    expect(use).toContain('group_as_document true');
    expect(use).toContain('group_as_document false');
    expect(use).toContain('ask the person first');
    // Tool choice: typed text vs a file.
    expect(use).toContain('TYPES into the chat');
    expect(use).toContain('only for knowledge typed in the chat');
    expect(use).toContain(
      'a file the person attached or a Library file ALWAYS goes to add_oracle_document, never to add_oracle_knowledge, even when its text is visible in the conversation',
    );
    // "a policy" is the typed-in example, not a grouped-document example.
    expect(use).not.toContain('(a board resolution, a contract, a policy');
    expect((whenNotToUse ?? []).join('\n')).toContain(
      'did not ask you to store',
    );
  });

  it('contributes no tools when the service DID cannot be resolved', async () => {
    const plugin = new MemoryPlugin();
    const tools = await plugin.getRequestTools(
      makeCtx({ resolveServiceDid: async () => null }),
    );
    expect(tools).toEqual([]);
    expect(clientRecords.length).toBe(0);
  });

  describe('ORACLE_ENTITY_DID at boot', () => {
    const memoryEnv = (entity: Record<string, unknown>) => {
      const env = makeEnv({
        MEMORY_MCP_URL: MEMORY_URL,
        MEMORY_ENGINE_URL: 'https://engine.example',
        ...entity,
      });
      if (!('ORACLE_ENTITY_DID' in entity)) delete env.ORACLE_ENTITY_DID;
      return env;
    };
    const boot = (env: Record<string, unknown>) =>
      createRuntimeCore({
        config: { name: 'X' },
        plugins: [new MemoryPlugin()],
        env,
      });

    it('refuses to boot a memory oracle without one, naming the variable', () => {
      expect(() => boot(memoryEnv({}))).toThrow(
        /Plugin 'memory' env validation failed for 'ORACLE_ENTITY_DID': ORACLE_ENTITY_DID is required by the memory plugin/,
      );
    });

    it.each([
      [
        'the agent account DID',
        'did:ixo:ixo1seyngesnj6673qqzf0um4e6c2rutfsrafc9tw3',
      ],
      ['a non-hex entity', 'did:ixo:entity:oracle1'],
      ['upper-case hex', 'did:ixo:entity:0123456789ABCDEF0123456789ABCDEF'],
      ['33 hex digits', 'did:ixo:entity:0123456789abcdef0123456789abcdef0'],
    ])('refuses %s as the entity', (_label, bad) => {
      expect(() => boot(memoryEnv({ ORACLE_ENTITY_DID: bad }))).toThrow(
        /Plugin 'memory' env validation failed for 'ORACLE_ENTITY_DID': ORACLE_ENTITY_DID must be the oracle's domain entity DID/,
      );
    });

    it('boots with a well-formed entity', () => {
      const core = boot(memoryEnv({ ORACLE_ENTITY_DID: ENTITY_DID }));
      expect(core.validatedEnv.ORACLE_ENTITY_DID).toBe(ENTITY_DID);
      expect(core.identity.entityDid).toBe(ENTITY_DID);
    });

    it('leaves ORACLE_ENTITY_DID optional when the memory plugin is not loaded', () => {
      const env = makeEnv();
      delete env.ORACLE_ENTITY_DID;
      const core = createRuntimeCore({
        config: { name: 'X' },
        plugins: [],
        env,
      });
      expect(core.identity.entityDid).toBe(env.ORACLE_DID);
    });
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
