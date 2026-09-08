import type { BotCredentials } from '../do/contracts';
import type { AttachmentViewSurface } from '../attachments/view';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  ActionCallEventPayload,
  BrowserToolCallEventPayload,
  ChatOpenAIFields,
  Logger,
  MatrixEvent,
  MergedConfig,
  MessageCacheInvalidationPayload,
  ModelRole,
  OracleIdentity,
  PluginContext,
  ReadonlyState,
  ReasoningEventPayload,
  RenderComponentEventPayload,
  RoomStateSnapshot,
  RouterEventPayload,
  RuntimeContext,
  SecretIndex,
  SharedAccessors,
  ToolCallEventPayload,
  UcanDelegation,
  UserContextData,
} from '../plugin-api/types';
import { UcanMintUnavailableError } from '../plugin-api/ucan-errors';
import { NOOP_LOGGER, sweepExpired } from './utils';

// ── Adapter interfaces (implemented by the Durable Object layer) ────────────

/**
 * Per-room secrets adapter. Wraps the host's secrets service so plugins
 * never reach for a singleton directly.
 */
export interface SecretsAdapter {
  getIndex(roomId: string): Promise<SecretIndex>;
  getValues(roomId: string, keys: string[]): Promise<Record<string, string>>;
}

/**
 * Blob-store adapter — short-TTL keyed store for content that should never
 * be relayed through the LLM. Plugins reach it only via the narrow
 * `rtCtx.blobStore` shape.
 */
export interface BlobStoreAdapter {
  put(params: {
    userDid: string;
    name: string;
    value: string;
    ttlSeconds?: number;
  }): Promise<string>;
  get(params: {
    userDid: string;
    blobId: string;
  }): Promise<{ name: string; value: string } | null>;
  isValidBlobId(value: unknown): value is string;
}

/** Matrix adapter exposing only scoped operations a plugin should ever need. */
export interface MatrixAdapter {
  postToRoom(roomId: string, content: unknown): Promise<string>;
  /**
   * Post a timeline event with a caller-chosen event type. `postToRoom` is
   * the `m.room.message` shorthand; this is the general form. Returns the
   * new event id.
   */
  postEvent(
    roomId: string,
    eventType: string,
    content: object,
  ): Promise<string>;
  getRoomState(roomId: string): Promise<RoomStateSnapshot>;
  getEventById(roomId: string, eventId: string): Promise<MatrixEvent>;
  /** See `MatrixGatewayObject.botCredentials`. */
  botCredentials(): Promise<BotCredentials>;
}

/** LLM adapter — turns role tags into chat models. */
export interface LlmAdapter {
  get(role: ModelRole, params?: ChatOpenAIFields): BaseChatModel;
}

/** The delegation shape the capability checks read. */
export type DelegationLike =
  | { capabilities?: ReadonlyArray<{ resource: string; action: string }> }
  | undefined;

/** UCAN adapter — capability checks and downstream invocation minting. */
export interface UcanAdapter {
  hasCapability(
    delegation: DelegationLike,
    resource: string,
    action: string,
  ): boolean;
  requireCapability(
    delegation: DelegationLike,
    resource: string,
    action: string,
  ): void;
  mintInvocation(
    userDid: string,
    target: { did: string; capability: string },
    opts?: { skipCache?: boolean; can?: string },
  ): Promise<string>;
  /**
   * Resolve a downstream service URL to its did:web identifier. Returns
   * `null` when the document is missing or has no `id`.
   */
  resolveServiceDid(serviceUrl: string): Promise<string | null>;
  /** `true` once the oracle has its Ed25519 signing key loaded. */
  hasSigningKey(): boolean;
  createInvocationFromDelegation(
    delegationCar: string,
    serviceUrl: string,
    capability: { can: string; with: string },
    options?: { maxTtlSeconds?: number },
  ): Promise<{ invocation: string } | { error: string }>;
  mintSelfSignedInvocation(
    serviceUrl: string,
    capability: { can: string; with: string },
    options?: { maxTtlSeconds?: number },
  ): Promise<{ invocation: string } | { error: string }>;
  getServiceDelegation(
    userDid: string,
    opts: { storeUrl: string; resource: string; requiredAbility: string },
  ): Promise<
    | { token: string; with: string }
    | { error: 'no-delegation' | 'store-error'; detail?: string }
  >;
}

