import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import {
  createComposioTools,
  type ComposioDefsCache,
  type ComposioSessionFactory,
} from './composio-tools.js';
import { mintComposioInvocation } from './composio-ucan.js';

const configSchema = z.object({
  COMPOSIO_API_KEY: z.string().min(1, 'COMPOSIO_API_KEY must not be empty.'),
  COMPOSIO_BASE_URL: z
    .url('COMPOSIO_BASE_URL must be a valid HTTP(S) URL.')
    .default('https://composio.ixo.earth'),
});

/**
 * Sibling env vars the plugin reads but does not own. `NETWORK` is declared
 * in the core base schema; the plugin forwards it as `x-ixo-network` when
 * present so the composio-worker can route to the right IXO environment.
 */
const siblingEnvSchema = z.object({
  NETWORK: z.string().optional(),
});

const manifest: PluginManifest = {
  title: 'Composio',
  summary:
    'Hundreds of integrations in one plugin: web search, news, finance, academic research, Gmail, GitHub, Linear, Slack, Google Calendar, Notion, Jira, HubSpot, and much more — all invoked on behalf of the user through Composio. When in doubt, Composio likely has a tool for it.',
  whenToUse: [
    'Composio exposes only a few directly-callable meta-tools: `COMPOSIO_MANAGE_CONNECTIONS` (auth), `COMPOSIO_SEARCH_TOOLS` (discover), and `COMPOSIO_MULTI_EXECUTE_TOOL` (run). Specific app tools (e.g. `GMAIL_SEND_EMAIL`, `COMPOSIO_SEARCH_FINANCE`) are NOT directly callable — discover them first, then run them through `COMPOSIO_MULTI_EXECUTE_TOOL`.',
    'Standard flow: (1) for any connected-app action call `COMPOSIO_MANAGE_CONNECTIONS` with the toolkit FIRST — if it returns a `redirect_url`, show it as a clickable markdown link and stop; (2) call `COMPOSIO_SEARCH_TOOLS`, describing the action in natural language, to find the exact tool slug(s); (3) if unsure of a tool’s parameters, call `COMPOSIO_GET_TOOL_SCHEMAS` with those slugs to fetch their exact input schema; (4) call `COMPOSIO_MULTI_EXECUTE_TOOL` to execute.',
    'CRITICAL — `COMPOSIO_MULTI_EXECUTE_TOOL` args are EXACTLY `{ "tools": [{ "tool_slug": "<SLUG>", "arguments": { ... } }], "sync_response_to_workbench": false }` and nothing else — no `session`, `id`, or other top-level keys. NEVER pass a tool name as a top-level key (e.g. `{ "COMPOSIO_SEARCH_FINANCE": {...} }`); always wrap each call inside the `tools` array as `tool_slug` + `arguments`.',
    'Web, news, finance, academic, and trend searches — and fetching the readable content of a URL — live in the `COMPOSIO_SEARCH_*` family. They need no connection: discover the one you want via `COMPOSIO_SEARCH_TOOLS`, then run it through `COMPOSIO_MULTI_EXECUTE_TOOL`.',
    'Email, calendar, issue trackers, docs, CRMs (Gmail, Outlook, Google Calendar, GitHub, Linear, Jira, Notion, Slack, HubSpot, …): verify the connection, discover the tool, then execute.',
    'No native skill covers the requested action — discover what Composio offers with `COMPOSIO_SEARCH_TOOLS` before giving up.',
  ],
  whenNotToUse: [
    'A native skill or sub-agent already covers the action more precisely — prefer the skill.',
    'Scraping a complex page that needs JavaScript rendering or main-content extraction — use the Firecrawl sub-agent instead.',
    'IXO entity lookups — use the Domain Indexer.',
    'Normal conversation or general question with no search or external SaaS interaction.',
    'NEVER write, guess, or fabricate any URL yourself — the only valid auth link is the `redirect_url` returned by `COMPOSIO_MANAGE_CONNECTIONS`. Typing a link from memory is forbidden.',
  ],
  examples: [
    {
      user: 'What is the current Bitcoin price?',
      thought:
        'A search task — no connection needed. Discover the right search tool first.',
      tool: 'COMPOSIO_SEARCH_TOOLS',
      args: {
        query: 'search the web for live financial / crypto market prices',
      },
    },
    {
      user: '(after COMPOSIO_SEARCH_TOOLS surfaces COMPOSIO_SEARCH_FINANCE)',
      thought:
        'Run the discovered tool through the multi-execute meta-tool — wrapped in the tools array, never as a top-level key.',
      tool: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      args: {
        tools: [
          {
            tool_slug: 'COMPOSIO_SEARCH_FINANCE',
            arguments: { query: 'Bitcoin price USD today' },
          },
        ],
        sync_response_to_workbench: false,
      },
    },
    {
      user: 'Create a Linear issue for this bug',
      thought:
        'A SaaS action — verify Linear is connected before discovering or running any Linear tool.',
      tool: 'COMPOSIO_MANAGE_CONNECTIONS',
      args: { toolkit: 'linear' },
    },
    {
      user: 'Send an email to the team',
      thought:
        'A SaaS action — verify Gmail is connected first, then discover GMAIL_SEND_EMAIL and run it via COMPOSIO_MULTI_EXECUTE_TOOL.',
      tool: 'COMPOSIO_MANAGE_CONNECTIONS',
      args: { toolkit: 'gmail' },
    },
  ],
  tags: [
    'composio',
    'integration',
    'saas',
    'tools',
    'web-search',
    'news',
    'finance',
  ],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'stable',
  permissions: { ucan: { invoke: true } },
};

