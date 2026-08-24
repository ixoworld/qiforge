import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  ChatOpenAIFields,
  Logger,
  MatrixEvent,
  ModelRole,
  OracleIdentity,
  RoomStateSnapshot,
  SecretIndex,
} from '../plugin-api/types.js';

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
 * be relayed through the LLM. Wraps `BlobStoreService` so plugins reach
 * it only via the narrow `rtCtx.blobStore` shape.
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
   * Post a timeline event with a caller-chosen event type (e.g. the
   * `ixo.oracle.*` protocol events). `postToRoom` is the `m.room.message`
   * shorthand; this is the general form. Returns the new event id.
   */
  postEvent(
    roomId: string,
    eventType: string,
    content: object,
  ): Promise<string>;
  getRoomState(roomId: string): Promise<RoomStateSnapshot>;
  getEventById(roomId: string, eventId: string): Promise<MatrixEvent>;
}

/** LLM adapter — turns role tags into chat models. */
export interface LlmAdapter {
  get(role: ModelRole, params?: ChatOpenAIFields): BaseChatModel;
}

/** UCAN adapter — capability checks and downstream invocation minting. */
export interface UcanAdapter {
  hasCapability(
    delegation:
      | { capabilities?: ReadonlyArray<{ resource: string; action: string }> }
      | undefined,
    resource: string,
    action: string,
  ): boolean;
  requireCapability(
    delegation:
      | { capabilities?: ReadonlyArray<{ resource: string; action: string }> }
      | undefined,
    resource: string,
    action: string,
  ): void;
  mintInvocation(
    userDid: string,
    target: { did: string; capability: string },
    opts?: { skipCache?: boolean; can?: string },
  ): Promise<string>;
  /**
   * Resolve a downstream service URL to its did:web identifier (fetched
   * once from `/.well-known/did.json` and cached by origin). Returns `null`
   * when the document is missing or has no `id` — callers degrade gracefully
   * instead of throwing.
   */
  resolveServiceDid(serviceUrl: string): Promise<string | null>;
  /**
   * `true` once the oracle has loaded its Ed25519 signing mnemonic at boot.
   * Plugins that mint downstream invocations gate tool registration on this —
   * without a signing key, minting is a no-op and the tool should advertise an
   * error instead of pretending to work.
   */
  hasSigningKey(): boolean;
  /**
   * Mint a UCAN invocation from a directly-supplied delegation CAR — used
   * when the caller has the user's signed delegation in hand (typically read
   * from a flow's Y.Doc by CID) and wants a freshly-targeted invocation
   * against a specific service route. Returns `{ invocation }` on success
   * or `{ error }` with a surfaced-verbatim reason on failure (signing key
   * missing, delegation audience mismatch, did:web unreachable, etc.).
   */
  createInvocationFromDelegation(
    delegationCar: string,
    serviceUrl: string,
    capability: { can: string; with: string },
    options?: { maxTtlSeconds?: number },
  ): Promise<{ invocation: string } | { error: string }>;
  /**
   * Mint a SELF-SIGNED invocation — issued by this oracle with NO proof chain —
   * for calling a downstream service AS THE ORACLE ITSELF (not on a user's
   * behalf). Returns `{ invocation }` (base64 CAR) on success or `{ error }`
   * with a surfaced-verbatim reason (signing key missing, did:web unreachable,
   * etc.). Non-throwing.
   */
  mintSelfSignedInvocation(
    serviceUrl: string,
    capability: { can: string; with: string },
    options?: { maxTtlSeconds?: number },
  ): Promise<{ invocation: string } | { error: string }>;
  /**
   * Fetch, from the UCAN Store Worker, a delegation `userDid` deposited for
   * this oracle over `opts.resource`. Selects the newest active delegation
   * whose capability covers `opts.requiredAbility`. Returns `{ token, with }`
   * on success or `{ error }` — `'no-delegation'` when none satisfies the
   * request, `'store-error'` (with `detail`) for auth / network / store
   * failures. Non-throwing.
   */
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
 * Ambient services bag captured once at boot. Lives behind PluginContext /
 * RuntimeContext synthesis — never exposed to plugin authors directly.
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
}
