import { MatrixManager } from '@ixo/matrix';
import type { AllEvents } from '@ixo/oracles-events';
import type { INestApplication } from '@nestjs/common';
import { getProviderChatModel } from '../llm/llm-provider.js';
import { BlobStoreService } from '../modules/blob-store/blob-store.service.js';
import { SecretsService } from '../modules/secrets/secrets.service.js';
import { UcanService } from '../modules/ucan/ucan.service.js';
import { wsEmitter } from '../modules/ws/emitter.js';
import type {
  Logger as PluginLogger,
  MatrixEvent,
  OracleIdentity,
  RoomStateSnapshot,
  SecretIndex,
} from '../plugin-api/types.js';
import type {
  AmbientServices,
  BlobStoreAdapter,
  EmitAdapter,
  LlmAdapter,
  MatrixAdapter,
  SecretsAdapter,
  UcanAdapter,
} from '../runtime-context/ambient.js';

export interface BuildAmbientOptions {
  /** The booted Nest app — used to resolve DI-managed services. */
  nestApp: INestApplication;
  /** The merged + validated environment config. */
  config: Record<string, unknown>;
  /** Identity declared by the host in `createOracleApp`. */
  identity: OracleIdentity;
  /** Names of plugins that successfully loaded. */
  availablePlugins: ReadonlySet<string>;
  /** Boot-time logger; reused across adapters that don't get their own. */
  logger: PluginLogger;
}

/**
 * Build the `AmbientServices` bag — the bundle of adapters every
 * `buildRuntimeContext` call needs. Each adapter is a thin wrapper around
 * an existing Tier-0 service or library singleton:
 *
 *   - **UcanAdapter** → `UcanService` (DI-resolved from `nestApp`)
 *   - **MatrixAdapter** → `MatrixManager.getInstance()` (library singleton)
 *   - **SecretsAdapter** → `SecretsService.getInstance()` (lifted singleton)
 *   - **LlmAdapter** → `getProviderChatModel` (provider-aware factory)
 *   - **EmitAdapter** → `wsEmitter` (cross-module event bus → WS gateway)
 *
 * The adapter interfaces (`runtime-context/ambient.ts`) are intentionally
 * narrow so plugins don't reach for service internals. This factory is the
 * only place where the wide-shape services get bound to the narrow shape.
 */
export function buildAmbientServices(
  opts: BuildAmbientOptions,
): AmbientServices {
  const ucanService = opts.nestApp.get(UcanService);
  const blobStoreService = opts.nestApp.get(BlobStoreService);
  const secretsService = SecretsService.getInstance();

  const ucanAdapter: UcanAdapter = {
    hasCapability(delegation, resource, action) {
      return Boolean(
        delegation?.capabilities?.some(
          (cap) => cap.resource === resource && cap.action === action,
        ),
      );
    },
    requireCapability(delegation, resource, action) {
      const ok = Boolean(
        delegation?.capabilities?.some(
          (cap) => cap.resource === resource && cap.action === action,
        ),
      );
      if (!ok) {
        throw new Error(
          `UCAN capability missing: '${action}' on '${resource}'.`,
        );
      }
    },
    async mintInvocation(userDid, target, opts) {
      const result = await ucanService.mintInvocationForServiceDid(
        userDid,
        target.did,
        target.capability,
        opts,
      );
      if (!result) {
        throw new Error(
          `UCAN invocation mint returned null for user='${userDid}' service='${target.did}' capability='${target.capability}'. ` +
            `Likely cause: no signing key loaded, no cached delegation, or service DID unreachable.`,
        );
      }
      return result;
    },
    async resolveServiceDid(serviceUrl) {
      return ucanService.resolveServiceDid(serviceUrl);
    },
    hasSigningKey() {
      return ucanService.hasSigningKey();
    },
    createInvocationFromDelegation(
      delegationCar,
      serviceUrl,
      capability,
      opts,
    ) {
      return ucanService.createInvocationFromDelegation(
        delegationCar,
        serviceUrl,
        capability,
        opts,
      );
    },
  };

  const matrixAdapter: MatrixAdapter = {
    async postToRoom(roomId, content) {
      // Treat caller-supplied content as a Matrix event body. Plugins decide
      // the event shape (most send `{ msgtype: 'm.text', body: '...' }`).
      return MatrixManager.getInstance().sendMatrixEvent(
        roomId,
        'm.room.message',
        content as object,
      );
    },
    async getRoomState(roomId) {
      const client = MatrixManager.getInstance().getClient();
      if (!client) {
        throw new Error(
          'MatrixAdapter.getRoomState: Matrix client not initialized.',
        );
      }
      const state = await client.mxClient.getRoomState(roomId);
      return { roomId, state } satisfies RoomStateSnapshot;
    },
    async getEventById(roomId, eventId) {
      const evt = await MatrixManager.getInstance().getEventById(
        roomId,
        eventId,
      );
      const raw = evt as {
        event_id?: string;
        type?: string;
        content?: unknown;
        sender?: string;
        origin_server_ts?: number;
      };
      return {
        eventId: raw.event_id ?? eventId,
        type: raw.type ?? 'unknown',
        content: raw.content ?? null,
        senderId: raw.sender,
        originServerTs: raw.origin_server_ts,
      } satisfies MatrixEvent;
    },
  };

  const llmAdapter: LlmAdapter = {
    get(role, params) {
      return getProviderChatModel(role, params);
    },
  };

  const blobStoreAdapter: BlobStoreAdapter = {
    put: (params) => blobStoreService.put(params),
    get: (params) => blobStoreService.get(params),
    isValidBlobId: (value): value is string =>
      blobStoreService.isValidBlobId(value),
  };

  const secretsAdapter: SecretsAdapter = {
    async getIndex(roomId) {
      const entries = await secretsService.getSecretIndex(roomId);
      const index: Record<string, { key: string }> = {};
      for (const entry of entries) {
        index[entry.name] = { key: entry.name };
      }
      return index satisfies SecretIndex;
    },
    async getValues(roomId, keys) {
      const requested = new Set(keys);
      const index = await secretsService.getSecretIndex(roomId);
      const filtered = index.filter((entry) => requested.has(entry.name));
      return secretsService.loadSecretValues(roomId, filtered);
    },
  };

  const emitAdapter: EmitAdapter = {
    emit(eventName, payload) {
      // The scoped emitter has already attached session/request ids to the
      // payload. The cross-module `wsEmitter` expects `(sessionId, event)`
      // where the event carries its own `type` discriminator.
      const sessionId =
        typeof payload?.sessionId === 'string' ? payload.sessionId : 'unknown';
      const event = { type: eventName, ...payload };
      wsEmitter.emit(sessionId, event as unknown as AllEvents);
    },
  };

  return {
    config: opts.config,
    identity: opts.identity,
    availablePlugins: opts.availablePlugins,
    secrets: secretsAdapter,
    blobStore: blobStoreAdapter,
    matrix: matrixAdapter,
    llm: llmAdapter,
    emit: emitAdapter,
    ucan: ucanAdapter,
    logger: opts.logger,
  };
}
