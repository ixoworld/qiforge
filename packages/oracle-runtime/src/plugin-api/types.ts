import type { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/** Merged Zod-validated env vars (core schema + every loaded plugin's `configSchema`). */
export type MergedConfig = Record<string, unknown>;

/** Plugin-scoped logger. */
export interface Logger {
  log(message: unknown, ...optional: unknown[]): void;
  error(message: unknown, ...optional: unknown[]): void;
  warn(message: unknown, ...optional: unknown[]): void;
  debug?(message: unknown, ...optional: unknown[]): void;
  verbose?(message: unknown, ...optional: unknown[]): void;
  /**
   * Returns a new logger that auto-prefixes records with the given context.
   * Optional — when absent, the same logger is returned unchanged.
   */
  child?(bindings: Record<string, unknown>): Logger;
}

/** LLM role tag used by `ctx.llm.get(role)`. Aligned with current `ModelRole`. */
export type ModelRole = 'main' | 'subagent' | 'utility' | (string & {});

/** Optional fields forwarded to ChatOpenAI when materialising an LLM. */
export type ChatOpenAIFields = Record<string, unknown>;

/** UCAN delegation envelope. */
export interface UcanDelegation {
  readonly raw: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly capabilities?: ReadonlyArray<{ resource: string; action: string }>;
}

/** Per-room secret index. */
export type SecretIndex = Record<
  string,
  { readonly key: string; readonly version?: number }
>;

/** Snapshot of a Matrix room's state events. */
export interface RoomStateSnapshot {
  readonly roomId: string;
  readonly state: ReadonlyArray<unknown>;
}

/** A single Matrix room event. */
export interface MatrixEvent {
  readonly eventId: string;
  readonly type: string;
  readonly content: unknown;
  readonly senderId?: string;
  readonly originServerTs?: number;
}

/** Memory-enriched user context (mirrors `state.userContext`). */
export type UserContextData = Record<string, unknown>;

/** Read-only view over the LangGraph annotation state. */
export interface ReadonlyState {
  readonly messages: readonly BaseMessage[];
  readonly userContext?: UserContextData;
  readonly loadedPlugins?: ReadonlySet<string>;
  readonly [key: string]: unknown;
}

/**
 * Read accessors registered by other plugins via `getSharedState()`.
 * Forks can extend this via declaration merging (e.g. `userProfile`).
 */
export interface SharedAccessors {
  readonly [key: string]: unknown;
}

export type ToolCallEventPayload = Record<string, unknown>;
export type ActionCallEventPayload = Record<string, unknown>;
export type RenderComponentEventPayload = Record<string, unknown>;
export type ReasoningEventPayload = Record<string, unknown>;
export type BrowserToolCallEventPayload = Record<string, unknown>;
export type RouterEventPayload = Record<string, unknown>;
export type MessageCacheInvalidationPayload = Record<string, unknown>;

import type { AgentMiddleware } from 'langchain';
export type { AgentMiddleware };

/**
 * The agent's structured interface to a plugin. Drives Tier-1 prompt
 * composition and powers `list_capabilities` discovery.
 */
export interface PluginManifest {
  /** Human-readable name. */
  title: string;

  /** One-line description shown in the Tier-1 prompt for `always` plugins. */
  summary: string;

  /** Triggers — when the agent should consider this plugin. */
  whenToUse: string[];

  /** Anti-patterns — when the agent should NOT use this plugin. */
  whenNotToUse?: string[];

  /** Few-shot examples teaching the agent how to invoke the plugin. */
  examples?: ManifestExample[];

  /** Categorization for grouping and filtering. */
  tags?: string[];
  category?:
    | 'data'
    | 'communication'
    | 'automation'
    | 'memory'
    | 'integration'
    | 'ui'
    | 'auth'
    | 'observability'
    | 'core';

  /**
   * Discovery and loading mode:
   *  - `always`    — tools bound to agent at boot; listed in Tier-1 prompt.
   *  - `on-demand` — tools NOT bound; manifest discoverable via
   *                  `list_capabilities`; agent calls `load_capability(name)`
   *                  to load.
   *  - `silent`    — invisible to agent; runs as middleware-only.
   *
   * Default: `on-demand`.
   */
  visibility?: 'always' | 'on-demand' | 'silent';

  /** Stability hint surfaced to the agent (`experimental` → warning footnote). */
  stability?: 'stable' | 'beta' | 'experimental';
}

export interface ManifestExample {
  /** Representative user message. */
  user: string;
  /** Optional reasoning. */
  thought?: string;
  /** Tool the agent should call. */
  tool: string;
  /** Tool args. */
  args?: Record<string, unknown>;
}

/**
 * Author-provided prompt customization. Every field is optional — when absent
 * the runtime falls back to its built-in defaults. Authored once, baked into
 * the system prompt at build time.
 */
export interface OraclePromptConfig {
  /**
   * Full replacement of the identity preamble. When set, used verbatim as the
   * opening paragraph. When unset, the composer generates one from
   * `name`/`org`/`description`.
   */
  opening?: string;

  /**
   * Appended to the runtime's operating-principles section. Use for tone,
   * voice, formality, or oracle-specific behavioral hints.
   */
  communicationStyle?: string;

  /**
   * Author-written elevator pitch for what this oracle does. Rendered above
   * the plugin-derived capability list — additive, not a replacement.
   */
  capabilities?: string;
}

/**
 * Developer-facing oracle config. Passed inline to `createOracleApp`. The
 * runtime fills in `entityDid` from the `ORACLE_ENTITY_DID` env var and
 * combines this with bundled defaults to build the internal `OracleIdentity`.
 */
export interface OracleConfig {
  /** Oracle display name. Required. */
  name: string;
  /** Sponsoring organization. Optional — composer falls back gracefully. */
  org?: string;
  /** One-line description of what this oracle is for. */
  description?: string;
  /** Optional prompt customization (opening, communicationStyle, capabilities). */
  prompt?: OraclePromptConfig;
}

/**
 * Identity of the oracle running this plugin. Built by the runtime from
 * `OracleConfig` + `ORACLE_ENTITY_DID` env var. Plugins read it via
 * `PluginContext.identity` / `RuntimeContext` and should treat it as
 * read-only.
 */
export interface OracleIdentity {
  name: string;
  org: string;
  description: string;
  entityDid: string;
  /** Author-provided prompt customization. Undefined when not configured. */
  prompt?: OraclePromptConfig;
}

/**
 * Passed to plugin methods called at request build time
 * (`getTools`, `getSubAgents`, `getMiddlewares`). Lives once per request build.
 *
 * Holds no user, no session, no live socket, no request data.
 */
export interface PluginContext<TConfig = MergedConfig> {
  /** Merged Zod-validated env vars (core + all loaded plugins' configSchemas). */
  config: TConfig;

  /** Identity of this oracle. */
  identity: OracleIdentity;

  /** Set of plugin names currently loaded — drives soft-dep branching. */
  availablePlugins: ReadonlySet<string>;

  /** Plugin-scoped logger (auto-prefixed with the plugin's name). */
  logger: Logger;
}

/**
 * Passed to tool handlers, sub-agent handlers, and to plugin middlewares' hook
 * functions. Built fresh per graph invocation.
 */
export interface RuntimeContext<TConfig = MergedConfig> {
  /** Authenticated user identity (validated by core auth middleware). */
  user: {
    did: string;
    /** e.g. `@did-ixo-ixo1abc:ixo.world`. */
    matrixUserId: string;
    ucanDelegation: UcanDelegation;
    timezone?: string;
    currentTime?: string;
  };

  /** Session info from `SessionsService`. */
  session: {
    /** = `thread_id`; thread root `eventId`. */
    id: string;
    client: 'portal' | 'matrix' | 'slack';
    wsId?: string;
    requestId: string;
    roomId?: string;
  };

  /** Read-only view over the graph state's history. */
  history: {
    messages: readonly BaseMessage[];
    recent: (n: number) => BaseMessage[];
    /** Memory enrichment from existing `state.userContext`. */
    userContext: UserContextData;
    /** Typed view over `Annotation.Root`. */
    state: ReadonlyState;
  };

  /** Same merged Zod-validated env. */
  config: TConfig;

  /** Set of plugin names currently loaded (boot-fixed). */
  availablePlugins: ReadonlySet<string>;

  /** Plugins the agent has loaded for THIS thread via `load_capability`. */
  loadedPlugins: ReadonlySet<string>;

  /** Per-room secrets (JWE-encrypted, 24h cache; today's `SecretsService`). */
  secrets: {
    getIndex: () => Promise<SecretIndex>;
    getValues: (keys: string[]) => Promise<Record<string, string>>;
  };

  /** Matrix client, scoped operations only. */
  matrix: {
    postToRoom: (roomId: string, content: unknown) => Promise<string>;
    getRoomState: (roomId: string) => Promise<RoomStateSnapshot>;
    getEventById: (roomId: string, eventId: string) => Promise<MatrixEvent>;
  };

  /** UCAN authorization helpers. */
  ucan: {
    requireCapability: (resource: string, action: string) => void;
    hasCapability: (resource: string, action: string) => boolean;
    mintInvocation: (
      target: { did: string; capability: string },
      opts?: { skipCache?: boolean },
    ) => Promise<string>;
    /**
     * Resolve a downstream service URL to its did:web identifier. Returns
     * `null` when the document is missing or has no `id` — used by plugins
     * minting service-targeted UCAN invocations.
     */
    resolveServiceDid: (serviceUrl: string) => Promise<string | null>;
  };

  /** LLM provider. */
  llm: {
    get: (role: ModelRole, params?: ChatOpenAIFields) => BaseChatModel;
  };

  /** Typed event emitter (today's `@ixo/oracles-events` 7 event types). */
  emit: {
    toolCall: (payload: ToolCallEventPayload) => void;
    actionCall: (payload: ActionCallEventPayload) => void;
    renderComponent: (payload: RenderComponentEventPayload) => void;
    reasoning: (payload: ReasoningEventPayload) => void;
    browserToolCall: (payload: BrowserToolCallEventPayload) => void;
    router: (payload: RouterEventPayload) => void;
    messageCacheInvalidation: (
      payload: MessageCacheInvalidationPayload,
    ) => void;
  };

  /** Plugin-scoped logger. */
  logger: Logger;

  /** Propagates from the HTTP request / graph invocation. */
  abortSignal: AbortSignal;

  /** Read accessors for state owned by other plugins. */
  shared: SharedAccessors;

  /**
   * Identifier of the inbound tool call that triggered this handler, when
   * available. Undefined for direct/test invocations. Used by tools that
   * return a LangGraph `Command` and need to append a matching `ToolMessage`
   * to the state update.
   */
  toolCallId?: string;
}

export interface PluginTool {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (args: unknown, ctx: RuntimeContext) => Promise<unknown>;
  /** Override visibility — by default inherits from the plugin's `manifest.visibility`. */
  visibility?: 'always' | 'on-demand' | 'silent';
}

export interface PluginSubAgent {
  /** Tool name the agent will see (e.g. `call_memory_agent`). */
  name: string;
  description: string;
  systemPrompt: string | ((ctx: PluginContext) => string);
  tools: PluginTool[] | ((ctx: PluginContext) => PluginTool[]);
  /** LLM role; default `subagent`. */
  model?: ModelRole;
  /** Sub-agent-scoped middleware (e.g. summarization for long conversations). */
  middlewares?: AgentMiddleware[];
  /**
   * Forward this sub-agent's internal tool calls + results into the parent
   * graph's message history so the UI renders them in the main chat.
   *
   *   - `true` → forward ALL of this sub-agent's own tools
   *   - `false` / omitted → forward nothing
   *   - `string[]` → forward only the listed tool names
   *
   * Runtime-injected passthrough tools (e.g. memory CRUD) are never
   * forwarded — they're already on the main agent.
   */
  forwardTools?: boolean | string[];
  /** Called after sub-agent completes; can emit follow-up events. */
  onComplete?: (result: string, ctx: RuntimeContext) => Promise<void>;
}
