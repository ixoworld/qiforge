import { z } from 'zod';
import { OraclePlugin, type PluginEnv } from '../../plugin-api/oracle-plugin';
import { MEMORY_CAPABILITY } from '../delegated-capabilities';
import type {
  MergedConfig,
  PluginManifest,
  PluginTool,
  RuntimeContext,
  UserContextData,
} from '../../plugin-api/types';
import {
  createDefaultMemoryMcpFactory,
  DEFAULT_MEMORY_TOOLS,
  fetchMemoryTools,
  type MemoryMcpFactory,
} from './memory-tools';
import { oracleEntityDidSchema } from './memory-entity';
import { createOracleDocumentTools } from './oracle-document-tools';

const configSchema = z.object({
  MEMORY_MCP_URL: z.string().url('MEMORY_MCP_URL must be a valid HTTP(S) URL.'),
  MEMORY_ENGINE_URL: z
    .string()
    .url('MEMORY_ENGINE_URL must be a valid HTTP(S) URL.'),
  // The Memory Engine keys every space by the oracle's domain entity; an
  // oracle without one gets no memory at all, so it fails at boot instead.
  ORACLE_ENTITY_DID: oracleEntityDidSchema,
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
    'A controller or owner of this oracle TYPES into the chat something every user of the oracle should know (a policy, a procedure, reference material): tell them it will be shared with every user of the oracle (or, for the private space, with the members of the domain only: its controllers, owner, admins and DAO members), get their confirmation, then store it as oracle knowledge rather than as a memory about them. This line is only for knowledge typed in the chat.',
    'A controller or owner of this oracle hands you a file (an attachment or a Library file) and asks you to store it as oracle knowledge: a file the person attached or a Library file ALWAYS goes to add_oracle_document, never to add_oracle_knowledge, even when its text is visible in the conversation. If the file is one coherent record (a board resolution, a contract, a report) group it as a document (group_as_document true); if it is a file where someone dumped many unrelated company facts to upload them easily, store it as loose facts (group_as_document false). When it is not obvious which, ask the person first, and always confirm the public or private space with them before writing. list_oracle_documents and delete_oracle_document show and remove grouped documents.',
  ],
  whenNotToUse: [
    'Ephemeral conversation-only state (use the current message thread).',
    'Behavioral preferences about how to respond (call the user-preferences tool instead).',
    'Public web facts that are not specific to this user (use a web-search capability).',
    'Anything the user asked you to forget or framed as temporary.',
    'Oracle knowledge for something about one user: the shared knowledge is only for what every user of this oracle should know.',
    'Storing a file the person did not ask you to store as oracle knowledge, or choosing between a grouped document and loose facts without asking when the file could be either.',
  ],
  tags: ['memory', 'recall', 'artifacts', 'personalization'],
  category: 'memory',
  visibility: 'always',
  stability: 'stable',
  requires: [MEMORY_CAPABILITY],
};

export interface MemoryPluginOptions {
  /**
   * Override the MCP-tools factory. Defaults to an HTTP MCP client against
   * `MEMORY_MCP_URL` authenticated with a per-request UCAN invocation and
   * the oracle's domain entity (`ORACLE_ENTITY_DID`, the engine's
   * `x-oracle-entity-did` header).
   */
  mcpFactory?: (memoryMcpUrl: string, entityDid: string) => MemoryMcpFactory;
  /**
   * Filter the upstream tool surface. Defaults to {@link DEFAULT_MEMORY_TOOLS}
   * (search + add + add-oracle-knowledge + delete-episode + clear). Pass an
   * explicit list to drop one of them or to expose `delete_edge`.
   */
  selectedTools?: readonly string[];
  /**
   * Surface `add_oracle_document`, `list_oracle_documents` and
   * `delete_oracle_document` next to the upstream tools (default true). They
   * talk to `MEMORY_ENGINE_URL` directly and are not part of
   * {@link selectedTools}, and appear only when the upstream tools do (a user
   * without a memory delegation gets neither). Pass `false` to keep documents
   * out of the oracle.
   */
  documentTools?: boolean;
}

function resolveMemoryConfig(config: MergedConfig): {
  memoryMcpUrl: string;
  entityDid: string;
} {
  const parsed = configSchema.parse(config);
  return {
    memoryMcpUrl: parsed.MEMORY_MCP_URL,
    entityDid: parsed.ORACLE_ENTITY_DID,
  };
}

/**
 * Memory plugin. Surfaces upstream Memory Engine MCP tools directly — the
 * agent sees the upstream names (`memory-engine__search_memory_engine`,
 * `memory-engine__add_memory`, ...) with the upstream's own schemas. This
 * matches the pattern that worked in production and avoids schema-mismatch
 * failures from a local wrapper layer.
 *
 * Tool list is fetched per-request via `getRequestTools` because the MCP
 * headers depend on the in-flight user's UCAN delegation.
 */
export class MemoryPlugin extends OraclePlugin {
  static readonly NAME = 'memory';

  readonly name = MemoryPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override readonly autoDetectHint = 'MEMORY_MCP_URL';

  private readonly mcpFactory: (
    memoryMcpUrl: string,
    entityDid: string,
  ) => MemoryMcpFactory;

  private readonly selectedTools: readonly string[];

  private readonly documentTools: boolean;

  constructor(options: MemoryPluginOptions = {}) {
    super();
    this.mcpFactory = options.mcpFactory ?? createDefaultMemoryMcpFactory;
    this.selectedTools = options.selectedTools ?? DEFAULT_MEMORY_TOOLS;
    this.documentTools = options.documentTools ?? true;
  }

  override autoDetect(env: PluginEnv): boolean {
    return (
      typeof env.MEMORY_MCP_URL === 'string' && env.MEMORY_MCP_URL.length > 0
    );
  }

  override async getRequestTools(rtCtx: RuntimeContext): Promise<PluginTool[]> {
    const { memoryMcpUrl, entityDid } = resolveMemoryConfig(rtCtx.config);
    const factory = this.mcpFactory(memoryMcpUrl, entityDid);
    const mcpTools = await fetchMemoryTools(rtCtx, factory, this.selectedTools);
    // The document tools come first so a file never lands on the upstream
    // add_oracle_knowledge by position.
    // No upstream tools means memory is unavailable for this user (no
    // delegation, unresolved service DID): the document tools would only
    // answer "not reachable", so they are left out too.
    return this.documentTools && mcpTools.length > 0
      ? [...createOracleDocumentTools(), ...mcpTools]
      : mcpTools;
  }

  override getSharedState(): Record<
    string,
    (
      state: { userContext?: UserContextData },
      runCtx: RuntimeContext,
    ) => unknown
  > {
    return {
      userProfile: (state) => state.userContext,
    };
  }
}
