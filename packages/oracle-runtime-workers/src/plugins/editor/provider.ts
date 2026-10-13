import { MatrixProvider } from '@ixo/matrix-crdt';
import { MatrixError, type MatrixClient } from 'matrix-js-sdk';
import * as Y from 'yjs';

import { createConsoleLogger } from '../../core/utils';

const logger = createConsoleLogger({ module: 'editor-provider' });

/** Resolve after `ms`, or as soon as `signal` aborts (the timer is cleared). */
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** The event type matrix-crdt sends Y.Doc updates as (its translator default). */
export const DOC_UPDATE_EVENT_TYPE = 'matrix-crdt.doc_update';

/** Sends of one batch of document changes before the write is abandoned. */
export const DOC_WRITE_MAX_ATTEMPTS = 4;
/** Time from a batch's first failed send until the write is abandoned. */
export const DOC_WRITE_RETRY_BUDGET_MS = 15_000;
/** Back-off before the second send; doubled for each further one. */
export const DOC_WRITE_BASE_BACKOFF_MS = 250;
/**
 * How long a caller waits for pending changes to reach the homeserver. Longer
 * than the retry budget, so a write that is still being retried is given the
 * whole budget before the caller reports it unsent.
 */
export const DOC_FLUSH_TIMEOUT_MS = DOC_WRITE_RETRY_BUDGET_MS + 5_000;

/** Why changes made to a document did not reach the room. */
export type DocWriteFailure =
  | {
      /** The homeserver refused the write (`M_FORBIDDEN`): no permission. */
      kind: 'forbidden';
      detail: string;
    }
  | {
      /** The write was not acknowledged by the homeserver. */
      kind: 'unsent';
      detail: string;
      /**
       * False only when every failed send was refused with a client error
       * (400, 401, 413, 429 …) — the homeserver answered and stored nothing.
       * True when a send failed with a server error, a timeout or a network
       * failure, when the flush wait ran out, or when a send was dropped
       * after the document closed: the change may or may not have landed.
       */
      mayHaveLanded: boolean;
    };

export interface DocWriteRetryOptions {
  maxAttempts?: number;
  budgetMs?: number;
  baseBackoffMs?: number;
}

export interface DocWriteGuardOptions extends DocWriteRetryOptions {
  /**
   * What further writes do once one has been abandoned. `reject`: they fail
   * as `M_FORBIDDEN`, so matrix-crdt's writer stops retrying and its
   * `canWrite` turns false (callers that only look at `canWrite` still fail
   * closed). `drain`: they resolve without being sent, so the writer empties
   * its queue; the caller must read {@link DocWriteGuard.failure}.
   */
  onGiveUp: 'reject' | 'drain';
}

/** A document write abandoned by {@link DocWriteGuard}; matrix-crdt reads `errcode`. */
class DocWriteAbandonedError extends Error {
  readonly errcode = 'M_FORBIDDEN';

  constructor(detail: string) {
    super(`Document write abandoned: ${detail}`);
    this.name = 'DocWriteAbandonedError';
  }
}

