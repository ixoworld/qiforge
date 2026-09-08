import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBuildCtx, makeRuntimeContext } from '../../core/test-fixtures';
import { DomainIndexerPlugin } from './domain-indexer.plugin';

interface RecordedCall {
  url: string;
}

describe('DomainIndexerPlugin (Workers port)', () => {
  let calls: RecordedCall[];
  let nextResponse: () => Response;

  beforeEach(() => {
    calls = [];
    nextResponse = () =>
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return nextResponse();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function subAgentTools(config: Record<string, unknown>) {
    const plugin = new DomainIndexerPlugin();
    const [agent] = plugin.getSubAgents(makeBuildCtx({ config }));
    return Array.isArray(agent?.tools) ? agent.tools : [];
  }

  it('registers one sub-agent with the two lookup tools', () => {
    const tools = subAgentTools({ NETWORK: 'devnet' });
    expect(tools.map((t) => t.name)).toEqual([
      'domain_indexer_search',
      'get_domain_card',
    ]);
  });

  it('derives the base URL from NETWORK and forwards query/limit/scopes/filters', async () => {
    const tools = subAgentTools({ NETWORK: 'devnet' });
    const search = tools.find((t) => t.name === 'domain_indexer_search');

    nextResponse = () =>
      new Response(JSON.stringify({ results: [{ record: { id: 'x' } }] }), {
        status: 200,
      });
    const result = await search?.handler(
      {
        query: 'carbon credits',
        limit: 5,
        scopes: 'domain_cards',
        filters: { 'dc.entity_type': 'dao/pod' },
      },
      makeRuntimeContext(),
    );

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin).toBe('https://domain-indexer.devnet.ixo.earth');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('carbon credits');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('scopes')).toBe('domain_cards');
    expect(url.searchParams.get('dc.entity_type')).toBe('dao/pod');
    expect(result).toEqual({ results: [{ record: { id: 'x' } }] });
  });

  it('honours the DOMAIN_INDEXER_URL override', async () => {
    const tools = subAgentTools({
      NETWORK: 'mainnet',
      DOMAIN_INDEXER_URL: 'https://indexer.local.example',
    });
    const search = tools.find((t) => t.name === 'domain_indexer_search');
    await search?.handler({ query: 'ixo' }, makeRuntimeContext());
    expect(new URL(calls[0]?.url ?? '').origin).toBe(
      'https://indexer.local.example',
    );
  });

  it('get_domain_card projects the essential fields only', async () => {
    const tools = subAgentTools({ NETWORK: 'testnet' });
    const card = tools.find((t) => t.name === 'get_domain_card');

    nextResponse = () =>
      new Response(
        JSON.stringify({
          id: 'did:ixo:entity:abc',
          name: 'Acme DAO',
          description: 'desc',
          summary: 'sum',
          overview: 'over',
          faq: [{ question: 'q', answer: 'a' }],
          url: 'https://acme.example',
          keywords: ['dao'],
          entity_type: ['dao/pod'],
          entity_verified: true,
          internal_field_that_must_not_leak: 'secret',
        }),
        { status: 200 },
      );
    const result = await card?.handler(
      { did: 'did:ixo:entity:abc' },
      makeRuntimeContext(),
    );

    expect(calls[0]?.url).toBe(
      'https://domain-indexer.testnet.ixo.earth/domain-cards/did:ixo:entity:abc',
    );
    expect(result).toEqual({
      id: 'did:ixo:entity:abc',
      name: 'Acme DAO',
      description: 'desc',
      summary: 'sum',
      overview: 'over',
      faq: [{ question: 'q', answer: 'a' }],
      url: 'https://acme.example',
      keywords: ['dao'],
      entity_type: ['dao/pod'],
      entity_verified: true,
    });
  });

  it('get_domain_card maps a 404 to a soft error object', async () => {
    const tools = subAgentTools({ NETWORK: 'devnet' });
    const card = tools.find((t) => t.name === 'get_domain_card');
    nextResponse = () => new Response('not found', { status: 404 });
    const result = await card?.handler(
      { did: 'did:ixo:entity:missing' },
      makeRuntimeContext(),
    );
    expect(result).toEqual({ error: 'Domain card not found' });
  });
});
