import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBuildCtx, makeRuntimeContext } from '../../core/test-fixtures';
import { FirecrawlPlugin } from './firecrawl.plugin';
import {
  FIRECRAWL_SCRAPE_MCP_NAME,
  FIRECRAWL_SEARCH_MCP_NAME,
} from './firecrawl-tools';

interface FakeUpstreamTool {
  name: string;
  invoke: (input: unknown) => Promise<unknown>;
}

const clientRecords: Array<{ config: unknown }> = [];
let upstreamTools: FakeUpstreamTool[] = [];

vi.mock('@langchain/mcp-adapters', () => {
  class MultiServerMCPClient {
    readonly config: unknown;
    constructor(config: unknown) {
      this.config = config;
      clientRecords.push(this);
    }
    async getTools(): Promise<FakeUpstreamTool[]> {
      return upstreamTools;
    }
    async close(): Promise<void> {
      // listing clients stay open in the firecrawl factory (cached)
    }
  }
  return { MultiServerMCPClient };
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function firecrawlServerOf(config: unknown): Record<string, unknown> {
  if (!isRecord(config) || !isRecord(config.mcpServers)) {
    throw new Error('mock client received a malformed config');
  }
  const server = config.mcpServers.firecrawl;
  if (!isRecord(server)) throw new Error('no firecrawl server entry');
  return server;
}

const FIRECRAWL_URL = 'https://firecrawl.example/mcp';

describe('FirecrawlPlugin (Workers port)', () => {
  beforeEach(() => {
    clientRecords.length = 0;
    upstreamTools = [
      {
        name: FIRECRAWL_SEARCH_MCP_NAME,
        invoke: vi.fn(async (input: unknown) => ({ hits: [], input })),
      },
      {
        name: FIRECRAWL_SCRAPE_MCP_NAME,
        invoke: vi.fn(async () => ({ markdown: '# page' })),
      },
      { name: 'firecrawl__firecrawl_crawl', invoke: vi.fn(async () => 'no') },
    ];
  });

  it('autoDetects on FIRECRAWL_MCP_URL', () => {
    const plugin = new FirecrawlPlugin();
    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetect({ FIRECRAWL_MCP_URL: FIRECRAWL_URL })).toBe(true);
  });

  it('registers one sub-agent wrapping firecrawl_search + firecrawl_scrape', () => {
    const plugin = new FirecrawlPlugin();
    const subAgents = plugin.getSubAgents(
      makeBuildCtx({ config: { FIRECRAWL_MCP_URL: FIRECRAWL_URL } }),
    );

    expect(subAgents).toHaveLength(1);
    const agent = subAgents[0];
    expect(agent?.name).toBe('Firecrawl Agent');
    const tools = Array.isArray(agent?.tools) ? agent.tools : [];
    expect(tools.map((t) => t.name)).toEqual([
      'firecrawl_search',
      'firecrawl_scrape',
    ]);
    // The MCP client is lazy — declaring the sub-agent opens no connection.
    expect(clientRecords.length).toBe(0);
  });

  it('proxies a validated search call to the upstream MCP tool over streamable HTTP', async () => {
    const plugin = new FirecrawlPlugin();
    const [agent] = plugin.getSubAgents(
      makeBuildCtx({ config: { FIRECRAWL_MCP_URL: FIRECRAWL_URL } }),
    );
    const tools = Array.isArray(agent?.tools) ? agent.tools : [];
    const search = tools.find((t) => t.name === 'firecrawl_search');

    const result = await search?.handler(
      { query: 'gold spot price USD', limit: 3 },
      makeRuntimeContext(),
    );

    const upstreamSearch = upstreamTools.find(
      (t) => t.name === FIRECRAWL_SEARCH_MCP_NAME,
    );
    expect(upstreamSearch?.invoke).toHaveBeenCalledWith({
      query: 'gold spot price USD',
      limit: 3,
    });
    expect(result).toEqual({
      hits: [],
      input: { query: 'gold spot price USD', limit: 3 },
    });

    // The default factory connected exactly once, over streamable HTTP.
    expect(clientRecords.length).toBe(1);
    const server = firecrawlServerOf(clientRecords[0]?.config);
    expect(server.transport).toBe('http');
    expect(server.url).toBe(FIRECRAWL_URL);
    // No auth headers — the firecrawl MCP is unauthenticated upstream.
    expect(server.headers).toBeUndefined();
  });

  it('rejects invalid args before touching the network', async () => {
    const plugin = new FirecrawlPlugin();
    const [agent] = plugin.getSubAgents(
      makeBuildCtx({ config: { FIRECRAWL_MCP_URL: FIRECRAWL_URL } }),
    );
    const tools = Array.isArray(agent?.tools) ? agent.tools : [];
    const search = tools.find((t) => t.name === 'firecrawl_search');

    await expect(
      search?.handler({ query: '' }, makeRuntimeContext()),
    ).rejects.toThrow();
    expect(clientRecords.length).toBe(0);
  });
});
