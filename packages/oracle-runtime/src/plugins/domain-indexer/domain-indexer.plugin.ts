import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  MergedConfig,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
} from '../../plugin-api/types.js';
import { createDomainIndexerSubAgent } from './domain-indexer-agent.js';
import { createDomainIndexerTools } from './domain-indexer-tools.js';

/**
 * Default Domain Indexer endpoints per IXO network. Selected at boot from
 * the core `NETWORK` env var. Operators can override with the optional
 * `DOMAIN_INDEXER_URL` env var (useful for local/staging deployments).
 */
const DOMAIN_INDEXER_URLS = {
  mainnet: 'https://domain-indexer.ixo.earth',
  testnet: 'https://domain-indexer.testnet.ixo.earth',
  devnet: 'https://domain-indexer.devnet.ixo.earth',
} as const;

const configSchema = z.object({
  DOMAIN_INDEXER_URL: z.string().url().optional(),
});

const networkSchema = z.enum(['mainnet', 'testnet', 'devnet']);

function resolveDomainIndexerUrl(config: MergedConfig): string {
  const override = configSchema.safeParse(config);
  if (override.success && override.data.DOMAIN_INDEXER_URL) {
    return override.data.DOMAIN_INDEXER_URL;
  }

  const network = networkSchema.safeParse(config.NETWORK);
  if (network.success) {
    return DOMAIN_INDEXER_URLS[network.data];
  }

  throw new Error(
    'domain-indexer: could not resolve base URL. Set DOMAIN_INDEXER_URL or ensure NETWORK is one of mainnet|testnet|devnet.',
  );
}

const manifest: PluginManifest = {
  title: 'Domain Indexer',
  summary:
    'Domain analysis and entity lookup across the IXO ecosystem — organizations, projects, DAOs, DIDs.',
  whenToUse: [
    'User asks "what is X?" or "tell me about X" for an organization, project, DAO, or DID.',
    'User needs the summary, overview, or FAQ of an IXO entity.',
    'Looking up a domain card by its DID.',
    'Discovering entities by topic, category, or keyword.',
  ],
  whenNotToUse: [
    'General web search unrelated to IXO entities (use Firecrawl).',
    'Personal memory or past-conversation recall (use Memory).',
    'Page editing or workspace pages (use Editor) — pages are NOT entities.',
  ],
  examples: [
    {
      user: 'Tell me about did:ixo:entity:abc123.',
      thought: 'IXO DID lookup — delegate to call_domain_indexer_agent.',
      tool: 'call_domain_indexer_agent',
    },
    {
      user: 'Find DAOs working on climate.',
      thought: 'Discovery by topic across IXO entities.',
      tool: 'call_domain_indexer_agent',
    },
  ],
  tags: ['ixo', 'entities', 'search', 'dids'],
  category: 'data',
  // On-demand: IXO entity lookups are a niche flow — the agent loads this
  // via `load_capability` when the conversation actually needs it, keeping
  // the sub-agent schema out of every unrelated chat turn.
  visibility: 'on-demand',
  stability: 'stable',
};

/**
 * Domain Indexer plugin. Exposes a sub-agent (`call_domain_indexer_agent`)
 * that searches the IXO Domain Indexer and resolves entities by DID.
 *
 * The base URL is derived from `NETWORK` by default and can be overridden
 * with `DOMAIN_INDEXER_URL` (e.g. for a local mirror or staging build).
 */
export class DomainIndexerPlugin extends OraclePlugin {
  readonly name = 'domain-indexer';
  readonly version = '1.0.0';
  readonly manifest = manifest;
  override readonly configSchema = configSchema;

  override getSubAgents(ctx: PluginContext): PluginSubAgent[] {
    const baseUrl = resolveDomainIndexerUrl(ctx.config);
    const tools = createDomainIndexerTools(baseUrl);
    return [createDomainIndexerSubAgent(tools)];
  }
}