export interface ComposioPluginOptions {
  /**
   * Override the session factory — primarily for tests so they can skip the
   * real `@composio/core` client and the network call it makes.
   */
  sessionFactory?: ComposioSessionFactory;
  /**
   * Override the UCAN minting step — primarily for tests so they can return
   * a fixed token without invoking the real UCAN service.
   */
  mintInvocation?: (
    runCtx: RuntimeContext,
    baseUrl: string,
  ) => Promise<string | null>;
}

/**
 * Composio plugin.
 *
 * Tools are discovered dynamically per request: the plugin mints a UCAN
 * invocation addressed to the composio-worker, opens a session for the
 * current user, and exposes each returned tool to the agent.
 *
 * Auth is UCAN-only — no Matrix-OpenID fallback. If minting fails (no
 * signing key, no cached delegation, did:web unresolved) the plugin
 * contributes zero tools and the agent simply does not see composio that
 * request. Visibility is `on-demand` so the plugin is discoverable via
 * `list_capabilities` rather than burning prompt budget every call.
 */
export class ComposioPlugin extends OraclePlugin {
  readonly name = 'composio';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'COMPOSIO_API_KEY';

  private readonly sessionFactoryOverride?: ComposioSessionFactory;
  private readonly mintInvocationOverride?: (
    runCtx: RuntimeContext,
    baseUrl: string,
  ) => Promise<string | null>;

  /**
   * Per-user session tool definitions. Warm entries let `createComposioTools`
   * skip the session-open + tools-list round-trips on the chat hot path and
   * open the session lazily on first invocation instead.
   */
  private readonly toolDefsCache: ComposioDefsCache = new Map();

  constructor(opts: ComposioPluginOptions = {}) {
    super();
    this.sessionFactoryOverride = opts.sessionFactory;
    this.mintInvocationOverride = opts.mintInvocation;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.COMPOSIO_API_KEY);
  }

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    const parsed = configSchema.safeParse(rtCtx.config);
    if (!parsed.success) {
      rtCtx.logger.warn(
        `[composio] skipping — invalid configuration: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
      return [];
    }

    const siblings = siblingEnvSchema.safeParse(rtCtx.config);
    const network = siblings.success ? siblings.data.NETWORK : undefined;

    const mint = this.mintInvocationOverride ?? mintComposioInvocation;
    const ucanInvocation = await mint(rtCtx, parsed.data.COMPOSIO_BASE_URL);
    if (!ucanInvocation) {
      rtCtx.logger.warn(
        '[composio] skipping — UCAN invocation could not be minted.',
      );
      return [];
    }

    try {
      return await createComposioTools({
        apiKey: parsed.data.COMPOSIO_API_KEY,
        baseUrl: parsed.data.COMPOSIO_BASE_URL,
        ucanInvocation,
        userId: rtCtx.user.did,
        network,
        sessionFactory: this.sessionFactoryOverride,
        defsCache: this.toolDefsCache,
      });
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      rtCtx.logger.error(`[composio] failed to load tools: ${detail}`);
      return [];
    }
  }
}