/** Raw event payload — what callers pass before the scoped emitter adds session/request ids. */
export type RawEventPayload = Record<string, unknown>;

/** Low-level event sink used by the scoped emitter. */
export interface EmitAdapter {
  emit(eventName: string, payload: RawEventPayload): void;
}

/**
 * Ambient services bag captured once per isolate (or per Durable Object).
 * Lives behind PluginContext / RuntimeContext synthesis — never exposed to
 * plugin authors directly. `src/do` implements the adapters; `core` only
 * consumes them through these interfaces.
 */
export interface AmbientServices {
  config: Record<string, unknown>;
  identity: OracleIdentity;
  availablePlugins: ReadonlySet<string>;
  secrets: SecretsAdapter;
  blobStore: BlobStoreAdapter;
  matrix: MatrixAdapter;
  llm: LlmAdapter;
  emit: EmitAdapter;
  ucan: UcanAdapter;
  logger: Logger;
  /** Host task scheduler for the current user, when the host provides one. */
  tasks?: import('../plugin-api/types').OracleTasksSurface;
  /** Host user-preferences store for the current user, when provided. */
  preferences?: import('../plugin-api/types').UserPreferencesSurface;
  /** Host bridge to the user's browser (realtime channel), when provided. */
  frontend?: import('../plugin-api/types').FrontendCallSurface;
  /** Host attachment access for the current session, when provided. */
  attachments?: AttachmentViewSurface;
  onTurnEnd?: (dispose: () => void | Promise<void>) => void;
}

// ── Scoped emitter ──────────────────────────────────────────────────────────

/** Identity of the current request — every emitted event carries these. */
export interface ScopeKeys {
  sessionId: string;
  requestId: string;
}

/** The seven typed emitter methods a RuntimeContext exposes via `ctx.emit`. */
export interface ScopedEmitter {
  toolCall(payload: ToolCallEventPayload): void;
  actionCall(payload: ActionCallEventPayload): void;
  renderComponent(payload: RenderComponentEventPayload): void;
  reasoning(payload: ReasoningEventPayload): void;
  browserToolCall(payload: BrowserToolCallEventPayload): void;
  router(payload: RouterEventPayload): void;
  messageCacheInvalidation(payload: MessageCacheInvalidationPayload): void;
}

/** Event names — wire-compatible with `@ixo/oracles-events`. */
export const EVENT_NAMES = {
  toolCall: 'tool_call',
  actionCall: 'action_call',
  renderComponent: 'render_component',
  reasoning: 'reasoning',
  browserToolCall: 'browser_tool_call',
  router: 'router.update',
  messageCacheInvalidation: 'message_cache_invalidation',
} as const;

/**
 * Build a scoped emitter that injects the current `sessionId`/`requestId`
 * onto every emitted payload before forwarding to the underlying sink.
 */
export function createScopedEmitter(
  scope: ScopeKeys,
  sink: EmitAdapter,
): ScopedEmitter {
  const send = (eventName: string, payload: RawEventPayload): void => {
    sink.emit(eventName, {
      ...payload,
      sessionId: scope.sessionId,
      requestId: scope.requestId,
    });
  };

  return {
    toolCall: (payload) => send(EVENT_NAMES.toolCall, payload),
    actionCall: (payload) => send(EVENT_NAMES.actionCall, payload),
    renderComponent: (payload) => send(EVENT_NAMES.renderComponent, payload),
    reasoning: (payload) => send(EVENT_NAMES.reasoning, payload),
    browserToolCall: (payload) => send(EVENT_NAMES.browserToolCall, payload),
    router: (payload) => send(EVENT_NAMES.router, payload),
    messageCacheInvalidation: (payload) =>
      send(EVENT_NAMES.messageCacheInvalidation, payload),
  };
}

// ── PluginContext ───────────────────────────────────────────────────────────

export interface BuildPluginContextInput<TConfig = MergedConfig> {
  /** Merged Zod-validated env (core + every loaded plugin's `configSchema`). */
  config: TConfig;
  /** Identity of this oracle. */
  identity: OracleIdentity;
  /** Names of the plugins resolved at boot. */
  availablePlugins: ReadonlySet<string>;
  /** Base logger; auto-bound to the calling plugin's name when supported. */
  logger: Logger;
  /** Plugin name used to scope the logger. */
  pluginName: string;
}

