import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { validateManifest } from '../../manifest/validator.js';
import type {
  PluginContext,
  PluginSubAgent,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { makeBuildCtx, makeRuntimeContext } from '../../registries/test-fixtures.js';
import { DomainIndexerPlugin } from './domain-indexer.plugin.js';

const BASE_URL = 'https://indexer.test';

function ctxWithUrl(url: string = BASE_URL): PluginContext {
  return makeBuildCtx({ config: { DOMAIN_INDEXER_URL: url } });
}

function ctxWithNetwork(
  network: 'mainnet' | 'testnet' | 'devnet',
): PluginContext {
  return makeBuildCtx({ config: { NETWORK: network } });
}

function subAgentFor(plugin: DomainIndexerPlugin, ctx: PluginContext): PluginSubAgent {
  const [first] = plugin.getSubAgents(ctx);
  if (!first) throw new Error('expected one sub-agent');
  return first;
}

function toolsOf(subAgent: PluginSubAgent, ctx: PluginContext): PluginTool[] {
  return typeof subAgent.tools === 'function'
    ? subAgent.tools(ctx)
    : subAgent.tools;
}

function runtimeCtx(): RuntimeContext {
  return makeRuntimeContext();
}

describe('DomainIndexerPlugin', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('has the expected name, version, and manifest', () => {
    const plugin = new DomainIndexerPlugin();
    expect(plugin.name).toBe('domain-indexer');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Domain Indexer');
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.category).toBe('data');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);
  });

  it('manifest passes validateManifest', () => {
    const plugin = new DomainIndexerPlugin();
    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('exposes a Zod configSchema with DOMAIN_INDEXER_URL as an optional override', () => {
    const plugin = new DomainIndexerPlugin();
    expect(plugin.configSchema).toBeDefined();
    // Empty config is valid — the runtime falls back to NETWORK.
    expect(plugin.configSchema!.safeParse({}).success).toBe(true);
    // A valid URL is accepted.
    expect(
      plugin.configSchema!.safeParse({ DOMAIN_INDEXER_URL: BASE_URL }).success,
    ).toBe(true);
    // A garbage value is still rejected so misconfig is caught early.
    expect(
      plugin.configSchema!.safeParse({ DOMAIN_INDEXER_URL: 'not-a-url' })
        .success,
    ).toBe(false);
  });

  it.each([
    ['mainnet', 'https://domain-indexer.ixo.earth'],
    ['testnet', 'https://domain-indexer.testnet.ixo.earth'],
    ['devnet', 'https://domain-indexer.devnet.ixo.earth'],
  ] as const)(
    'derives the base URL from NETWORK=%s when no override is set',
    async (network, expectedOrigin) => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      const plugin = new DomainIndexerPlugin();
      const ctx = ctxWithNetwork(network);
      const tools = toolsOf(subAgentFor(plugin, ctx), ctx);
      const search = tools.find((t) => t.name === 'domain_indexer_search');
      await search!.handler({ query: 'x' }, runtimeCtx());
      const url = new URL(fetchSpy.mock.calls[0]![0] as string);
      expect(url.origin).toBe(expectedOrigin);
    },
  );

  it('uses DOMAIN_INDEXER_URL when both override and NETWORK are set', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const plugin = new DomainIndexerPlugin();
    const ctx = makeBuildCtx({
      config: { DOMAIN_INDEXER_URL: BASE_URL, NETWORK: 'mainnet' },
    });
    const tools = toolsOf(subAgentFor(plugin, ctx), ctx);
    const search = tools.find((t) => t.name === 'domain_indexer_search');
    await search!.handler({ query: 'x' }, runtimeCtx());
    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.origin).toBe(BASE_URL);
  });

  it('throws a helpful error when neither DOMAIN_INDEXER_URL nor NETWORK is set', () => {
    const plugin = new DomainIndexerPlugin();
    expect(() => plugin.getSubAgents(makeBuildCtx({ config: {} }))).toThrow(
      /DOMAIN_INDEXER_URL.*NETWORK/,
    );
  });

  it('loads via createTestRuntime when DOMAIN_INDEXER_URL is provided', async () => {
    const rt = await createTestRuntime({
      plugins: [new DomainIndexerPlugin()],
      config: { DOMAIN_INDEXER_URL: BASE_URL },
    });

    rt.assertNoCollisions();
    rt.assertManifestValid();
    const listing = rt.listCapabilities().find((c) => c.name === 'domain-indexer');
    expect(listing).toBeDefined();
    expect(listing?.visibility).toBe('always');
    expect(listing?.loaded).toBe(true);
    await rt.close();
  });

  it('registers a Domain Indexer Agent sub-agent that wraps to call_domain_indexer_agent', async () => {
    const rt = await createTestRuntime({
      plugins: [new DomainIndexerPlugin()],
      config: { DOMAIN_INDEXER_URL: BASE_URL },
      mocks: { llm: { respondWith: 'mocked reply' } },
    });

    const reply = await rt.invokeSubAgent(
      'Domain Indexer Agent',
      'Search for IXO World',
    );
    const parsed = JSON.parse(reply) as {
      plugin: string;
      subAgent: string;
      toolNames: string[];
      reply: string;
    };
    expect(parsed.plugin).toBe('domain-indexer');
    expect(parsed.subAgent).toBe('Domain Indexer Agent');
    expect(parsed.toolNames).toEqual([
      'domain_indexer_search',
      'get_domain_card',
    ]);
    expect(parsed.reply).toBe('mocked reply');
    await rt.close();
  });

  it('sub-agent system prompt embeds tool docs and discipline rules', () => {
    const plugin = new DomainIndexerPlugin();
    const ctx = ctxWithUrl();
    const subAgent = subAgentFor(plugin, ctx);
    const prompt =
      typeof subAgent.systemPrompt === 'function'
        ? subAgent.systemPrompt(ctx)
        : subAgent.systemPrompt;
    expect(prompt).toContain('Domain Indexer Agent');
    expect(prompt).toContain('domain_indexer_search');
    expect(prompt).toContain('get_domain_card');
    expect(prompt).toContain('STOP');
  });

  it('declares model role "subagent" for runtime LLM resolution', () => {
    const plugin = new DomainIndexerPlugin();
    const subAgent = subAgentFor(plugin, ctxWithUrl());
    expect(subAgent.model).toBe('subagent');
  });

  describe('domain_indexer_search tool', () => {
    it('issues a GET to /search with the query and returns parsed JSON', async () => {
      const mockBody = { results: [{ id: 'did:ixo:entity:x' }] };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockBody), { status: 200 }),
      );
      const plugin = new DomainIndexerPlugin();
      const tools = toolsOf(subAgentFor(plugin, ctxWithUrl()), ctxWithUrl());
      const search = tools.find((t) => t.name === 'domain_indexer_search');
      expect(search).toBeDefined();
      const result = await search!.handler(
        {
          query: 'ixo world',
          limit: 5,
          scopes: 'domain_cards',
          filters: { 'dc.has_url': 'true' },
        },
        runtimeCtx(),
      );
      expect(result).toEqual(mockBody);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = new URL(fetchSpy.mock.calls[0]![0] as string);
      expect(url.origin + url.pathname).toBe(`${BASE_URL}/search`);
      expect(url.searchParams.get('q')).toBe('ixo world');
      expect(url.searchParams.get('limit')).toBe('5');
      expect(url.searchParams.get('scopes')).toBe('domain_cards');
      expect(url.searchParams.get('dc.has_url')).toBe('true');
    });

    it('throws when the indexer returns a non-2xx response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('boom', { status: 500, statusText: 'Server Error' }),
      );
      const plugin = new DomainIndexerPlugin();
      const tools = toolsOf(subAgentFor(plugin, ctxWithUrl()), ctxWithUrl());
      const search = tools.find((t) => t.name === 'domain_indexer_search');
      await expect(
        search!.handler({ query: 'x' }, runtimeCtx()),
      ).rejects.toThrow(/Search failed/);
    });

    it('rejects empty queries via the Zod schema', async () => {
      const plugin = new DomainIndexerPlugin();
      const tools = toolsOf(subAgentFor(plugin, ctxWithUrl()), ctxWithUrl());
      const search = tools.find((t) => t.name === 'domain_indexer_search');
      await expect(
        search!.handler({ query: '' }, runtimeCtx()),
      ).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('get_domain_card tool', () => {
    it('returns only essential fields from the full card payload', async () => {
      const fullCard = {
        id: 'did:ixo:entity:ixoworld',
        name: 'IXO World',
        description: 'desc',
        summary: 'sum',
        overview: 'ov',
        faq: [{ q: 'what?', a: 'this' }],
        url: 'https://ixo.world',
        keywords: ['ixo'],
        entity_type: ['dao'],
        secrets: 'hidden',
        large_blob: new Array(1000).fill('x').join(''),
      };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(fullCard), { status: 200 }),
      );
      const plugin = new DomainIndexerPlugin();
      const tools = toolsOf(subAgentFor(plugin, ctxWithUrl()), ctxWithUrl());
      const card = tools.find((t) => t.name === 'get_domain_card');
      const result = await card!.handler(
        { did: 'did:ixo:entity:ixoworld' },
        runtimeCtx(),
      );
      expect(result).toEqual({
        id: 'did:ixo:entity:ixoworld',
        name: 'IXO World',
        description: 'desc',
        summary: 'sum',
        overview: 'ov',
        faq: [{ q: 'what?', a: 'this' }],
        url: 'https://ixo.world',
        keywords: ['ixo'],
        entity_type: ['dao'],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = new URL(fetchSpy.mock.calls[0]![0] as string);
      expect(url.pathname).toBe('/domain-cards/did:ixo:entity:ixoworld');
    });

    it('returns a not-found shape for 404 (instead of throwing)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 404, statusText: 'Not Found' }),
      );
      const plugin = new DomainIndexerPlugin();
      const tools = toolsOf(subAgentFor(plugin, ctxWithUrl()), ctxWithUrl());
      const card = tools.find((t) => t.name === 'get_domain_card');
      const result = await card!.handler(
        { did: 'did:ixo:entity:missing' },
        runtimeCtx(),
      );
      expect(result).toEqual({ error: 'Domain card not found' });
    });

    it('throws on non-404 errors', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 503, statusText: 'Down' }),
      );
      const plugin = new DomainIndexerPlugin();
      const tools = toolsOf(subAgentFor(plugin, ctxWithUrl()), ctxWithUrl());
      const card = tools.find((t) => t.name === 'get_domain_card');
      await expect(
        card!.handler({ did: 'did:ixo:entity:x' }, runtimeCtx()),
      ).rejects.toThrow(/Failed to fetch domain card/);
    });

    it('defaults faq/keywords/entity_type to empty arrays when missing', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'did:ixo:entity:bare', name: 'Bare' }),
          { status: 200 },
        ),
      );
      const plugin = new DomainIndexerPlugin();
      const tools = toolsOf(subAgentFor(plugin, ctxWithUrl()), ctxWithUrl());
      const card = tools.find((t) => t.name === 'get_domain_card');
      const result = await card!.handler(
        { did: 'did:ixo:entity:bare' },
        runtimeCtx(),
      );
      expect(result).toMatchObject({
        faq: [],
        keywords: [],
        entity_type: [],
      });
    });
  });
});
