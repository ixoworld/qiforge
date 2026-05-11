import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { z } from 'zod';
import { tool } from '../../plugin-api/tool-helper.js';
import type { PluginTool } from '../../plugin-api/types.js';

/**
 * Minimal surface a Firecrawl MCP tool needs to expose to be proxied: an
 * identifier and an `invoke` method. `MultiServerMCPClient.getTools()`
 * returns `DynamicStructuredTool[]` which trivially satisfies this shape,
 * and unit tests can satisfy it with a plain object — no SDK ceremony.
 */
export interface FirecrawlMcpProxyTool {
  name: string;
  invoke: (input: unknown) => Promise<unknown>;
}

/**
 * Tool names that the upstream Firecrawl MCP server exposes (prefixed with
 * the server name configured in {@link MultiServerMCPClient}). Filtering by
 * these names keeps the agent's surface area tight even if the server adds
 * extra capabilities later.
 */
export const FIRECRAWL_SCRAPE_MCP_NAME = 'firecrawl__firecrawl_scrape';
export const FIRECRAWL_SEARCH_MCP_NAME = 'firecrawl__firecrawl_search';

/** Public tool names shown to the agent (server prefix dropped). */
export const FIRECRAWL_SCRAPE_TOOL = 'firecrawl_scrape';
export const FIRECRAWL_SEARCH_TOOL = 'firecrawl_search';

const SEARCH_DESCRIPTION = `Web search via Firecrawl. Returns a ranked list of result snippets with titles and URLs.

Use this BEFORE \`firecrawl_scrape\` whenever a search snippet is enough — it's faster and cheaper. Only escalate to scraping when the snippet is incomplete and you need the full page.

🚨 Never use this for API endpoints (any URL with /api/, /v1/, /v2/, /v3/, or returning JSON/XML). Use the Sandbox for those.`;

const SCRAPE_DESCRIPTION = `Scrape a single human-readable web page via Firecrawl. Returns the page as Markdown plus structured metadata.

Use this only when you've already tried \`firecrawl_search\` and need the full page content (long article, table, structured data on a static page).

🚨 Never use this on API endpoints (any URL with /api/, /v1/, /v2/, /v3/, or returning JSON/XML). Use the Sandbox for those.`;

const searchSchema = z.object({
  query: z
    .string()
    .min(1, 'Query is required and cannot be empty.')
    .describe('Search query — write ONE precise, well-targeted query.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Max number of results (1-10). Default upstream.'),
});

const scrapeSchema = z.object({
  url: z
    .string()
    .url()
    .describe('Fully-qualified URL of the page to scrape (https://...).'),
  formats: z
    .array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'screenshot']))
    .optional()
    .describe(
      "Output formats. Defaults to ['markdown']. Use 'links' to enumerate outbound URLs.",
    ),
  onlyMainContent: z
    .boolean()
    .optional()
    .describe(
      'When true (default), strips navigation, ads, and boilerplate — returns just the main content block.',
    ),
});

/**
 * Factory for the underlying MCP-tool list. Injectable so unit tests can
 * substitute a stub without spinning up the real MCP transport.
 */
export type FirecrawlMcpFactory = () => Promise<FirecrawlMcpProxyTool[]>;

/** Build the default factory keyed to `FIRECRAWL_MCP_URL`. */
export function createDefaultFirecrawlMcpFactory(
  firecrawlUrl: string,
): FirecrawlMcpFactory {
  let cached: Promise<FirecrawlMcpProxyTool[]> | null = null;
  return () => {
    cached ??= (async () => {
      const client = new MultiServerMCPClient({
        useStandardContentBlocks: true,
        defaultToolTimeout: 120_000,
        prefixToolNameWithServerName: true,
        mcpServers: {
          firecrawl: {
            type: 'http',
            transport: 'http',
            url: firecrawlUrl,
            reconnect: {
              enabled: true,
              maxAttempts: 3,
              delayMs: 2000,
            },
          },
        },
      });
      const all = await client.getTools();
      return all.filter(
        (t) =>
          t.name === FIRECRAWL_SCRAPE_MCP_NAME ||
          t.name === FIRECRAWL_SEARCH_MCP_NAME,
      );
    })();
    return cached;
  };
}

interface ProxyHandlerArgs {
  factory: FirecrawlMcpFactory;
  mcpToolName: string;
  publicToolName: string;
}

/**
 * Build a handler that proxies a validated input through the MCP client.
 * The underlying tool is resolved lazily on the first call and cached.
 */
function buildProxyHandler({
  factory,
  mcpToolName,
  publicToolName,
}: ProxyHandlerArgs): (args: unknown) => Promise<unknown> {
  return async (args) => {
    const mcpTools = await factory();
    const target = mcpTools.find((t) => t.name === mcpToolName);
    if (!target) {
      throw new Error(
        `${publicToolName}: upstream MCP tool "${mcpToolName}" is not exposed by the configured Firecrawl server.`,
      );
    }
    return target.invoke(args);
  };
}

/**
 * Construct the two Firecrawl plugin tools. Each tool's handler proxies
 * the validated input into the upstream MCP server using the supplied
 * factory. Schemas are declared statically so the agent sees a stable
 * tool surface even before the first MCP fetch.
 */
export function createFirecrawlTools(
  factory: FirecrawlMcpFactory,
): PluginTool[] {
  const search = tool(
    async (rawArgs) => {
      const parsed = searchSchema.parse(rawArgs);
      const handler = buildProxyHandler({
        factory,
        mcpToolName: FIRECRAWL_SEARCH_MCP_NAME,
        publicToolName: FIRECRAWL_SEARCH_TOOL,
      });
      return handler(parsed);
    },
    {
      name: FIRECRAWL_SEARCH_TOOL,
      description: SEARCH_DESCRIPTION,
      schema: searchSchema,
    },
  );

  const scrape = tool(
    async (rawArgs) => {
      const parsed = scrapeSchema.parse(rawArgs);
      const handler = buildProxyHandler({
        factory,
        mcpToolName: FIRECRAWL_SCRAPE_MCP_NAME,
        publicToolName: FIRECRAWL_SCRAPE_TOOL,
      });
      return handler(parsed);
    },
    {
      name: FIRECRAWL_SCRAPE_TOOL,
      description: SCRAPE_DESCRIPTION,
      schema: scrapeSchema,
    },
  );

  return [search, scrape];
}