/**
 * Build the boot-time PluginContext passed to plugin methods that produce
 * tools, sub-agents, middlewares and routes. Holds no user, no session, no
 * request data.
 */
export function buildPluginContext<TConfig = MergedConfig>(
  input: BuildPluginContextInput<TConfig>,
): PluginContext<TConfig> {
  const scopedLogger = input.logger.child
    ? input.logger.child({ plugin: input.pluginName })
    : input.logger;

  return {
    config: input.config,
    identity: input.identity,
    availablePlugins: input.availablePlugins,
    logger: scopedLogger,
  };
}

// ── RuntimeContext ──────────────────────────────────────────────────────────

/** Fixed empty `shared` accessors — frozen so callers can't mutate. */
export const EMPTY_SHARED: SharedAccessors = Object.freeze({});

/** The user channel passed in via LangGraph's per-run context. */
export interface RuntimeUserContext {
  did: string;
  matrixUserId: string;
  ucanDelegation: UcanDelegation;
  timezone?: string;
  currentTime?: string;
}

/** Session info threaded through from the shell / gateway. */
export interface RuntimeSessionContext {
  id: string;
  client: 'portal' | 'matrix' | 'slack';
  wsId?: string;
  requestId: string;
  roomId?: string;
}

/** What LangGraph hands us at invocation time on `runtime.context`. */
export interface RunConfigContext {
  user: RuntimeUserContext;
  session: RuntimeSessionContext;
  /**
   * Set on turns that run on the user's own provider (BYO). Middlewares that
   * must behave differently per provider (the ChatGPT history sanitizer)
   * read it — same narrow marker the Node runtime's agent builder writes.
   */
  byo?: { provider: string; active: boolean };
}

/**
 * The `runtime` argument passed to a tool handler in LangGraph v1. We read
 * the `context` channel, the optional `signal`, the optional `toolCall`, and
 * the live `state` (for the true transcript).
 */
export interface RunConfig {
  context: RunConfigContext;
  signal?: AbortSignal;
  toolCall?: { id?: string };
  /**
   * The LIVE graph state at the moment the tool is called (LangGraph's
   * `ToolRuntime.state`). Only `messages` is read, and it is the only source
   * of a true transcript: the build-time snapshot predates the turn. Absent
   * on non-tool callers, which fall back to the snapshot.
   */
  state?: { messages?: readonly BaseMessage[] };
}

/**
 * Minimum shape of the graph state that build-runtime depends on. Real graphs
 * extend this freely.
 */
export interface RuntimeStateInput {
  messages: readonly BaseMessage[];
  userContext?: UserContextData;
  loadedPlugins?: ReadonlySet<string>;
  [key: string]: unknown;
}

/**
 * Build the per-request RuntimeContext exposed to tool handlers, sub-agent
 * handlers and plugin-middleware hooks. Synthesizes user/session from the
 * LangGraph runtime channel, history from state, and the rest from ambient.
 *
 * `sharedFactory` lets the main-agent build attach the shared-state
 * registry's accessors (`ctx.shared.<key>`); it receives the finished context
 * because accessors are evaluated lazily against it. Direct callers that omit
 * it get the frozen empty bag.
 */
