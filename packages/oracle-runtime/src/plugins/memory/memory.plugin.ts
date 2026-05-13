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
  DEFAULT_MEMORY_TOOLS,
  fetchMemoryTools,
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
  tags: ['memory', 'recall', 'personalization'],
  category: 'memory',
  visibility: 'always',
  stability: 'stable',
};

/** No-op reader — returned when the middleware has no upstream wired in. */
const NOOP_READER: UserContextReader = {
  get: async () => undefined,
};

export interface MemoryPluginOptions {
  /**
   * Override the MCP-tools factory. Defaults to an HTTP MCP client against
   * `MEMORY_MCP_URL` authenticated with a per-request UCAN invocation.
   */
  mcpFactory?: (memoryMcpUrl: string) => MemoryMcpFactory;
  /**
   * Filter the upstream tool surface. Defaults to {@link DEFAULT_MEMORY_TOOLS}
   * (search + add + delete-episode). Pass an explicit list to expose
   * `clear`, `add_oracle_knowledge`, etc.
   */
  selectedTools?: readonly string[];
  /**
   * Optional reader the middleware uses to populate `state.userContext`
   * before the first model call.
   */
  userContextReader?: UserContextReader;
}

function resolveMemoryUrl(config: MergedConfig): string {
  const parsed = configSchema.parse(config);
  return parsed.MEMORY_MCP_URL;
}

/**
 * Memory plugin. Surfaces upstream Memory Engine MCP tools directly — the
 * agent sees the upstream names (`memory-engine__search_memory_engine`,
 * `memory-engine__add_memory`, ...) with the upstream's own schemas. This
 * matches the apps/app pattern that worked in production and avoids
 * schema-mismatch failures from a local wrapper layer.
 *
 * Tool list is fetched per-request via `getRequestTools` because the MCP
 * headers depend on the in-flight user's UCAN delegation.
 *
 * The runtime forwards memory tools into every sub-agent's tool list
 * (filter in `main-agent.ts`), except `memory-engine__clear` — destructive,
 * main-agent-only.
 */
export class MemoryPlugin extends OraclePlugin {
  static readonly NAME = 'memory';

  readonly name = MemoryPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'MEMORY_MCP_URL';

  private readonly mcpFactory: (memoryMcpUrl: string) => MemoryMcpFactory;

  private readonly selectedTools: readonly string[];

  private readonly userContextReader: UserContextReader;

  constructor(options: MemoryPluginOptions = {}) {
    super();
    this.mcpFactory = options.mcpFactory ?? createDefaultMemoryMcpFactory;
    this.selectedTools = options.selectedTools ?? DEFAULT_MEMORY_TOOLS;
    this.userContextReader = options.userContextReader ?? NOOP_READER;
  }

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.MEMORY_MCP_URL);
  }

  override async getRequestTools(
    rtCtx: RuntimeContext,
  ): Promise<PluginTool[]> {
    const memoryUrl = resolveMemoryUrl(rtCtx.config);
    const factory = this.mcpFactory(memoryUrl);
    return fetchMemoryTools(rtCtx, factory, this.selectedTools);
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
