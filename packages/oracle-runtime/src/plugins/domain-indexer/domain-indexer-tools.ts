import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';

const searchSchema = z.object({
  query: z
    .string()
    .min(
      1,
      '❌ ERROR: Query is required and cannot be empty - this tool works like Google search, you MUST provide a search query',
    )
    .describe(
      '🚨 MANDATORY PARAMETER - ALWAYS REQUIRED\n' +
        'This tool works like Google search - you MUST provide a search query to find entities.\n' +
        'The search query string. Cannot be empty or omitted. This is like typing into Google search.\n' +
        'Examples:\n' +
        '- User asks "What is IXO?" → Use query: "IXO"\n' +
        '- User asks "Tell me about blockchain projects" → Use query: "blockchain projects"\n' +
        '- User asks "What are carbon credits?" → Use query: "carbon credits"\n' +
        "Extract the main search term from the user's question and use it as the query.\n" +
        'This parameter is mandatory - you cannot search without a query, just like you cannot Google search without typing something.',
    ),
  limit: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .describe(
      'Optional: Maximum number of results to return (1-10, default: 10)',
    ),
  scopes: z
    .string()
    .optional()
    .describe(
      'Optional: Comma-separated list of scopes to search: domain_cards (default), agents, compositions, events. Use "domain_cards" to find organizations/projects/DAOs with summaries and FAQs.',
    ),
  filters: z.record(z.string(), z.string()).optional()
    .describe(`Optional filters as key-value pairs. Examples:
- {"dc.entity_type": "dao/pod"} - Filter by exact chain entity type (e.g. dao/pod, dao/protocol, dao — compound types are preserved, not split)
- {"dc.entity_verified": "true"} - Only verified entities (chain-sourced: true/false/omit for all)
- {"dc.categories": "dao,project"} - Filter by categories
- {"dc.has_url": "true"} - Only entities with URLs
- {"dc.keywords": "blockchain,web3"} - Filter by keywords
- {"agent.domain_card_id": "did:ixo:entity:ixoworld"} - Agents for specific entity
For multiple values, use comma-separated strings. For booleans, use "true" or "false". For dates, use ISO format.`),
});

const cardSchema = z.object({
  did: z
    .string()
    .min(1, '❌ ERROR: DID is required and cannot be empty')
    .describe(
      'REQUIRED: Domain card DID (Decentralized Identifier). Must be a non-empty string. Get this from search results (record.id) or user input. Example: "did:ixo:entity:ixoworld". This parameter is mandatory and cannot be omitted.',
    ),
});

const SEARCH_DESCRIPTION = `🔍 This is like Google Search for entities and domains in the IXO ecosystem. You search using a query and you will find relevant entities.

Think of this tool exactly like Google Search:
- Google Search: You type a query → You get search results
- Domain Indexer: You provide a query → You get entity results

🚨 CRITICAL REQUIREMENT: You MUST provide the 'query' parameter. This tool works like Google search - you CANNOT search without a query. NEVER call this tool with empty arguments {}.

✅ CORRECT EXAMPLES (like Google search):
{"query": "IXO"}
{"query": "blockchain impact"}
{"query": "carbon credits", "limit": 5}
{"query": "What is IXO?", "scopes": "domain_cards"}

❌ WRONG (WILL FAIL - like trying to Google search with no query):
{}
{"limit": 5}
{"scopes": "domain_cards"}

The 'query' parameter is MANDATORY in every call - just like you can't Google search without typing something.

WHAT IT DOES:
- Searches the IXO domain indexer to find entities (organizations, projects, DAOs, agents, compositions, events)
- Returns summaries, overviews, and FAQs for matching entities
- Works like Google search: you provide a search query and get relevant results

PRIMARY USE CASES:
- When users ask "What is X?" or "Tell me about X" → Use query: "X" to find the entity
- When users ask "What are the FAQs for X?" → Use query: "X" to find the entity and access its FAQ section
- When users need information about an organization/project → Use query with the entity name or topic
- When users ask about entities in the IXO ecosystem → Use query with relevant keywords

WHAT IT RETURNS:
- Entity records containing: name, description, summary, overview, FAQs, keywords, URLs, logos, contact info, location, and metadata
- Search results include domain cards (organizations/projects/DAOs), agents, compositions (documents/resources), and events
- Each result has a 'record' field with the entity data - look for 'summary', 'overview', and 'faq' fields in the record
- Results are ranked by relevance using hybrid search (text + semantic similarity)

WORKFLOW:
1. User asks about something → Extract the search query (entity name, topic, or keywords)
2. Call this tool with the query: {"query": "extracted search term"}
3. Review the search results - each item has a 'record' field with entity data
4. Check the 'record' for 'summary', 'overview', and 'faq' fields
5. If you need more complete information, use get_domain_card with the entity's DID (found in record.id)

FILTERS (optional):
- Domain cards:
  - dc.entity_type: exact chain entity type — "dao/pod" for pods, "dao/protocol" for protocol DAOs, "dao" for plain DAOs. Compound types are never split; "dao/pod" and "dao" are distinct values.
  - dc.entity_verified: "true" or "false" — chain-verified status. Omit to include both.
  - dc.categories: comma-separated category values
  - dc.keywords: comma-separated keywords
  - dc.issuer: DID of the issuer
  - dc.has_url: "true"/"false" — whether entity has a URL
  - dc.has_logo: "true"/"false" — whether entity has a logo
  - dc.valid_from_gte / dc.valid_from_lte: ISO datetime bounds
  - dc.bbox: minLng,minLat,maxLng,maxLat (geo bounding box)
  - dc.near + dc.radius: lng,lat and radius in km (geo proximity)
- Agents: agent.domain_card_id, agent.has_url (true/false)
- Compositions: comp.domain_card_id, comp.creator, comp.has_url (true/false)
- Events: event.domain_card_id, event.from (ISO date), event.to (ISO date), event.location

ENTITY TYPE EXAMPLES:
- Find all pods: {"dc.entity_type": "dao/pod"}
- Find protocol DAOs: {"dc.entity_type": "dao/protocol"}
- Find verified entities of type protocol/dao: {"dc.entity_type": "dao/protocol", "dc.entity_verified": "true"}
- "verified entities of type protocol/dao relevant to mining" → query: "mining", filters: {"dc.entity_type": "dao/protocol", "dc.entity_verified": "true"}

IMPORTANT: Always check the 'record' field in results for summary, overview, and faq data. These fields contain the curated information about the entity.`;