function ownField(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The homeserver's requested wait before the next send, if it sent one. */
function retryAfterMs(error: unknown): number | undefined {
  if (error instanceof MatrixError) {
    try {
      const fromServer = error.getRetryAfterMs();
      if (typeof fromServer === 'number' && fromServer >= 0) return fromServer;
    } catch {
      // A malformed Retry-After header — fall back to the body field.
    }
  }
  const fromBody = ownField(ownField(error, 'data'), 'retry_after_ms');
  return typeof fromBody === 'number' && fromBody >= 0 ? fromBody : undefined;
}

/**
 * Whether a failed send may still have been stored: a server error, a request
 * timeout, or a failure with no HTTP answer at all (network, abort). A client
 * error is the homeserver's definite refusal of that request.
 */
function sendMayHaveLanded(error: unknown): boolean {
  const status = ownField(error, 'httpStatus');
  if (typeof status !== 'number') return true;
  return status === 408 || status >= 500;
}

/**
 * Whether sending the same batch again can succeed: rate limits, timeouts,
 * server errors and network failures can; any other client error (a 413 for
 * an oversized event, a 401 for a revoked token, a 400) cannot.
 */
function isRetryableSendError(error: unknown): boolean {
  const status = ownField(error, 'httpStatus');
  if (typeof status !== 'number') return true;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Bounds what matrix-crdt does with a document write that fails.
 *
 * matrix-crdt's writer re-queues a failed batch and sends it again after its
 * flush interval, forever, unless the homeserver answers `M_FORBIDDEN`; while
 * it does, `waitForFlush()` never resolves. Its retry timer also survives
 * `MatrixProvider.dispose()`, which does not dispose the writer. This guard
 * sits between the writer and the Matrix client (`client` is the client to
 * hand to the provider) and, for document updates only:
 *
 *   - waits before each re-send — the homeserver's `retry_after_ms` when it
 *     sends one, else an exponential back-off — so a failing write is not
 *     re-sent every few milliseconds;
 *   - abandons the write after {@link DOC_WRITE_MAX_ATTEMPTS} sends, after
 *     {@link DOC_WRITE_RETRY_BUDGET_MS}, or at once for an error that cannot
 *     succeed on retry, and records why in {@link failure};
 *   - records an `M_FORBIDDEN` as a `forbidden` failure;
 *   - after {@link close}, completes every send without the network, so the
 *     writer drains and its timer stops.
 *
 * It also attaches an abort signal to the client's direct `http.authedRequest`
 * calls (matrix-crdt's `/events` long-poll and snapshot media downloads),
 * which {@link close} aborts, so no long-poll outlives the document.
 */
export class DocWriteGuard {
  readonly client: MatrixClient;
  /** Document update sends that reached the network. */
  sends = 0;

  private recorded: DocWriteFailure | undefined;
  private closed = false;
  private failedSends = 0;
  /** A failed send in the current streak may have been stored. */
  private streakMayHaveLanded = false;
  private streakStartedAt: number | undefined;
  private nextSendAt = 0;
  private readonly abortController = new AbortController();
  private readonly wakers = new Set<() => void>();
  private readonly maxAttempts: number;
  private readonly budgetMs: number;
  private readonly baseBackoffMs: number;

  constructor(
    target: MatrixClient,
    private readonly opts: DocWriteGuardOptions,
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DOC_WRITE_MAX_ATTEMPTS);
    this.budgetMs = Math.max(0, opts.budgetMs ?? DOC_WRITE_RETRY_BUDGET_MS);
    this.baseBackoffMs = Math.max(
      0,
      opts.baseBackoffMs ?? DOC_WRITE_BASE_BACKOFF_MS,
    );

    const signal = this.abortController.signal;
    const http = target.http;
    const authedRequest: typeof http.authedRequest = (
      method,
      path,
      queryParams,
      body,
      paramOpts,
    ) =>
      http.authedRequest(
        method,
        path,
        queryParams,
        body,
        paramOpts?.abortSignal
          ? paramOpts
          : Object.assign({}, paramOpts, { abortSignal: signal }),
      );
    const guardedHttp = new Proxy(http, {
      get: (source, prop) => {
        if (prop === 'authedRequest') return authedRequest;
        const value: unknown = Reflect.get(source, prop, source);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });

    const sendEvent = (...args: unknown[]): Promise<unknown> => {
      const send = (): Promise<unknown> =>
        Promise.resolve(Reflect.apply(target.sendEvent, target, args));
      if (args[1] !== DOC_UPDATE_EVENT_TYPE) return send();
      return this.sendUpdate(send, () => forgetJoinedRoom(target, args[0]));
    };

    // Every other member is the real client's, bound to it, so the SDK's
    // internals keep running against the real instance.
    this.client = new Proxy(target, {
      get: (source, prop) => {
        if (prop === 'sendEvent') return sendEvent;
        if (prop === 'http') return guardedHttp;
        const value: unknown = Reflect.get(source, prop, source);
        return typeof value === 'function' ? value.bind(source) : value;
      },
      set: (source, prop, value) => Reflect.set(source, prop, value, source),
    });
  }

  /** Why a write was abandoned, or `undefined` while every write landed. */
  get failure(): DocWriteFailure | undefined {
    return this.recorded;
  }

  /** Stop: abort direct requests and complete further sends without sending. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort(new Error('document closed'));
    for (const wake of [...this.wakers]) wake();
  }

  private async sendUpdate(
    send: () => Promise<unknown>,
    onForbidden: () => void,
  ): Promise<unknown> {
    if (this.recorded) return this.giveUp(this.recorded.detail);
    await this.waitUntil(this.nextSendAt);
    if (this.closed) {
      // A batch dropped after close was never acknowledged; earlier sends of
      // it may have landed, so it is reported as possibly saved.
      this.recorded ??= {
        kind: 'unsent',
        detail: 'the document closed before the change was acknowledged',
        mayHaveLanded: true,
      };
      return {};
    }
    try {
      this.sends += 1;
      const result = await send();
      this.failedSends = 0;
      this.streakMayHaveLanded = false;
      this.streakStartedAt = undefined;
      this.nextSendAt = 0;
      return result;
    } catch (error) {
      return this.onSendFailed(error, onForbidden);
    }
  }

  private onSendFailed(error: unknown, onForbidden: () => void): unknown {
    const detail = errorDetail(error);
    if (ownField(error, 'errcode') === 'M_FORBIDDEN') {
      this.recorded = { kind: 'forbidden', detail };
      // The oracle may have been removed: the next load must join again.
      onForbidden();
      if (this.opts.onGiveUp === 'drain') return {};
      throw error;
    }

    const now = Date.now();
    this.failedSends += 1;
    this.streakMayHaveLanded ||= sendMayHaveLanded(error);
    this.streakStartedAt ??= now;
    const delay = Math.max(
      retryAfterMs(error) ?? 0,
      this.baseBackoffMs * 2 ** (this.failedSends - 1),
    );
    const exhausted =
      !isRetryableSendError(error) ||
      this.failedSends >= this.maxAttempts ||
      now + delay - this.streakStartedAt > this.budgetMs;
    if (exhausted) {
      this.recorded = {
        kind: 'unsent',
        detail: `${detail} (after ${this.failedSends} attempt${this.failedSends === 1 ? '' : 's'})`,
        mayHaveLanded: this.streakMayHaveLanded,
      };
      logger.warn(`Abandoning document write: ${this.recorded.detail}`);
      return this.giveUp(this.recorded.detail);
    }
    this.nextSendAt = now + delay;
    throw error;
  }

  private giveUp(detail: string): unknown {
    if (this.closed || this.opts.onGiveUp === 'drain') return {};
    throw new DocWriteAbandonedError(detail);
  }

  private waitUntil(at: number): Promise<void> {
    const ms = at - Date.now();
    if (ms <= 0 || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }
}

/** How long a successful join lets later loads of the room skip `POST /join`. */
export const JOIN_REUSE_WINDOW_MS = 60_000;

/**
 * When each client last joined each room, in this isolate. A load skips
 * `POST /join` only within {@link JOIN_REUSE_WINDOW_MS} of the last join, so
 * a burst of tool calls shares one join while a removal from the room is
 * noticed within that window: a removed member can still read the history
 * up to its removal, so only the join (refused) reveals it. The entry is
 * dropped as soon as a write to the room is refused with `M_FORBIDDEN`, and
 * a load refused with 403 after a skipped join forgets it, joins and retries
 * once.
 */
const joinedRooms = new WeakMap<MatrixClient, Map<string, number>>();

function forgetJoinedRoom(client: MatrixClient, roomId: unknown): void {
  if (typeof roomId === 'string') joinedRooms.get(client)?.delete(roomId);
}

/** Whether a failed load was the homeserver refusing access (403). */
function isAccessRefusal(error: unknown): boolean {
  return ownField(error, 'httpStatus') === 403;
}

/**
 * Whether a failed document load can succeed on another attempt. The room
 * being unreachable for this account, a client error from the homeserver, or
 * a history whose only snapshot is unreadable will fail the same way again.
 */
function isRetryableLoadError(error: unknown): boolean {
  if (error instanceof RoomNotAccessibleError) return false;
  if (error instanceof Error && error.name === 'SnapshotUnavailableError')
    return false;
  const status = ownField(error, 'httpStatus');
  if (typeof status === 'number' && status >= 400 && status < 500)
    return status === 408 || status === 429;
  return true;
}

/** Reject with `message` when `promise` has not settled within `ms`. */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type RoomDescriptor =
  | { type: 'id'; id: string }
  | { type: 'alias'; alias: string };

/**
 * The oracle cannot see the room at all — it is neither a member nor able to
 * join it. Distinct from a sync timeout so callers can tell "no access" from
 * "service is slow".
 */
export class RoomNotAccessibleError extends Error {
  constructor(
    readonly roomId: string,
    readonly detail: string,
  ) {
    super(`Room ${roomId} not accessible: ${detail}`);
    this.name = 'RoomNotAccessibleError';
  }
}

export interface ProviderInitResult {
  doc: Y.Doc;
  awareness?: unknown;
  provider: MatrixProvider;
  /** The write guard between the provider and Matrix; see {@link DocWriteGuard}. */
  writes: DocWriteGuard;
}
export interface MatrixRoomById {
  type: 'id';
  value: string;
}

export interface MatrixRoomByAlias {
  type: 'alias';
  value: string;
}
export interface ProviderConfig {
  docName: string;
  enableAwareness: boolean;
  retryAttempts: number;
  retryDelayMs: number;
  /** How long matrix-crdt batches Y.Doc updates before sending them. */
  flushInterval?: number;
  /** How long to wait before retrying a write the homeserver rejected. */
  retryIfForbiddenInterval?: number;
  /** How many rejected writes to retry before giving up (0 = unlimited). */
  maxForbiddenRetries?: number;
  /** Bounds on re-sending a failed write; defaults to the `DOC_WRITE_*` constants. */
  writeRetry?: DocWriteRetryOptions;
}

export type MatrixRoomConfig = MatrixRoomById | MatrixRoomByAlias;

export interface MatrixConfig {
  baseUrl: string;
  accessToken: string;
  userId: string;
  room: MatrixRoomConfig;
  initialSyncTimeoutMs: number;
}
export interface BlockNoteConfig {
  defaultBlockId?: string;
  blockNamespace?: string;
  mutableAttributeKeys: string[];
}

export interface AppConfig {
  matrix: MatrixConfig;
  provider: ProviderConfig;
  blocknote: BlockNoteConfig;
}

/**
 * MatrixProviderManager
 *
 * Manages a Y.Doc CRDT for a specific Matrix room.
 *
 * IMPORTANT: This class assumes the Matrix client is ALREADY synced
 * via the EditorMatrixClient singleton. It does NOT manage client lifecycle.
 *
 * Each instance creates:
 * - A new Y.Doc for the room
 * - A MatrixProvider to sync Y.Doc with Matrix
 *
 * The singleton EditorMatrixClient handles:
 * - Matrix connection
 * - Background sync
 * - Client lifecycle
 */
export class MatrixProviderManager {
  private readonly doc: Y.Doc;
  private provider: MatrixProvider | undefined;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private documentAvailable = false;
  private disposed = false;
  private availabilityResolvers: Array<() => void> = [];
  /** Aborted by `dispose()`: ends a retry back-off and pending availability waits. */
  private readonly disposal = new AbortController();
  /** True once the current provider finished loading the room's history. */
  private providerInitialized = false;
  /** A flush already ran out of time; disposal does not wait a second time. */
  private flushTimedOut = false;
  /** The room id the current load resolved, and whether it skipped the join. */
  private loadingRoomId: string | undefined;
  private joinSkipped = false;
  /** Incremented per load attempt; a superseded attempt abandons its provider. */
  private attempt = 0;
  private readonly writes: DocWriteGuard;

  private readonly now: () => number;

  constructor(
    private readonly matrixClient: MatrixClient,
    private readonly cfg: AppConfig,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.doc = new Y.Doc();
    this.writes = new DocWriteGuard(matrixClient, {
      onGiveUp: 'reject',
      ...cfg.provider.writeRetry,
    });
  }

  /** Why a write to this document did not reach the room, if one did not. */
  public get writeFailure(): DocWriteFailure | undefined {
    if (this.writes.failure) return this.writes.failure;
    if (this.provider && !this.provider.canWrite)
      return { kind: 'forbidden', detail: 'the homeserver rejected the write' };
    return undefined;
  }

  /**
   * Wait (bounded by {@link DOC_FLUSH_TIMEOUT_MS}) until every change made to
   * the doc so far has been sent, and report a write that did not land.
   */
  public async flush(): Promise<DocWriteFailure | undefined> {
    const provider = this.provider;
    if (!provider || !this.providerInitialized) return this.writeFailure;
    try {
      await withDeadline(
        provider.waitForFlush(),
        DOC_FLUSH_TIMEOUT_MS,
        `changes were not sent within ${DOC_FLUSH_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      this.flushTimedOut = true;
      return (
        this.writeFailure ?? {
          kind: 'unsent',
          detail: errorDetail(error),
          mayHaveLanded: true,
        }
      );
    }
    return this.writeFailure;
  }

  public get ydoc(): Y.Doc {
    return this.doc;
  }

  public get matrixProvider(): MatrixProvider | undefined {
    return this.provider;
  }

  /**
   * Initialize the provider for the configured room.
   *
   * Assumes the Matrix client is already synced (via EditorMatrixClient singleton).
   * Creates a MatrixProvider to sync the Y.Doc with the Matrix room.
   */
  public async init(): Promise<ProviderInitResult> {
    if (this.disposed) {
      throw new Error('MatrixProviderManager was already disposed');
    }

    const attempts = Math.max(1, this.cfg.provider.retryAttempts);
    const delayMs = Math.max(0, this.cfg.provider.retryDelayMs);

    let rejoined = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.disposed)
        throw new Error('MatrixProviderManager was disposed during the load');
      try {
        // Join, history walk and availability share one deadline: a request
        // that never answers must fail the attempt, not hang it.
        const timeoutMs = this.cfg.matrix.initialSyncTimeoutMs;
        this.attempt = attempt;
        await withDeadline(
          (async () => {
            await this.initializeProvider(attempt);
            await this.waitForAvailability(timeoutMs);
          })(),
          timeoutMs,
          `Document did not load within ${timeoutMs}ms. Check room permissions or connectivity.`,
        );

        logger.log('Matrix provider initialized', { attempt });
        logger.log(`📄 Y.Doc GUID: ${this.doc.guid}`);
        logger.log(`📄 Room ID: ${JSON.stringify(this.cfg.matrix.room)}`);

        return {
          doc: this.doc,
          awareness: this.provider?.awarenessInstance,
          provider: this.ensureProvider(),
          writes: this.writes,
        };
      } catch (error) {
        logger.warn(`Matrix provider init attempt ${attempt} failed`, error);
        await this.cleanupProvider();

        this.attempt = 0;
        // Refused after skipping the join: the remembered membership is
        // stale. Join and run this attempt again, once.
        if (
          !rejoined &&
          !this.disposed &&
          this.joinSkipped &&
          this.loadingRoomId &&
          isAccessRefusal(error)
        ) {
          rejoined = true;
          forgetJoinedRoom(this.matrixClient, this.loadingRoomId);
          attempt -= 1;
          continue;
        }
        if (
          attempt === attempts ||
          this.disposed ||
          !isRetryableLoadError(error)
        ) {
          throw error;
        }

        const backoff = delayMs * attempt;
        logger.log(`Retrying provider initialization in ${backoff}ms`);
        await wait(backoff, this.disposal.signal);
      }
    }

    throw new Error('Matrix provider initialization failed');
  }

  /**
   * Ensures the room is available in the Matrix client's store.
   * This is critical for createMessagesRequest() to work correctly.
   */
  private async ensureRoomAvailable(roomId: string): Promise<void> {
    const room = this.matrixClient.getRoom(roomId);
    const joined = joinedRooms.get(this.matrixClient);
    const joinedAt = joined?.get(roomId);
    this.loadingRoomId = roomId;
    this.joinSkipped =
      !room &&
      joinedAt !== undefined &&
      this.now() - joinedAt < JOIN_REUSE_WINDOW_MS;
    if (this.joinSkipped) {
      logger.debug?.(`Room ${roomId} joined by this client moments ago`);
      return;
    }

    if (!room) {
      logger.warn(
        `Room ${roomId} not in client store, attempting to join/peek...`,
      );

      try {
        // Try joining first — peek fails when room previews are disabled
        await this.matrixClient.joinRoom(roomId);
        logger.log(`Successfully joined room ${roomId}`);
        if (joined) joined.set(roomId, this.now());
        else
          joinedRooms.set(this.matrixClient, new Map([[roomId, this.now()]]));
      } catch (joinError) {
        logger.warn(joinError);
        // Fall back to peek if join fails (e.g. already joined but not synced)
        try {
          await this.matrixClient.peekInRoom(roomId);
          logger.log(`Successfully peeked into room ${roomId}`);
        } catch (peekError) {
          const errorMsg =
            peekError instanceof Error ? peekError.message : String(peekError);
          throw new RoomNotAccessibleError(roomId, errorMsg);
        }
      }
    } else {
      logger.debug?.(`Room ${roomId} found in client store`);
    }
  }

  /** True when this load attempt was superseded (timed out) or the manager disposed. */
  private isStale(attempt: number): boolean {
    return this.disposed || this.attempt !== attempt;
  }

  private async initializeProvider(attempt: number) {
    this.cleanupProviderListeners();

    const roomDescriptor = this.resolveRoomDescriptor();

    // Resolve room ID (handle both 'id' and 'alias' types)
    let roomId: string;
    if (roomDescriptor.type === 'id') {
      roomId = roomDescriptor.id;
    } else {
      // Resolve room alias to room ID
      const ret = await this.matrixClient.getRoomIdForAlias(
        roomDescriptor.alias,
      );
      roomId = ret.room_id;
    }

    // Ensure the room is in the client's store before proceeding
    // This is critical for MatrixProvider to fetch room history correctly
    await this.ensureRoomAvailable(roomId);
    if (this.isStale(attempt))
      throw new Error('Document load was cancelled or timed out');

    logger.log('Creating MatrixProvider', roomDescriptor);

    this.providerInitialized = false;
    this.provider = new MatrixProvider(
      this.doc,
      this.writes.client,
      roomDescriptor,
      {
        enableAwareness: this.cfg.provider.enableAwareness,
        reader: {
          snapshotInterval: 10,
        },

        // A rejected write is final within one request — room power levels do
        // not change mid-call — so retry once, fast, instead of matrix-crdt's
        // default 3 attempts 30s apart. Without this a caller awaiting
        // `waitForFlush()` before reporting success would block for ~90s.
        writer: {
          flushInterval: this.cfg.provider.flushInterval ?? 10,
          retryIfForbiddenInterval:
            this.cfg.provider.retryIfForbiddenInterval ?? 1_000,
          maxForbiddenRetries: this.cfg.provider.maxForbiddenRetries ?? 1,
        },
      },
    );

    const provider = this.provider;
    this.registerProviderListeners(provider);

    await provider.initialize();
    if (this.isStale(attempt)) {
      // The attempt timed out (or the manager closed) while the history was
      // loading; this provider is no longer tracked, so stop it here.
      provider.dispose();
      throw new Error('Document load was cancelled or timed out');
    }
    this.providerInitialized = true;
  }

  private waitForAvailability(timeoutMs: number): Promise<void> {
    if (this.documentAvailable) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const signal = this.disposal.signal;
      const settle = (error?: Error) => {
        clearTimeout(timeoutHandle);
        signal.removeEventListener('abort', onDispose);
        this.availabilityResolvers = this.availabilityResolvers.filter(
          (candidate) => candidate !== resolver,
        );
        if (error) reject(error);
        else resolve();
      };
      const timeoutHandle = setTimeout(
        () =>
          settle(
            new Error(
              `Document did not become available within ${timeoutMs}ms. Check room permissions or connectivity.`,
            ),
          ),
        timeoutMs,
      );
      // Disposal ends the wait at once instead of leaving its timer running.
      const onDispose = () =>
        settle(new Error('MatrixProviderManager was disposed'));
      const resolver = () => settle();

      if (signal.aborted) return onDispose();
      signal.addEventListener('abort', onDispose, { once: true });
      this.availabilityResolvers.push(resolver);
    });
  }

  private registerProviderListeners(provider: MatrixProvider) {
    this.disposables.push(
      provider.onDocumentAvailable(() => {
        // matrix-crdt applies the whole catch-up history to the doc before it
        // fires this event, so the content is already in place.
        logger.log('Matrix document available');
        this.documentAvailable = true;
        const resolvers = [...this.availabilityResolvers];
        this.availabilityResolvers = [];
        resolvers.forEach((resolver) => resolver());
      }),
    );

    this.disposables.push(
      provider.onDocumentUnavailable(() => {
        logger.warn('Matrix document unavailable');
        this.documentAvailable = false;
      }),
    );

    this.disposables.push(
      provider.onReceivedEvents(() => {
        logger.debug?.('Received Matrix events - Y.Doc syncing content');
      }),
    );
  }

  private cleanupProviderListeners() {
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      try {
        disposable?.dispose();
      } catch (error) {
        logger.warn('Failed to dispose provider listener', error);
      }
    }
  }

  private resolveRoomDescriptor(): RoomDescriptor {
    if (this.cfg.matrix.room.type === 'id') {
      return { type: 'id', id: this.cfg.matrix.room.value };
    }

    return { type: 'alias', alias: this.cfg.matrix.room.value };
  }

  private ensureProvider(): MatrixProvider {
    if (!this.provider) {
      throw new Error('Matrix provider not initialized');
    }
    return this.provider;
  }

  /**
   * Dispose of this provider manager.
   *
   * Cleans up:
   * - MatrixProvider (stops polling, removes listeners)
   * - Y.Doc (destroys local document state)
   *
   * Does NOT touch the Matrix client - it's managed by EditorMatrixClient singleton
   * and shared across all providers/rooms.
   */
  public async dispose() {
    if (this.disposed) {
      return;
    }

    logger.log('Disposing Matrix provider manager');

    // Mark first so an initialisation still in flight stops at its next step.
    this.disposed = true;
    this.disposal.abort();

    // Clean up provider and Y.Doc
    await this.cleanupProvider();
    this.writes.close();
    this.doc.destroy();

    // NOTE: We NEVER call matrixClient.stopClient() here!
    // The Matrix client is managed by EditorMatrixClient singleton
    // and is shared across all rooms. Stopping it would break
    // all other active providers.
  }

  /**
   * Dispose the current provider. Pending writes are flushed first (bounded)
   * only when the provider finished loading: before that, matrix-crdt's
   * `waitForFlush()` waits for an initialisation that will never complete.
   */
  private async cleanupProvider() {
    this.cleanupProviderListeners();

    if (this.provider) {
      const provider = this.provider;
      try {
        // Once a write has failed or a flush has timed out, waiting again
        // only delays disposal; closing the guard drops what is left.
        if (
          this.providerInitialized &&
          !this.flushTimedOut &&
          !this.writeFailure
        )
          await this.flush();
      } catch (error) {
        logger.warn('Error while flushing MatrixProvider', error);
      }
      try {
        provider.dispose();
      } catch (error) {
        logger.warn('Error while disposing MatrixProvider', error);
      } finally {
        this.provider = undefined;
        this.providerInitialized = false;
      }
    }

    if (!this.documentAvailable) {
      return;
    }

    this.documentAvailable = false;
  }
}
