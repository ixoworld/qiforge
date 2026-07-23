import type { RequestMethod } from '@nestjs/common';
import type { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Route shape returned by `OraclePlugin.getAuthExcludedRoutes()`. Mirrors the
 * NestJS `RouteInfo` accepted by `MiddlewareConsumer.exclude(...)` so the
 * runtime can pass these straight through.
 */
export interface AuthExcludedRoute {
  /** Path under the plugin's controller, e.g. `weather/now`. Leading slash optional. */
  path: string;
  /** HTTP method. Defaults to `RequestMethod.ALL` when omitted. */
  method?: RequestMethod;
}

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

/** Which commerce persona a Matrix turn runs as. */
export type CommerceMode = 'support' | 'work';

/** Lifecycle of a thread-scoped work engagement. */
export type CommerceEngagementStatus = 'active' | 'delivered' | 'closed';

/**
 * A thread-scoped work engagement: one per Matrix thread, keyed by the thread
 * root event id (= session id). Stored in the room's state by the
 * oracle-payments plugin; surfaced read-only on `ctx.commerce.engagement`.
 */
export interface CommerceEngagement {
  status: CommerceEngagementStatus;
  serviceId: string;
  serviceName: string;
  priceUsd: number;
  collectionId: string;
  adminAddress: string;
  /** ISO timestamp of engagement start. */
  startedAt: string;
  /**
   * ISO timestamp of a user cancellation (`cancel_work`). Stamped when the
   * cancellation is requested, before its release claim reaches the chain — an
   * engagement that still reads `active` while carrying this timestamp is one
   * whose release failed and needs another `cancel_work`.
   */
  cancelledAt?: string;
  /** Free-text reason the user gave `cancel_work`, when any. */
  cancelReason?: string;
  /**
   * Escrow intent locked on-chain at engagement start. `expiresAt` is the
   * derived deadline (start + the grant's `intentDurationNs`) after which the
   * reserved amount auto-releases. Expiry is the passive cleanup; the active
   * one is a claim — submitting any claim against the intent (a delivery, or
   * the release claim `cancel_work` files) settles it immediately.
   */
  intent?: { txHash: string; submittedAt: string; expiresAt?: string };
  /** Work claim recorded by `deliver_work` (set by a later lane). */
  claim?: { cid: string; txHash?: string; submittedAt: string };
  /**
   * The evaluation outcome already reported to the user in chat, stamped by
   * the claim-status watcher. Its `status` is the raw on-chain
   * `EvaluationStatus`, so a re-evaluation (a flagged claim later resolved)
   * posts a second card while an unchanged status never re-posts.
   */
  paymentOutcome?: {
    status: number;
    outcome: CommercePaymentOutcome;
    reportedAt: string;
  };
}

/**
 * How a submitted claim was settled, as rendered on the `payment_update` card.
 * `under_review` is the chain's non-terminal FLAGGED status; `rejected` covers
 * both a rejected and an invalidated claim — either way the escrow goes back.
 */
export type CommercePaymentOutcome =
  | 'approved'
  | 'rejected'
  | 'under_review'
  | 'disputed';

/**
 * Why a work-classified turn did not start an engagement. The first four are
 * contract-gate failures (the user needs to contract or fix their contract);
 * the last two are different in kind — the contract is fine, but the user
 * already has a job running (`engagement_in_progress`) or the on-chain payment
 * reservation itself failed (`intent_failed`).
 */
export type CommerceGateFailureReason =
  | 'not_contracted'
  | 'quota_exhausted'
  | 'max_amount_too_low'
  | 'service_not_contracted'
  | 'engagement_in_progress'
  | 'intent_failed';

/**
 * The job already running when a new one is refused with
 * `engagement_in_progress`. The chain accepts one active claim intent per
 * (agent, user claim collection), so a user can have exactly one paid job with
 * an oracle at a time — a second reservation could never be locked.
 */
export interface CommerceInProgressEngagement {
  serviceId: string;
  serviceName: string;
  /**
   * Thread root event id the running job lives in — the only thread its
   * `cancel_work` can be called from.
   */
  threadId: string;
  /**
   * The user already cancelled this job but its on-chain release did not land,
   * so the reservation is still held. Retrying `cancel_work` in that thread
   * completes the release; nothing else frees it before expiry.
   */
  releaseFailed?: boolean;
}

/** Gate-failure context attached when a work request lacked a usable contract. */
export interface CommerceGateFailure {
  reason: CommerceGateFailureReason;
  serviceId: string;
  /** Display name of the requested service, when the agent card provides one. */
  serviceName?: string;
  /** The blocking job — present only for `engagement_in_progress`. */
  inProgress?: CommerceInProgressEngagement;
}

/**
 * Per-turn commerce routing outcome, produced by the Matrix message router
 * and threaded into `RuntimeContext.commerce`. Absent entirely on HTTP turns
 * and on Matrix turns where the commerce router is inert (no oracle-payments
 * plugin registered).
 */
export interface CommerceContext {
  mode: CommerceMode;
  /** The thread's active engagement — present in work mode. */
  engagement?: CommerceEngagement;
  /** Present when the user asked for work but the contract gate failed. */
  gate?: CommerceGateFailure;
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

  /**
   * Free-form standing guidance injected verbatim into the system prompt under
   * a dedicated `## Custom Instructions` section. Use for house style, domain
   * rules, guardrails, or anything that doesn't fit `communicationStyle` (tone)
   * or `capabilities` (the elevator pitch). The runtime renders the section
   * only when there is content; it also routes operating guides contributed by
   * loaded on-demand capabilities (e.g. the Flow Builder guide) through the
   * same section, appended after the author's text.
   */
  customInstructions?: string;
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

  /**
   * Short-TTL keyed value store for content the LLM should never relay
   * verbatim (UCAN invocation CARs, JWTs, signed envelopes, etc.). A
   * producing tool stores the value and returns a short hex blobId; a
   * consuming tool looks the value up server-side and forwards it on. Blobs
   * are namespaced by issuing user DID — cross-user reads always miss.
   */
  blobStore: {
    /** Store a value and return a fresh `blob_<16 hex>` id. TTL clamped to
     * the service's `MAX_TTL_SECONDS` (24h); defaults to `DEFAULT_TTL_SECONDS`
     * (1h) when omitted. Pass `userDid` from a trusted source — never from
     * LLM-supplied arguments. */
    put: (params: {
      userDid: string;
      name: string;
      value: string;
      ttlSeconds?: number;
    }) => Promise<string>;
    /** Retrieve a blob by id, scoped to the requesting user. Returns `null`
     * if the blob doesn't exist, has expired, or belongs to a different user. */
    get: (params: {
      userDid: string;
      blobId: string;
    }) => Promise<{ name: string; value: string } | null>;
    /** Lightweight format check (`blob_<16 hex>`). Use in tool input handlers
     * to reject malformed IDs before paying for a cache lookup. */
    isValidBlobId: (value: unknown) => value is string;
  };

  /** Matrix client, scoped operations only. */
  matrix: {
    postToRoom: (roomId: string, content: unknown) => Promise<string>;
    /**
     * Post a timeline event with a caller-chosen event type (e.g. the
     * `ixo.oracle.*` protocol events). `postToRoom` is the `m.room.message`
     * shorthand; this is the general form. Returns the new event id.
     */
    postEvent: (
      roomId: string,
      eventType: string,
      content: object,
    ) => Promise<string>;
    getRoomState: (roomId: string) => Promise<RoomStateSnapshot>;
    getEventById: (roomId: string, eventId: string) => Promise<MatrixEvent>;
  };

  /** UCAN authorization helpers. */
  ucan: {
    requireCapability: (resource: string, action: string) => void;
    hasCapability: (resource: string, action: string) => boolean;
    mintInvocation: (
      target: { did: string; capability: string },
      opts?: { skipCache?: boolean; can?: string },
    ) => Promise<string>;
    /**
     * Resolve a downstream service URL to its did:web identifier. Returns
     * `null` when the document is missing or has no `id` — used by plugins
     * minting service-targeted UCAN invocations.
     */
    resolveServiceDid: (serviceUrl: string) => Promise<string | null>;
    /**
     * `true` once the oracle has loaded its Ed25519 signing mnemonic. Plugins
     * gate registration of mint-capable tools on this — without a key, minting
     * is a no-op and the tool should surface an error rather than pretend.
     */
    hasSigningKey: () => boolean;
    /**
     * Mint a UCAN invocation from a directly-supplied delegation CAR (rather
     * than a per-user cached one). Used by the editor's `mint_invocation`
     * tool: it reads the CAR from a flow's Y.Doc by CID and re-mints a fresh
     * single-use invocation targeted at a specific service route.
     */
    createInvocationFromDelegation: (
      delegationCar: string,
      serviceUrl: string,
      capability: { can: string; with: string },
      options?: { maxTtlSeconds?: number },
    ) => Promise<{ invocation: string } | { error: string }>;
    /**
     * Mint a SELF-SIGNED invocation — issued by this oracle with NO proof
     * chain — for calling a downstream service AS THE ORACLE ITSELF (not on a
     * user's behalf). Returns `{ invocation }` on success or `{ error }` with a
     * surfaced-verbatim reason (signing key missing, did:web unreachable, etc.).
     */
    mintSelfSignedInvocation: (
      serviceUrl: string,
      capability: { can: string; with: string },
      options?: { maxTtlSeconds?: number },
    ) => Promise<{ invocation: string } | { error: string }>;
    /**
     * Fetch, from the UCAN Store Worker, a delegation the user deposited for
     * this oracle over `opts.resource`. Selects the newest active delegation
     * whose capability covers `opts.requiredAbility`. Returns `{ token, with }`
     * on success or `{ error }` — `'no-delegation'` when none satisfies the
     * request, `'store-error'` (with `detail`) for auth / network / store
     * failures.
     */
    getServiceDelegation: (
      userDid: string,
      opts: { storeUrl: string; resource: string; requiredAbility: string },
    ) => Promise<
      | { token: string; with: string }
      | { error: 'no-delegation' | 'store-error'; detail?: string }
    >;
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

  /**
   * Commerce routing outcome for this Matrix turn (support vs work persona,
   * active engagement, gate failure, cancellation). Absent on HTTP turns and
   * whenever the commerce router is inert.
   */
  commerce?: CommerceContext;

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
  /**
   * Billing gate. `'contracted'` marks a tool that performs paid contracted
   * work: the runtime binds it only while the turn runs inside an active work
   * engagement (`ctx.commerce.mode === 'work'`) and hides it from the model
   * otherwise — a hard code gate on top of the prompt overlay.
   */
  billing?: 'contracted';
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