const CARD_DESCRIPTION = `Get essential domain card details by DID (Decentralized Identifier) including summary, overview, FAQs, and key information. Returns only essential fields to optimize context usage.

🚨 CRITICAL REQUIREMENT: You MUST provide the 'did' parameter. NEVER call this tool with empty arguments {}.

✅ CORRECT EXAMPLES:
{"did": "did:ixo:entity:ixoworld"}

❌ WRONG (WILL FAIL):
{}
{"query": "IXO"}

⚠️ REQUIRED PARAMETERS:
- did (REQUIRED): The domain card DID (Decentralized Identifier) - MUST always be provided. Cannot be empty.

PRIMARY USE CASES:
- After using domain_indexer_search, use this to get the essential entity information including summary, overview, and FAQs
- When you have a specific entity DID and need its summary, overview, or FAQs
- When search results show partial information and you need the curated summary/overview/FAQ fields
- When users specifically ask for FAQs, summaries, or overviews of a known entity

WHAT IT RETURNS (filtered to essential fields only):
- id: Entity DID
- name: Entity name
- description: Full description
- summary: Brief summary of the entity (if available)
- overview: Detailed overview/description (if available)
- faq: Array of FAQ objects with question and answer fields
- url: Entity website URL
- keywords: Array of keywords
- entity_type: Array containing the chain entity type (e.g. ["dao/pod"], ["dao/protocol"], ["dao"])
- entity_verified: boolean or null — whether the entity is verified on-chain (null means not yet determined)

WORKFLOW:
1. First use domain_indexer_search to find entities
2. Extract the DID from search results (record.id field)
3. Use this tool with the DID to get essential information including summary, overview, and FAQs
4. The response directly contains summary, overview, and faq fields at the top level

IMPORTANT: This tool returns a filtered response with only essential fields (summary, overview, FAQ, and basic info) to avoid context overload. All fields are at the top level - no need to navigate nested objects.`;

/** Domain-card payload trimmed to the fields the agent needs. */
interface DomainCardSummary {
  id: unknown;
  name: unknown;
  description: unknown;
  summary: unknown;
  overview: unknown;
  faq: unknown;
  url: unknown;
  keywords: unknown;
  entity_type: unknown;
  entity_verified: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function projectDomainCard(card: unknown): DomainCardSummary {
  const c = isRecord(card) ? card : {};
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    summary: c.summary,
    overview: c.overview,
    faq: c.faq ?? [],
    url: c.url,
    keywords: c.keywords ?? [],
    entity_type: c.entity_type ?? [],
    entity_verified: c.entity_verified ?? null,
  };
}

/**
 * Construct the two domain-indexer tools, closing over the configured base
 * URL. Tools are pure HTTP wrappers — they don't need a `RuntimeContext`,
 * so the handler ignores the second argument.
 */
export function createDomainIndexerTools(baseUrl: string): PluginTool[] {
  const search = tool(
    async (rawArgs) => {
      const params = searchSchema.parse(rawArgs);
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', params.query);
      if (params.limit !== undefined) {
        url.searchParams.set('limit', String(params.limit));
      }
      if (params.scopes) url.searchParams.set('scopes', params.scopes);
      for (const [k, v] of Object.entries(params.filters ?? {})) {
        url.searchParams.set(k, v);
      }
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }
      return response.json();
    },
    {
      name: 'domain_indexer_search',
      description: SEARCH_DESCRIPTION,
      schema: searchSchema,
    },
  );

  const card = tool(
    async (rawArgs) => {
      const { did } = cardSchema.parse(rawArgs);
      const url = new URL(`/domain-cards/${did}`, baseUrl);
      const response = await fetch(url.toString());
      if (!response.ok) {
        if (response.status === 404) {
          return { error: 'Domain card not found' };
        }
        throw new Error(`Failed to fetch domain card: ${response.statusText}`);
      }
      const fullCard: unknown = await response.json();
      return projectDomainCard(fullCard);
    },
    {
      name: 'get_domain_card',
      description: CARD_DESCRIPTION,
      schema: cardSchema,
    },
  );

  return [search, card];
}
