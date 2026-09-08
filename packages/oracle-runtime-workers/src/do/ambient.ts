/**
 * Workers implementations of the core's `AmbientServices` adapters, built
 * once per `UserOracleDO` instance:
 *
 *  - matrix    → RPC through the oracle's `MatrixGatewayDO` (the only object
 *                holding the bot's crypto).
 *  - ucan      → `WorkersUcanService` (oracle signing key from env).
 *  - blobStore → this object's storage with an expiry column.
 *  - secrets   → per-room JWE secrets via `WorkersSecretsService` when the
 *                host supplies the adapter (`do/secrets-adapter.ts`); the
 *                empty fallback stays for hosts without a seated key/room.
 *  - emit      → routed to the SSE writer of the turn that owns the
 *                payload's `sessionId` (same shape as the Node `wsEmitter`).
 */
import type {
  AmbientServices,
  DelegationLike,
  EmitAdapter,
  RawEventPayload,
  SecretsAdapter,
} from '../core/runtime-context';
import type { LlmAdapter } from '../core/runtime-context';
import type {
  Logger,
  MatrixEvent,
  OracleIdentity,
  RoomStateSnapshot,
} from '../plugin-api/types';
import type { MatrixGatewayObject } from './contracts';
import { type WorkersUcanService } from './ucan-service';

export interface EventSink {
  emit(eventName: string, payload: RawEventPayload): void;
}

/**
 * Fan-out addressed by `payload.sessionId`: the sinks registered for that
 * session (the SSE stream of the in-flight turn) plus every tap (the
 * realtime socket hub, which routes by session itself) — the Workers shape
 * of Node's `wsEmitter` + `server.to(sessionId)`.
 */
