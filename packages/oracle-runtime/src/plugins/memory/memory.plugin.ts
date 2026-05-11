import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  MergedConfig,
  PluginContext,
  PluginManifest,
  PluginTool,
  RuntimeContext,
  UserContextData,
} from '../../plugin-api/types.js';
import {
  createMemoryMiddleware,
  type UserContextReader,
} from './memory-middleware.js';
import {
  createDefaultMemoryMcpFactory,
  createMemoryTools,
  type MemoryMcpFactory,
} from './memory-tools.js';

const configSchema = z.object({
  MEMORY_MCP_URL: z.string().url('MEMORY_MCP_URL must be a valid HTTP(S) URL.'),
  MEMORY_ENGINE_URL: z
    .string()
    .url('MEMORY_ENGINE_URL must be a valid HTTP(S) URL.'),
});

const manifest: PluginManifest = {
  title: 'Memory',
  summary:
    'Long-term memory of user facts, preferences, and prior conversations via the Memory Engine.',
  whenToUse: [
    'Recall durable facts the user shared in a past conversation.',
    'Save a new fact, preference, or relationship the user wants the agent to remember.',
    'The user references something they told the agent before.',
  ],
  whenNotToUse: [
    'Volatile session-only state (use the current message thread).',
    'Public web facts (use Firecrawl).',
  ],
  examples: [
    {
      user: 'Remember that I prefer dark mode.',
      tool: 'save_memory',
      args: { content: 'User prefers dark mode for UI surfaces.' },
    },
    {
      user: 'What did I say about my morning routine last week?',
      tool: 'search_memory',
      args: { query: 'morning routine' },
    },
  ],
  tags: ['memory', 'recall', 'personalization'],
  category: 'memory',
  visibility: 'always',
  stability: 'stable',
};

/** No-op reader — returned when the middleware has no upstream wired in. */
const NOOP_READER: UserContextReader = {
  get: async () => undefined,
};

/** Optional dependency injection — primarily for tests. */
export interface MemoryPluginOptions {
  /**
   * Override the MCP-tools factory. Defaults to a Memory-Engine MCP HTTP
   * client built from `MEMORY_MCP_URL` and authenticated with the per-call
   * UCAN invocation. Tests pass a stub so the plugin never touches the
   * network.
   */
  mcpFactory?: (memoryMcpUrl: string) => MemoryMcpFactory;
  /**
   * Optional reader the middleware uses to populate `state.userContext`
   * before the first model call. Forks that source userContext from the
   * session (the apps/app pattern) leave this unset — the caller hydrates
   * `state.userContext` directly when invoking the agent.
   */
  userContextReader?: UserContextReader;
}

function resolveMemoryUrl(config: MergedConfig): string {
  const parsed = configSchema.parse(config);
  return parsed.MEMORY_MCP_URL;
}

/**
 * Memory plugin. Exposes the five memory tools (`search_memory`,
 * `save_memory`, `read_memory`, `delete_memory`, `clear_memory`) directly on
 * the main agent — no sub-agent. The runtime's passthrough filter (in
 * `createMainAgent`) forwards the four non-destructive tools into every
 * sub-agent's tool list as well, so any sub-agent can recall or save memory
 * without round-tripping through the main agent.
 *
 * `clear_memory` is intentionally bound to the main agent only. The runtime
 * filter excludes it from the passthrough — destructive ops require explicit
 * user consent in the active turn.
 *
 * UCAN minting goes through `ctx.ucan.resolveServiceDid` +
 * `ctx.ucan.mintInvocation` — the plugin never builds did:web inline.
 */
export class MemoryPlugin extends OraclePlugin {
  /**
   * Static handle used by the runtime to filter memory tools off the main
   * agent's collected tool list for sub-agent passthrough. Keeping the name
   * on the class avoids hardcoding the string in `main-agent.ts`.
   */
  static readonly NAME = 'memory';

  readonly name = MemoryPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'MEMORY_MCP_URL';

  private readonly mcpFactory: (memoryMcpUrl: string) => MemoryMcpFactory;

  private readonly userContextReader: UserContextReader;

  constructor(options: MemoryPluginOptions = {}) {
    super();
    this.mcpFactory = options.mcpFactory ?? createDefaultMemoryMcpFactory;
    this.userContextReader = options.userContextReader ?? NOOP_READER;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.MEMORY_MCP_URL);
  }

  override getTools(ctx: PluginContext): PluginTool[] {
    const memoryUrl = resolveMemoryUrl(ctx.config);
    const factory = this.mcpFactory(memoryUrl);
    return createMemoryTools(factory);
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [
      createMemoryMiddleware({
        reader: this.userContextReader,
        logger: ctx.logger,
      }),
    ];
  }

  override getSharedState(): Record<
    string,
    (state: { userContext?: UserContextData }, runCtx: RuntimeContext) => unknown
  > {
    return {
      userProfile: (state) => state.userContext,
    };
  }
}