export function buildRuntimeContext<TConfig = MergedConfig>(
  runConfig: RunConfig,
  ambient: AmbientServices,
  state: RuntimeStateInput,
  sharedFactory?: (ctx: RuntimeContext<TConfig>) => SharedAccessors,
): RuntimeContext<TConfig> {
  const session = runConfig.context.session;
  const user = runConfig.context.user;

  const messages: readonly BaseMessage[] =
    runConfig.state?.messages ?? state.messages ?? [];
  const userContext: UserContextData = state.userContext ?? {};
  const loadedPlugins: ReadonlySet<string> =
    state.loadedPlugins ?? new Set<string>();

  const recent = (n: number): BaseMessage[] =>
    n <= 0 ? [] : messages.slice(Math.max(0, messages.length - n));

  const readonlyState: ReadonlyState = {
    ...state,
    messages,
    userContext,
    loadedPlugins,
  };

  const emit = createScopedEmitter(
    { sessionId: session.id, requestId: session.requestId },
    ambient.emit,
  );

  const abortSignal = runConfig.signal ?? new AbortController().signal;

  const delegation = user.ucanDelegation;

  const ctx: RuntimeContext<TConfig> = {
    user,
    session,
    history: {
      messages,
      recent,
      userContext,
      state: readonlyState,
    },
    config: ambient.config as TConfig,
    availablePlugins: ambient.availablePlugins,
    loadedPlugins,
    secrets: {
      getIndex: () => {
        if (!session.roomId) {
          return Promise.resolve({});
        }
        return ambient.secrets.getIndex(session.roomId);
      },
      getValues: (keys: string[]) => {
        if (!session.roomId) {
          return Promise.resolve({});
        }
        return ambient.secrets.getValues(session.roomId, keys);
      },
    },
    blobStore: {
      put: (params) => ambient.blobStore.put(params),
      get: (params) => ambient.blobStore.get(params),
      isValidBlobId: (value): value is string =>
        ambient.blobStore.isValidBlobId(value),
    },
    matrix: {
      postToRoom: (roomId, content) =>
        ambient.matrix.postToRoom(roomId, content),
      botCredentials: () => ambient.matrix.botCredentials(),
      postEvent: (roomId, eventType, content) =>
        ambient.matrix.postEvent(roomId, eventType, content),
      getRoomState: (roomId) => ambient.matrix.getRoomState(roomId),
      getEventById: (roomId, eventId) =>
        ambient.matrix.getEventById(roomId, eventId),
    },
    ucan: {
      hasCapability: (resource, action) =>
        ambient.ucan.hasCapability(delegation, resource, action),
      requireCapability: (resource, action) => {
        ambient.ucan.requireCapability(delegation, resource, action);
      },
      mintInvocation: (target, opts) =>
        ambient.ucan.mintInvocation(user.did, target, opts),
      resolveServiceDid: (serviceUrl) =>
        ambient.ucan.resolveServiceDid(serviceUrl),
      hasSigningKey: () => ambient.ucan.hasSigningKey(),
      createInvocationFromDelegation: (car, serviceUrl, capability, opts) =>
        ambient.ucan.createInvocationFromDelegation(
          car,
          serviceUrl,
          capability,
          opts,
        ),
      mintSelfSignedInvocation: (serviceUrl, capability, opts) =>
        ambient.ucan.mintSelfSignedInvocation(serviceUrl, capability, opts),
      getServiceDelegation: (userDid, opts) =>
        ambient.ucan.getServiceDelegation(userDid, opts),
    },
    llm: {
      get: (role, params) => ambient.llm.get(role, params),
    },
    emit,
    logger: ambient.logger,
    abortSignal,
    ...(ambient.tasks ? { tasks: ambient.tasks } : {}),
    ...(ambient.preferences ? { preferences: ambient.preferences } : {}),
    ...(ambient.frontend ? { frontend: ambient.frontend } : {}),
    ...(ambient.attachments ? { attachments: ambient.attachments } : {}),
    ...(ambient.onTurnEnd ? { onTurnEnd: ambient.onTurnEnd } : {}),
    shared: EMPTY_SHARED,
    ...(runConfig.toolCall?.id ? { toolCallId: runConfig.toolCall.id } : {}),
  };
  if (sharedFactory) {
    ctx.shared = sharedFactory(ctx);
  }
  return ctx;
}

// ── Defaults for tests and partial hosts ────────────────────────────────────

const BLOB_ID_RE = /^blob_[0-9a-f]{16}$/;
const BLOB_DEFAULT_TTL_SECONDS = 60 * 60;
const BLOB_MAX_TTL_SECONDS = 24 * 60 * 60;

/**
 * In-memory blob store with the same id format and TTL clamping as the Node
 * runtime's `BlobStoreService`. Entries are namespaced by user DID so a
 * cross-user read always misses. Suitable for tests and as a per-isolate
 * fallback; a production host should back it with Durable Object storage.
 */
