import { describe, expect, it, vi } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import type {
  PluginContext,
  PluginSubAgent,
  PluginTool,
} from '../../plugin-api/types.js';
import {
  makeBuildCtx,
  makeRuntimeContext,
} from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import {
  FIRECRAWL_SCRAPE_TOOL,
  FIRECRAWL_SEARCH_TOOL,
  type FirecrawlMcpFactory,
  type FirecrawlMcpProxyTool,
} from './firecrawl-tools.js';
import { FirecrawlPlugin } from './firecrawl.plugin.js';

const FIRECRAWL_URL = 'https://firecrawl.test/mcp';

/** Build a stub factory that returns the supplied MCP tools. */
function stubFactory(
  tools: FirecrawlMcpProxyTool[],
): (url: string) => FirecrawlMcpFactory {
  return () => async () => tools;
}

function ctxWithUrl(): PluginContext {
  return makeBuildCtx({ config: { FIRECRAWL_MCP_URL: FIRECRAWL_URL } });
}

function subAgentFor(
  plugin: FirecrawlPlugin,
  ctx: PluginContext,
): PluginSubAgent {
  const [first] = plugin.getSubAgents(ctx);
  if (!first) throw new Error('expected one sub-agent');
  return first;
}

function toolsOf(subAgent: PluginSubAgent, ctx: PluginContext): PluginTool[] {
  return typeof subAgent.tools === 'function'
    ? subAgent.tools(ctx)
    : subAgent.tools;
}

describe('FirecrawlPlugin', () => {
  it('has the expected name, version, and manifest', () => {
    const plugin = new FirecrawlPlugin();
    expect(plugin.name).toBe('firecrawl');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Firecrawl');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('data');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);

    // Manifest also passes the runtime's validator.
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('requires a valid FIRECRAWL_MCP_URL — empty or bad values are rejected', () => {
    const plugin = new FirecrawlPlugin();
    expect(plugin.configSchema).toBeDefined();
    expect(plugin.configSchema.safeParse({}).success).toBe(false);
    expect(
      plugin.configSchema.safeParse({ FIRECRAWL_MCP_URL: 'not-a-url' }).success,
    ).toBe(false);
    expect(
      plugin.configSchema.safeParse({ FIRECRAWL_MCP_URL: FIRECRAWL_URL })
        .success,
    ).toBe(true);

    // getSubAgents fails fast when the URL is missing at build time.
    expect(() => plugin.getSubAgents(makeBuildCtx({ config: {} }))).toThrow();
  });

  it('registers the Firecrawl Agent sub-agent with firecrawl_search and firecrawl_scrape tools', () => {
    const plugin = new FirecrawlPlugin({
      mcpFactory: stubFactory([]),
    });
    const ctx = ctxWithUrl();
    const sub = subAgentFor(plugin, ctx);

    expect(sub.name).toBe('Firecrawl Agent');
    expect(sub.model).toBe('subagent');

    const tools = toolsOf(sub, ctx);
    expect(tools.map((t) => t.name)).toEqual([
      FIRECRAWL_SEARCH_TOOL,
      FIRECRAWL_SCRAPE_TOOL,
    ]);

    const prompt =
      typeof sub.systemPrompt === 'function'
        ? sub.systemPrompt(ctx)
        : sub.systemPrompt;
    expect(prompt).toContain('Firecrawl Agent');
    expect(prompt).toContain(FIRECRAWL_SEARCH_TOOL);
    expect(prompt).toContain(FIRECRAWL_SCRAPE_TOOL);
    expect(prompt).toContain('STOP');
  });

  it('proxies tool invocations through the injected MCP factory', async () => {
    const searchInvoke = vi.fn(async () => ({
      results: [{ url: 'https://x' }],
    }));
    const scrapeInvoke = vi.fn(async () => ({ markdown: '# Hello' }));
    const mcpTools: FirecrawlMcpProxyTool[] = [
      { name: 'firecrawl__firecrawl_search', invoke: searchInvoke },
      { name: 'firecrawl__firecrawl_scrape', invoke: scrapeInvoke },
    ];
    const factoryFn = vi.fn(stubFactory(mcpTools));

    const plugin = new FirecrawlPlugin({ mcpFactory: factoryFn });
    const ctx = ctxWithUrl();
    const tools = toolsOf(subAgentFor(plugin, ctx), ctx);
    const search = tools.find((t) => t.name === FIRECRAWL_SEARCH_TOOL)!;
    const scrape = tools.find((t) => t.name === FIRECRAWL_SCRAPE_TOOL)!;

    // The factory is built with the configured FIRECRAWL_MCP_URL.
    expect(factoryFn).toHaveBeenCalledWith(FIRECRAWL_URL);

    const searchResult = await search.handler(
      { query: 'gold spot price USD', limit: 3 },
      makeRuntimeContext(),
    );
    expect(searchResult).toEqual({ results: [{ url: 'https://x' }] });
    expect(searchInvoke).toHaveBeenCalledWith({
      query: 'gold spot price USD',
      limit: 3,
    });

    const scrapeResult = await scrape.handler(
      { url: 'https://example.com/blog/post' },
      makeRuntimeContext(),
    );
    expect(scrapeResult).toEqual({ markdown: '# Hello' });
    expect(scrapeInvoke).toHaveBeenCalledWith({
      url: 'https://example.com/blog/post',
    });

    // Empty queries and bad URLs short-circuit before the MCP call.
    await expect(
      search.handler({ query: '' }, makeRuntimeContext()),
    ).rejects.toThrow();
    await expect(
      scrape.handler({ url: 'not-a-url' }, makeRuntimeContext()),
    ).rejects.toThrow();
    expect(searchInvoke).toHaveBeenCalledTimes(1);
    expect(scrapeInvoke).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when the upstream MCP server does not expose the expected tool', async () => {
    const plugin = new FirecrawlPlugin({ mcpFactory: stubFactory([]) });
    const ctx = ctxWithUrl();
    const search = toolsOf(subAgentFor(plugin, ctx), ctx).find(
      (t) => t.name === FIRECRAWL_SEARCH_TOOL,
    )!;
    await expect(
      search.handler({ query: 'anything' }, makeRuntimeContext()),
    ).rejects.toThrow(/firecrawl__firecrawl_search/);
  });

  it('boots through createTestRuntime with visibility=on-demand and exposes the sub-agent', async () => {
    const rt = await createTestRuntime({
      plugins: [new FirecrawlPlugin({ mcpFactory: stubFactory([]) })],
      config: { FIRECRAWL_MCP_URL: FIRECRAWL_URL },
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();

    const listing = rt.listCapabilities().find((c) => c.name === 'firecrawl');
    expect(listing).toBeDefined();
    expect(listing?.visibility).toBe('on-demand');
    expect(listing?.loaded).toBe(false);

    const reply = await rt.invokeSubAgent(
      'Firecrawl Agent',
      'Scrape https://example.com/docs',
    );
    const parsed = JSON.parse(reply) as {
      plugin: string;
      subAgent: string;
      toolNames: string[];
    };
    expect(parsed.plugin).toBe('firecrawl');
    expect(parsed.subAgent).toBe('Firecrawl Agent');
    expect(parsed.toolNames).toEqual([
      FIRECRAWL_SEARCH_TOOL,
      FIRECRAWL_SCRAPE_TOOL,
    ]);

    await rt.close();
  });
});
