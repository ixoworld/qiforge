import { z } from 'zod';
import { OraclePlugin, type PluginEnv } from '../../plugin-api/oracle-plugin';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types';
import {
  createComposioTools,
  type ComposioDefsCache,
  type ComposioSessionFactory,
} from './composio-tools';
import { mintComposioInvocation } from './composio-ucan';
import { SANDBOX_CAPABILITY } from '../delegated-capabilities';

const configSchema = z.object({
  COMPOSIO_API_KEY: z.string().min(1, 'COMPOSIO_API_KEY must not be empty.'),
  COMPOSIO_BASE_URL: z
    .string()
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
    'Discover Composio integrations and inspect their input schemas. Only COMPOSIO_SEARCH_TOOLS and COMPOSIO_GET_TOOL_SCHEMAS are callable until a verified transport without automatic execution retries is available.',
  whenToUse: [
    'Discover an integration with `COMPOSIO_SEARCH_TOOLS`, describing the desired action in natural language.',
    'Inspect exact input schemas with `COMPOSIO_GET_TOOL_SCHEMAS` after discovering the tool slugs.',
    'Explain available integration capabilities without invoking the discovered app tools.',
  ],
  whenNotToUse: [
    'Executing an app tool, managing connections, or running `COMPOSIO_MULTI_EXECUTE_TOOL`: the installed SDK can retry consequential calls internally, so execution is blocked until a verified transport without automatic execution retries is available.',
    'A native skill or sub-agent already covers the action more precisely — prefer the skill.',
    'Scraping a complex page that needs JavaScript rendering or main-content extraction — use the Firecrawl sub-agent instead.',
    'IXO entity lookups — use the Domain Indexer.',
    'Normal conversation or general question with no search or external SaaS interaction.',
  ],
  examples: [
    {
      user: 'Which Composio integration can look up financial prices?',
      thought: 'Discover available tools without executing them.',
      tool: 'COMPOSIO_SEARCH_TOOLS',
      args: {
        query: 'search the web for live financial / crypto market prices',
      },
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
  requires: [SANDBOX_CAPABILITY],
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

  override autoDetect(env: PluginEnv): boolean {
    return (
      typeof env.COMPOSIO_API_KEY === 'string' &&
      env.COMPOSIO_API_KEY.length > 0
    );
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
        logger: rtCtx.logger,
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