export function createMemoryBlobStore(): BlobStoreAdapter {
  const entries = new Map<
    string,
    { name: string; value: string; expiresAt: number }
  >();
  const keyOf = (userDid: string, blobId: string) => `${userDid} ${blobId}`;
  const randomId = (): string => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return `blob_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  };
  return {
    async put({ userDid, name, value, ttlSeconds }) {
      const ttl = Math.min(
        Math.max(1, ttlSeconds ?? BLOB_DEFAULT_TTL_SECONDS),
        BLOB_MAX_TTL_SECONDS,
      );
      sweepExpired(entries);
      const blobId = randomId();
      entries.set(keyOf(userDid, blobId), {
        name,
        value,
        expiresAt: Date.now() + ttl * 1000,
      });
      return blobId;
    },
    async get({ userDid, blobId }) {
      const entry = entries.get(keyOf(userDid, blobId));
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(keyOf(userDid, blobId));
        return null;
      }
      return { name: entry.name, value: entry.value };
    },
    isValidBlobId: (value): value is string =>
      typeof value === 'string' && BLOB_ID_RE.test(value),
  };
}

/**
 * Pure capability check over a delegation's declared capabilities. A `*`
 * resource or action matches anything, mirroring the Node adapter.
 */
export function delegationHasCapability(
  delegation: DelegationLike,
  resource: string,
  action: string,
): boolean {
  const caps = delegation?.capabilities ?? [];
  return caps.some(
    (cap) =>
      (cap.resource === '*' || cap.resource === resource) &&
      (cap.action === '*' || cap.action === action),
  );
}

/**
 * UCAN adapter for hosts without a signing key: capability checks work
 * against the delegation the user presented, every mint path reports
 * "unavailable" through the documented non-throwing / `UcanMintUnavailableError`
 * channels, and `hasSigningKey()` is `false` so plugins degrade to their
 * public-only paths.
 */
export function createUnsignedUcanAdapter(): UcanAdapter {
  const unavailable = 'UCAN minting is unavailable: no signing key loaded.';
  return {
    hasCapability: delegationHasCapability,
    requireCapability(delegation, resource, action) {
      if (!delegationHasCapability(delegation, resource, action)) {
        throw new Error(
          `Missing required capability: ${action} on ${resource}`,
        );
      }
    },
    async mintInvocation() {
      throw new UcanMintUnavailableError(unavailable);
    },
    async resolveServiceDid() {
      return null;
    },
    hasSigningKey: () => false,
    async createInvocationFromDelegation() {
      return { error: unavailable };
    },
    async mintSelfSignedInvocation() {
      return { error: unavailable };
    },
    async getServiceDelegation() {
      return { error: 'no-delegation' as const };
    },
  };
}

/** Matrix adapter that refuses every call — for hosts without a gateway. */
export function createUnavailableMatrixAdapter(): MatrixAdapter {
  const fail = (op: string) =>
    Promise.reject(
      new Error(`Matrix is not available in this runtime (${op}).`),
    );
  return {
    postToRoom: () => fail('postToRoom'),
    postEvent: () => fail('postEvent'),
    getRoomState: () => fail('getRoomState'),
    getEventById: () => fail('getEventById'),
    botCredentials: () => fail('botCredentials'),
  };
}

/** LLM adapter that throws on every role — forces tests to inject a model. */
export function createUnavailableLlmAdapter(): LlmAdapter {
  return {
    get(role) {
      throw new Error(
        `No LLM adapter configured (requested role "${String(role)}"). Pass \`llm\` to createNoopAmbient() or build one with createLlmAdapter().`,
      );
    },
  };
}

export type NoopAmbientOverrides = Partial<AmbientServices>;

/**
 * An `AmbientServices` bag with sane defaults for tests and for hosts that
 * do not wire every adapter: no-op secrets, an in-memory blob store,
 * throwing Matrix, unsigned UCAN, a throwing LLM, a discarding emitter and a
 * silent logger. Every field can be overridden.
 */
export function createNoopAmbient(
  overrides: NoopAmbientOverrides = {},
): AmbientServices {
  return {
    config: overrides.config ?? {},
    identity: overrides.identity ?? {
      name: 'Oracle',
      org: '',
      description: '',
      entityDid: 'did:ixo:oracle',
    },
    availablePlugins: overrides.availablePlugins ?? new Set<string>(),
    secrets: overrides.secrets ?? {
      getIndex: async () => ({}),
      getValues: async () => ({}),
    },
    blobStore: overrides.blobStore ?? createMemoryBlobStore(),
    matrix: overrides.matrix ?? createUnavailableMatrixAdapter(),
    llm: overrides.llm ?? createUnavailableLlmAdapter(),
    emit: overrides.emit ?? { emit: () => undefined },
    ucan: overrides.ucan ?? createUnsignedUcanAdapter(),
    logger: overrides.logger ?? NOOP_LOGGER,
  };
}
