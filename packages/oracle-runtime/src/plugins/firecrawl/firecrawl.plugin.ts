import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  MergedConfig,
  PluginContext,
  PluginManifest,
  PluginSubAgent,
} from '../../plugin-api/types.js';
import { createFirecrawlSubAgent } from './firecrawl-agent.js';
import {
  createDefaultFirecrawlMcpFactory,
  createFirecrawlTools,
  type FirecrawlMcpFactory,
} from './firecrawl-tools.js';

const configSchema = z.object({
  FIRECRAWL_MCP_URL: z
    .string()
    .url('FIRECRAWL_MCP_URL must be a valid HTTP(S) URL.'),
});

const manifest: PluginManifest = {
  title: 'Firecrawl',
  summary: 'Web search and scraping of human-readable pages via Firecrawl.',
  whenToUse: [
    'User asks the agent to search the web for current information.',
    'User wants the contents of a specific human-readable page summarised or extracted.',
    'A question can only be answered by recent public web content.',
  ],
  whenNotToUse: [
    'Fetching from an API endpoint (any URL with /api/, /v1/, /v2/, /v3/, or that returns JSON/XML) — use the Sandbox instead.',
    'IXO entity lookups (use the Domain Indexer).',
    'Personal memory or past-conversation recall (use memory).',
  ],
  tags: ['web', 'search', 'scrape', 'firecrawl'],
  category: 'data',
  visibility: 'always',
  stability: 'stable',
};

function resolveFirecrawlUrl(config: MergedConfig): string {
  const parsed = configSchema.parse(config);
  return parsed.FIRECRAWL_MCP_URL;
}

/** Optional dependency injection — primarily for tests. */
export interface FirecrawlPluginOptions {
  /**
   * Override the MCP-tools factory. Defaults to a Firecrawl-MCP HTTP client
   * built from `FIRECRAWL_MCP_URL`. Tests pass a stub so the plugin never
   * touches the network.
   */
  mcpFactory?: (firecrawlUrl: string) => FirecrawlMcpFactory;
}

/**
 * Firecrawl plugin. Exposes a sub-agent (`call_firecrawl_agent`) that wraps
 * the upstream Firecrawl MCP server's `firecrawl_search` and
 * `firecrawl_scrape` tools.
 */
export class FirecrawlPlugin extends OraclePlugin {
  readonly name = 'firecrawl';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'FIRECRAWL_MCP_URL';

  private readonly mcpFactory: (firecrawlUrl: string) => FirecrawlMcpFactory;

  constructor(options: FirecrawlPluginOptions = {}) {
    super();
    this.mcpFactory = options.mcpFactory ?? createDefaultFirecrawlMcpFactory;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.FIRECRAWL_MCP_URL);
  }

  override getSubAgents(ctx: PluginContext): PluginSubAgent[] {
    const firecrawlUrl = resolveFirecrawlUrl(ctx.config);
    const factory = this.mcpFactory(firecrawlUrl);
    const tools = createFirecrawlTools(factory);
    return [createFirecrawlSubAgent(tools)];
  }
}
