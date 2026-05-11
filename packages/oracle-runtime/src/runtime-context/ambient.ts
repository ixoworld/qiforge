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

/** Matrix adapter exposing only scoped operations a plugin should ever need. */
export interface MatrixAdapter {
  postToRoom(roomId: string, content: unknown): Promise<string>;
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
  ): Promise<string>;
  /**
   * Resolve a downstream service URL to its did:web identifier (fetched
   * once from `/.well-known/did.json` and cached by origin). Returns `null`
   * when the document is missing or has no `id` — callers degrade gracefully
   * instead of throwing.
   */
  resolveServiceDid(serviceUrl: string): Promise<string | null>;
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
  matrix: MatrixAdapter;
  llm: LlmAdapter;
  emit: EmitAdapter;
  ucan: UcanAdapter;
  logger: Logger;
}
