import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  MergedConfig,
  PluginManifest,
  PluginTool,
  RuntimeContext,
  UserContextData,
} from '../../plugin-api/types.js';
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
    'Durable memory across conversations: who the user is, what you have made for them, and what worked.',
  whenToUse: [
    'First contact (no prior context loaded): greet, ask their name and what they want help with, then save what they tell you.',
    'You learn something durable about the user — name, role, ongoing project, a constraint, a relationship.',
    'You create an artifact for the user (file, document, edit, generated content): record what it is, what it is for, and the structural choices you made.',
    'The user expresses satisfaction or dissatisfaction with something you produced: capture what worked or what did not — tone, length, structure, style — against that artifact entry.',
    'The user references something they told you before, or something you made before.',
  ],
  whenNotToUse: [
    'Ephemeral conversation-only state (use the current message thread).',
    'Behavioral preferences about how to respond (call the user-preferences tool instead).',
    'Public web facts that are not specific to this user (use a web-search capability).',
    'Anything the user asked you to forget or framed as temporary.',
  ],
  tags: ['memory', 'recall', 'artifacts', 'personalization'],
  category: 'memory',
  visibility: 'always',
  stability: 'stable',
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

  constructor(options: MemoryPluginOptions = {}) {
    super();
    this.mcpFactory = options.mcpFactory ?? createDefaultMemoryMcpFactory;
    this.selectedTools = options.selectedTools ?? DEFAULT_MEMORY_TOOLS;
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

  override getSharedState(): Record<
    string,
    (state: { userContext?: UserContextData }, runCtx: RuntimeContext) => unknown
  > {
    return {
      userProfile: (state) => state.userContext,
    };
  }
}
