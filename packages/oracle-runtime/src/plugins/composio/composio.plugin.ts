import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import {
  createComposioTools,
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
    'External SaaS tools (Gmail, GitHub, Linear, Slack, Google Calendar, Notion, Jira, HubSpot, hundreds more) invoked on behalf of the user through Composio.',
  whenToUse: [
    'ALWAYS call `COMPOSIO_MANAGE_CONNECTIONS` first — before calling any other Composio tool — to verify the required toolkit is connected. If the response contains a `redirect_url`, show it as a clickable markdown link and stop; do not attempt the action.',
    'User asks to send, read, or search emails (Gmail, Outlook).',
    'User asks to create or modify issues, pull requests, or stars in a tracker (GitHub, Linear, Jira).',
    'User asks to manage calendar events, files, or documents in a SaaS app.',
    'No native skill covers the requested action — call `COMPOSIO_SEARCH_TOOLS` before giving up.',
  ],
  whenNotToUse: [
    'A native skill or sub-agent already covers the action — prefer the skill.',
    'Normal conversation or general question with no external SaaS interaction.',
    'NEVER write, guess, or fabricate any URL yourself — the only valid auth link is the `redirect_url` returned by `COMPOSIO_MANAGE_CONNECTIONS`. Typing a link from memory is forbidden.',
  ],
  examples: [
    {
      user: 'Create a Linear issue for this bug',
      thought:
        'Must verify Linear is connected before touching any Linear tool.',
      tool: 'COMPOSIO_MANAGE_CONNECTIONS',
      args: { toolkit: 'linear' },
    },
    {
      user: 'Send an email to the team',
      thought:
        'Must verify Gmail is connected before calling any Gmail tool.',
      tool: 'COMPOSIO_MANAGE_CONNECTIONS',
      args: { toolkit: 'gmail' },
    },
  ],
  tags: ['composio', 'integration', 'saas', 'tools'],
  category: 'integration',
  visibility: 'on-demand',
  stability: 'stable',
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