export class SessionEventRouter implements EmitAdapter {
  private readonly sinks = new Map<string, Set<EventSink>>();
  private readonly taps = new Set<EventSink>();
  register(sessionId: string, sink: EventSink): void {
    let set = this.sinks.get(sessionId);
    if (!set) {
      set = new Set();
      this.sinks.set(sessionId, set);
    }
    set.add(sink);
  }
  unregister(sessionId: string, sink: EventSink): void {
    const set = this.sinks.get(sessionId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.sinks.delete(sessionId);
  }
  /** A sink that sees every session's events (it filters by `sessionId`). */
  tap(sink: EventSink): void {
    this.taps.add(sink);
  }
  emit(eventName: string, payload: RawEventPayload): void {
    const sessionId =
      typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
    if (!sessionId) return;
    for (const sink of this.sinks.get(sessionId) ?? []) {
      sink.emit(eventName, payload);
    }
    for (const sink of this.taps) sink.emit(eventName, payload);
  }

  /**
   * Taps only — for frames the in-flight turn's SSE stream already wrote
   * itself (`tool_call`, `action_call`, `router_update`) and that the
   * session's sockets must see too, as Node's WebSocket gateway relays them.
   * Skipping the session sinks keeps the SSE stream from receiving them twice.
   */
  emitToTaps(eventName: string, payload: RawEventPayload): void {
    if (typeof payload.sessionId !== 'string') return;
    for (const sink of this.taps) sink.emit(eventName, payload);
  }
}

const BLOB_ID_RE = /^blob_[0-9a-f]{16}$/;
const BLOB_DEFAULT_TTL_SECONDS = 60 * 60;
const BLOB_MAX_TTL_SECONDS = 24 * 60 * 60;

export function createBlobStore(
  storage: DurableObjectStorage,
): AmbientServices['blobStore'] {
  return {
    isValidBlobId: (value: unknown): value is string =>
      typeof value === 'string' && BLOB_ID_RE.test(value),
    put: async ({ userDid, name, value, ttlSeconds }) => {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      const id = `blob_${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
      const ttl = Math.min(
        Math.max(1, ttlSeconds ?? BLOB_DEFAULT_TTL_SECONDS),
        BLOB_MAX_TTL_SECONDS,
      );
      await storage.put(`blob:${userDid}:${id}`, {
        name,
        value,
        expiresAt: Date.now() + ttl * 1000,
      });
      return id;
    },
    get: async ({ userDid, blobId }) => {
      if (!BLOB_ID_RE.test(blobId)) return null;
      const key = `blob:${userDid}:${blobId}`;
      const hit = await storage.get<{
        name: string;
        value: string;
        expiresAt: number;
      }>(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        await storage.delete(key);
        return null;
      }
      return { name: hit.name, value: hit.value };
    },
  };
}

export function createMatrixAdapter(
  gateway: DurableObjectStub<MatrixGatewayObject>,
): AmbientServices['matrix'] {
  return {
    postToRoom: (roomId, content) =>
      gateway.sendEvent(roomId, 'm.room.message', JSON.stringify(content)),
    postEvent: (roomId, eventType, content) =>
      gateway.sendEvent(roomId, eventType, JSON.stringify(content)),
    botCredentials: () => gateway.botCredentials(),
    getRoomState: async (roomId): Promise<RoomStateSnapshot> => {
      const raw = await gateway.getRoomState(roomId);
      return { roomId, state: JSON.parse(raw) as unknown[] };
    },
    getEventById: async (roomId, eventId): Promise<MatrixEvent> => {
      const raw = await gateway.getEvent(roomId, eventId);
      if (!raw) throw new Error(`Event ${eventId} not found in ${roomId}`);
      const ev = JSON.parse(raw) as {
        event_id: string;
        type: string;
        content: unknown;
        sender?: string;
        origin_server_ts?: number;
      };
      return {
        eventId: ev.event_id,
        type: ev.type,
        content: ev.content,
        senderId: ev.sender,
        originServerTs: ev.origin_server_ts,
      };
    },
  };
}

function abilityCovers(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith('/*')) {
    const ns = granted.slice(0, -2);
    return required === ns || required.startsWith(`${ns}/`);
  }
  return false;
}

export function createUcanAdapter(
  service: WorkersUcanService,
  delegationFor: (userDid: string) => { raw?: string } | undefined,
): AmbientServices['ucan'] {
  const has = (delegation: DelegationLike, resource: string, action: string) =>
    (delegation?.capabilities ?? []).some(
      (c) =>
        (c.resource === resource || c.resource.startsWith(resource)) &&
        abilityCovers(c.action, action),
    );
  return {
    hasCapability: has,
    requireCapability: (delegation, resource, action) => {
      if (!has(delegation, resource, action))
        throw new Error(`Missing UCAN capability ${action} on ${resource}`);
    },
    mintInvocation: async (userDid, target, opts) => {
      const delegation = delegationFor(userDid);
      if (!delegation?.raw)
        throw new Error(
          `No delegation from ${userDid} available to mint an invocation from`,
        );
      const minted = await service.createInvocationFromDelegation(
        delegation.raw,
        target.did,
        {
          can: opts?.can ?? '*',
          with: target.capability,
        },
      );
      if ('error' in minted) throw new Error(minted.error);
      return minted.invocation;
    },
    resolveServiceDid: (url) => service.resolveServiceDid(url),
    hasSigningKey: () => service.hasSigningKey(),
    createInvocationFromDelegation: (car, url, cap, o) =>
      service.createInvocationFromDelegation(car, url, cap, o),
    mintSelfSignedInvocation: (url, cap, o) =>
      service.mintSelfSignedInvocation(url, cap, o),
    getServiceDelegation: (did, o) => service.getServiceDelegation(did, o),
  };
}

export interface CreateAmbientInput {
  /** Host task scheduler surface for this user, when tasks are enabled. */
  tasks?: import('../plugin-api/types').OracleTasksSurface;
  preferences?: import('../plugin-api/types').UserPreferencesSurface;
  /** Host bridge to the user's browser (realtime channel), when terminated here. */
  frontend?: import('../plugin-api/types').FrontendCallSurface;
  /** Per-turn cleanup registry (see `RuntimeContext.onTurnEnd`). */
  onTurnEnd?: (dispose: () => void | Promise<void>) => void;
  config: Record<string, unknown>;
  identity: OracleIdentity;
  availablePlugins: ReadonlySet<string>;
  llm: LlmAdapter;
  logger: Logger;
  storage: DurableObjectStorage;
  gateway: DurableObjectStub<MatrixGatewayObject>;
  ucan: WorkersUcanService;
  delegationFor: (userDid: string) => { raw?: string } | undefined;
  events: SessionEventRouter;
  /**
   * Per-room JWE secrets adapter (`createSecretsAdapter` over
   * `WorkersSecretsService`). Omitted → the empty fallback: plugins see an
   * empty index and degrade exactly as on Node without a key.
   */
  secrets?: SecretsAdapter;
}

export function createAmbientServices(
  input: CreateAmbientInput,
): AmbientServices {
  return {
    ...(input.tasks ? { tasks: input.tasks } : {}),
    ...(input.preferences ? { preferences: input.preferences } : {}),
    ...(input.frontend ? { frontend: input.frontend } : {}),
    config: input.config,
    identity: input.identity,
    availablePlugins: input.availablePlugins,
    llm: input.llm,
    logger: input.logger,
    emit: input.events,
    blobStore: createBlobStore(input.storage),
    matrix: createMatrixAdapter(input.gateway),
    ucan: createUcanAdapter(input.ucan, input.delegationFor),
    secrets: input.secrets ?? {
      // Empty fallback for hosts without a secrets service (no key seated,
      // no account room) — plugins see an empty index and degrade exactly
      // as on Node without a key.
      getIndex: async () => ({}),
      getValues: async () => ({}),
    },
  };
}
