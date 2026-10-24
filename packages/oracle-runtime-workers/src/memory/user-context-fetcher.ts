import { z } from 'zod';
import type { Logger, UserContextData } from '../plugin-api/types';
import {
  memorySearchSchema,
  memoryContext,
  retainedMemory,
  sameMemoryStamp,
  type MemoryStamp,
  type RetainedMemory,
} from './retained-context';

export const USER_CONTEXT_SLOTS = [
  'identity',
  'work',
  'goals',
  'interests',
  'relationships',
  'recent',
] as const;
export type UserContextSlot = (typeof USER_CONTEXT_SLOTS)[number];
export const USER_CONTEXT_MAX_JSON_CHARS = 16_384;

export function buildUserContextQueries() {
  return [
    {
      scope: 'personal',
      query:
        'Who is the user — their name, age, background, personality traits, communication style, beliefs, values, and the core attributes that define how they see themselves and how they like to be addressed.',
      limit: 12,
    },
    {
      scope: 'personal',
      query:
        'What the user works on — their job and role, current and past projects, the tools and technologies they use, code or systems they build, technical problems they solve (migrations, refactors, bug fixes, integrations), and the people they collaborate with at work.',
      limit: 15,
    },
    {
      scope: 'personal',
      query:
        'What the user is trying to achieve or improve — goals and aspirations they have stated, things they are learning, habits and routines they are building, milestones they are working toward, and causes they care about.',
      limit: 10,
    },
    {
      scope: 'personal',
      query:
        'What the user enjoys, cares about, or finds interesting — hobbies, favorite topics, preferences, products and content they engage with, things they like and dislike, and areas they have built expertise in outside of work.',
      limit: 10,
    },
    {
      scope: 'personal',
      query:
        'People the user interacts with or has mentioned — colleagues they work with, collaborators on projects, friends and family members, and any named individuals or groups they have brought up in conversation.',
      limit: 10,
    },
    {
      scope: 'personal',
      query:
        'What the user has been doing, focusing on, or talking about recently — current activities, decisions they have made, ongoing problems they are working through, and topics that have come up in recent conversations.',
      limit: 15,
    },
  ];
}

function perSlot<T>(
  fn: (slot: UserContextSlot, index: number) => T,
): Record<UserContextSlot, T> {
  return {
    identity: fn('identity', 0),
    work: fn('work', 1),
    goals: fn('goals', 2),
    interests: fn('interests', 3),
    relationships: fn('relationships', 4),
    recent: fn('recent', 5),
  };
}

export interface UserContextFetcherDeps {
  /** `MEMORY_ENGINE_URL`; undefined → every call is `skipped`, no request. */
  memoryEngineUrl: string | undefined;
  /** `ORACLE_DID` — the knowledge space the queries search (`oracle_dids`). */
  oracleDid: string;
  /** The user's UCAN surface, bound to the user's DID by the caller. */
  ucan: {
    hasSigningKey(): boolean;
    resolveServiceDid(serviceUrl: string): Promise<string | null>;
    mintInvocation(
      target: { did: string; capability: string },
      opts?: { can?: string; skipCache?: boolean },
    ): Promise<string>;
  };
  stamp?: (params: UserContextFetchParams) => Promise<MemoryStamp | undefined>;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Clock for cache ages and timings (default `Date.now`). */
  now?: () => number;
}

export interface UserContextFetcherOptions {
  /** How long `fetch` waits for the gather (default 3 s; 0 = never wait). */
  blockingCapMs?: number;
  /** Positive cache lifetime per room (default 5 min). */
  cacheTtlMs?: number;
  /**
   * Cache lifetime of an answer with nothing to render (default 30 s, never
   * longer than `cacheTtlMs`).
   */
  emptyCacheTtlMs?: number;
  /** Negative cache lifetime per room after a transport failure (default 60 s). */
  failureTtlMs?: number;
  /** Hard timeout of the batch request itself (default 30 s). */
  requestTimeoutMs?: number;
  /** Rooms kept in the cache, least recently used evicted first (default 64). */
  maxCachedRooms?: number;
}

export const USER_CONTEXT_BLOCKING_CAP_MS_DEFAULT = 3_000;
export const USER_CONTEXT_CACHE_TTL_MS_DEFAULT = 300_000;
const DEFAULT_EMPTY_CACHE_TTL_MS = 30_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CACHED_ROOMS = 64;

export type UserContextSkipReason =
  | 'no-engine-url'
  | 'no-signing-key'
  | 'no-invocation'
  | 'recently-failed'
  | 'no-room';

export type UserContextFetchOutcome =
  | { kind: 'cached'; context: UserContextData; ageMs: number }
  | {
      kind: 'fresh';
      context: UserContextData;
      ms: number;
      /** Per slot `f12/e8/p3/c1` (rendered counts) or `missing`. */
      slots: Record<UserContextSlot, string>;
    }
  /** The gather outlived the cap; it keeps running and warms the cache. */
  | { kind: 'timeout'; capMs: number }
  /** Transport failure or every slot failed; negative-cached for `failureTtlMs`. */
  | { kind: 'failed'; reason: string }
  | { kind: 'skipped'; reason: UserContextSkipReason };

export interface UserContextFetchParams {
  roomId: string;
  userDid: string;
  sessionId: string;
}

export interface UserContextStatus {
  cached: boolean;
  ageMs?: number;
  inFlight: boolean;
  lastOutcome?: UserContextFetchOutcome;
  lastAt?: number;
}

/** What a gather settles with (it never rejects). */
type GatherResult = Extract<
  UserContextFetchOutcome,
  { kind: 'fresh' } | { kind: 'failed' } | { kind: 'skipped' }
>;

interface InFlightGather {
  promise: Promise<GatherResult>;
  /** `now()` when the gather started; a gather older than its request timeout plus grace is treated as lost. */
  startedAt: number;
}

/**
 * Grace past `requestTimeoutMs` before an unsettled gather is given up on.
 * A gather settles within its request timeout; one that has not after this
 * long never will (its request context is gone), and a room must not keep
 * joining it.
 */
const STALE_GATHER_GRACE_MS = 5_000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Insert as most recent; evict the least recent entries beyond `max`. */
function lruSet<V>(map: Map<string, V>, key: string, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export class UserContextFetcher {
  private readonly cache = new Map<
    string,
    { context: UserContextData; at: number; ttlMs: number }
  >();

  /** Room → time the negative-cache entry expires. */
  private readonly failures = new Map<string, number>();

  private readonly inFlight = new Map<string, InFlightGather>();

  private readonly lastOutcomes = new Map<
    string,
    { outcome: UserContextFetchOutcome; at: number }
  >();

  private readonly fetchImpl: typeof fetch;

  private readonly now: () => number;

  private readonly blockingCapMs: number;

  private readonly cacheTtlMs: number;

  private readonly emptyCacheTtlMs: number;

  private readonly failureTtlMs: number;

  private readonly requestTimeoutMs: number;

  private readonly maxCachedRooms: number;

  constructor(
    private readonly deps: UserContextFetcherDeps,
    options: UserContextFetcherOptions = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
    this.blockingCapMs =
      options.blockingCapMs ?? USER_CONTEXT_BLOCKING_CAP_MS_DEFAULT;
    this.cacheTtlMs = options.cacheTtlMs ?? USER_CONTEXT_CACHE_TTL_MS_DEFAULT;
    this.emptyCacheTtlMs = Math.min(
      options.emptyCacheTtlMs ?? DEFAULT_EMPTY_CACHE_TTL_MS,
      this.cacheTtlMs,
    );
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxCachedRooms = Math.max(
      1,
      options.maxCachedRooms ?? DEFAULT_MAX_CACHED_ROOMS,
    );
  }

  /**
   * Blocking path for a first turn: resolves within `blockingCapMs` and
   * never throws.
   */
  async fetch(
    params: UserContextFetchParams,
  ): Promise<UserContextFetchOutcome> {
    const { roomId, sessionId } = params;
    const { logger } = this.deps;

    let gather: Promise<GatherResult>;
    try {
      const cached = this.readCache(roomId);
      if (cached) {
        const memory = retainedMemory(cached.context);
        const stamp = await this.deps.stamp?.(params);
        if (
          memory &&
          stamp &&
          sameMemoryStamp(
            { ...memory.stamp, sessionId: stamp.sessionId },
            stamp,
          )
        ) {
          return this.record(roomId, {
            ...cached,
            context: memoryContext({ ...memory, stamp }),
          });
        }
        if (!memory && stamp) return this.record(roomId, cached);
        this.invalidate(roomId);
      }

      const started = this.startOrJoin(params);
      if (!('promise' in started)) return this.record(roomId, started);
      gather = started.promise;
    } catch (err) {
      return this.record(roomId, { kind: 'failed', reason: describe(err) });
    }

    const capMs = this.blockingCapMs;
    if (capMs <= 0) {
      logger.log(
        `[user-context] not waiting (cap 0) for room=${roomId} session=${sessionId}; gathering in the background`,
      );
      return this.record(roomId, { kind: 'timeout', capMs: 0 });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), capMs);
    });
    const winner = await Promise.race([gather, cap]);
    if (timer !== undefined) clearTimeout(timer);

    if (winner === 'timeout') {
      logger.warn(
        `[user-context] exceeded ${capMs}ms cap for room=${roomId}; continuing in the background`,
      );
      return this.record(roomId, { kind: 'timeout', capMs });
    }
    return winner;
  }

  /**
   * Non-blocking refresh for later turns: starts (or joins) the gather
   * unless the cache is fresh or the room recently failed. Never rejects;
   * the returned promise settles when the gather does, so the caller can
   * hand it to `ctx.waitUntil`.
   */
  refresh(params: UserContextFetchParams): Promise<void> {
    try {
      if (this.readCache(params.roomId)) return Promise.resolve();
      const started = this.startOrJoin(params);
      if (!('promise' in started)) return Promise.resolve();
      return started.promise.then(
        () => undefined,
        () => undefined,
      );
    } catch (err) {
      this.deps.logger.warn(`[user-context] refresh failed: ${describe(err)}`);
      return Promise.resolve();
    }
  }

  /** Cache / in-flight state of one room, for `/debug/context` and tests. */
  status(roomId: string): UserContextStatus {
    const cached = this.readCache(roomId, false);
    const last = this.lastOutcomes.get(roomId);
    return {
      cached: Boolean(cached),
      ...(cached ? { ageMs: cached.ageMs } : {}),
      inFlight: this.inFlight.has(roomId),
      ...(last ? { lastOutcome: last.outcome, lastAt: last.at } : {}),
    };
  }

  /**
   * Forget a room's cached answer and failure marker. A gather already in
   * flight is detached: it still completes but no longer writes the cache,
   * and the next call starts a new one.
   */
  invalidate(roomId: string): void {
    this.cache.delete(roomId);
    this.failures.delete(roomId);
    this.inFlight.delete(roomId);
  }

  private readCache(
    roomId: string,
    touch = true,
  ): { kind: 'cached'; context: UserContextData; ageMs: number } | undefined {
    const entry = this.cache.get(roomId);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.at;
    if (ageMs >= entry.ttlMs) {
      this.cache.delete(roomId);
      return undefined;
    }
    if (touch) lruSet(this.cache, roomId, entry, this.maxCachedRooms);
    return { kind: 'cached', context: entry.context, ageMs };
  }

  private recentlyFailed(roomId: string): boolean {
    const until = this.failures.get(roomId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.failures.delete(roomId);
    return false;
  }

  /**
   * Join the room's gather, or start one when the prerequisites hold.
   * Synchronous up to registering the gather, so a `refresh` called right
   * after `fetch` joins instead of duplicating the request.
   */
  private startOrJoin(
    params: UserContextFetchParams,
  ): InFlightGather | Extract<UserContextFetchOutcome, { kind: 'skipped' }> {
    const { roomId } = params;
    const { logger } = this.deps;
    const engineUrl = this.deps.memoryEngineUrl?.replace(/\/+$/, '');
    if (!engineUrl) {
      logger.debug?.(
        `[user-context] skipped: MEMORY_ENGINE_URL not configured`,
      );
      return { kind: 'skipped', reason: 'no-engine-url' };
    }
    if (!roomId) {
      logger.warn(`[user-context] skipped: no oracle room for this turn`);
      return { kind: 'skipped', reason: 'no-room' };
    }

    const existing = this.inFlight.get(roomId);
    if (existing) {
      const ageMs = this.now() - existing.startedAt;
      if (ageMs <= this.requestTimeoutMs + STALE_GATHER_GRACE_MS) {
        return existing;
      }
      // Lost: never settled within its own timeout. Detach it (a late
      // settle must not repopulate the room) and gather again.
      logger.warn(
        `[user-context] gather for room=${roomId} unsettled after ${ageMs}ms; starting a new one`,
      );
      this.inFlight.delete(roomId);
    }

    if (this.recentlyFailed(roomId)) {
      logger.log(
        `[user-context] skipped: recent failure for room=${roomId} (retry within ${Math.round(this.failureTtlMs / 1000)}s)`,
      );
      return { kind: 'skipped', reason: 'recently-failed' };
    }
    if (!this.deps.ucan.hasSigningKey()) {
      logger.warn(
        `[user-context] skipped: no UCAN signing key; no memory engine invocation for room=${roomId}`,
      );
      return { kind: 'skipped', reason: 'no-signing-key' };
    }

    const entry: InFlightGather = {
      startedAt: this.now(),
      promise: this.gather(params).then(
        (result) => this.settle(roomId, entry, result),
        (err: unknown) =>
          this.settle(roomId, entry, {
            kind: 'failed',
            reason: describe(err),
          }),
      ),
    };
    this.inFlight.set(roomId, entry);
    return entry;
  }

  /** Book a finished gather: cache, failure marker, last outcome. */
  private settle(
    roomId: string,
    entry: InFlightGather,
    result: GatherResult,
  ): GatherResult {
    // An invalidated (detached) gather must not repopulate the room.
    if (this.inFlight.get(roomId) !== entry)
      return { kind: 'failed', reason: 'memory generation changed' };
    this.inFlight.delete(roomId);
    if (result.kind === 'fresh') {
      this.failures.delete(roomId);
      const empty = Object.keys(result.context).length === 0;
      lruSet(
        this.cache,
        roomId,
        {
          context: result.context,
          at: this.now(),
          ttlMs: empty ? this.emptyCacheTtlMs : this.cacheTtlMs,
        },
        this.maxCachedRooms,
      );
    } else if (result.kind === 'failed') {
      lruSet(
        this.failures,
        roomId,
        this.now() + this.failureTtlMs,
        this.maxCachedRooms,
      );
    }
    this.record(roomId, result);
    return result;
  }

  private record<T extends UserContextFetchOutcome>(
    roomId: string,
    outcome: T,
  ): T {
    lruSet(
      this.lastOutcomes,
      roomId,
      { outcome, at: this.now() },
      this.maxCachedRooms,
    );
    return outcome;
  }

  invalidateAll(): void {
    this.cache.clear();
    this.failures.clear();
    this.inFlight.clear();
  }

  async current(
    value: unknown,
    params: UserContextFetchParams,
  ): Promise<UserContextData> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UserContextData>((resolve) => {
      timer = setTimeout(() => resolve({}), Math.max(1, this.blockingCapMs));
    });
    try {
      return await Promise.race([this.verifyCurrent(value, params), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async verifyCurrent(
    value: unknown,
    params: UserContextFetchParams,
  ): Promise<UserContextData> {
    const memory = retainedMemory(value);
    if (!memory || memory.facts.length === 0) return {};
    try {
      const stamp = await this.deps.stamp?.(params);
      if (!stamp || !sameMemoryStamp(memory.stamp, stamp)) return {};
      const refs = [
        ...new Map(
          memory.facts.map((fact) => [
            fact.reference,
            { reference: fact.reference, revision: fact.revision },
          ]),
        ).values(),
      ];
      if (
        memory.facts.some(
          (fact) =>
            refs.find((ref) => ref.reference === fact.reference)?.revision !==
            fact.revision,
        )
      )
        return {};
      const body = await this.request(
        '/agent/references/check',
        params.roomId,
        { scope: 'personal', references: refs },
      );
      const checked = z
        .object({
          representation: z.literal(1),
          scope: memorySearchSchema.shape.scope,
          valid: z.literal(true),
          observedAt: z.string().datetime(),
        })
        .safeParse(body);
      const after = await this.deps.stamp?.(params);
      if (
        !checked.success ||
        checked.data.scope.userDid !== params.userDid ||
        checked.data.scope.oracleDid !== this.deps.oracleDid ||
        !after ||
        !sameMemoryStamp(stamp, after)
      )
        return {};
      return memoryContext(memory);
    } catch {
      return {};
    }
  }

  private async request(
    path: string,
    roomId: string,
    body: unknown,
  ): Promise<unknown> {
    const engineUrl = this.deps.memoryEngineUrl?.replace(/\/+$/, '');
    if (!engineUrl) throw new Error('memory engine unavailable');
    const did = await this.deps.ucan.resolveServiceDid(engineUrl);
    const origin = new URL(engineUrl);
    const expectedDid = `did:web:${origin.host.replace(/:/g, '%3A')}`;
    if (did !== expectedDid) throw new Error('memory service DID mismatch');
    const invocation = await this.deps.ucan.mintInvocation(
      { did, capability: 'ixo:memory' },
      { can: 'memory/search', skipCache: true },
    );
    const response = await this.fetchImpl(`${engineUrl}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${invocation}`,
        'X-Auth-Type': 'ucan',
        'x-room-id': roomId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        path === '/agent/references/check'
          ? Math.min(this.requestTimeoutMs, Math.max(1, this.blockingCapMs))
          : this.requestTimeoutMs,
      ),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`memory engine answered ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error('malformed memory response');
    }
  }

  private async gather(params: UserContextFetchParams): Promise<GatherResult> {
    const start = this.now();
    try {
      const stamp = await this.deps.stamp?.(params);
      if (!stamp) return { kind: 'skipped', reason: 'no-invocation' };
      const body = await this.request('/agent/search-batch', params.roomId, {
        queries: buildUserContextQueries(),
      });
      const batch = z
        .object({
          representation: z.literal(1),
          results: z.array(z.unknown()).length(6),
        })
        .safeParse(body);
      if (!batch.success)
        return this.failed(
          params.roomId,
          'malformed response (no six-slot results array)',
        );
      const facts: RetainedMemory['facts'] = [];
      let answered = 0;
      const slots = perSlot((slot, index) => {
        const result = memorySearchSchema.safeParse(batch.data.results[index]);
        if (
          !result.success ||
          result.data.scope.userDid !== params.userDid ||
          result.data.scope.oracleDid !== this.deps.oracleDid
        )
          return 'missing';
        answered += 1;
        for (const fact of result.data.facts) {
          if (
            fact.scope.userDid !== params.userDid ||
            fact.scope.oracleDid !== this.deps.oracleDid
          )
            continue;
          const candidate = { ...fact, slot };
          if (
            JSON.stringify(
              memoryContext({ stamp, facts: [...facts, candidate] }),
            ).length <= USER_CONTEXT_MAX_JSON_CHARS
          )
            facts.push(candidate);
        }
        return `f${facts.filter((fact) => fact.slot === slot).length}/e0/p0/c0`;
      });
      const after = await this.deps.stamp?.(params);
      if (!after || !sameMemoryStamp(stamp, after))
        return this.failed(params.roomId, 'memory generation or grant changed');
      if (answered === 0)
        return this.failed(params.roomId, 'every slot failed');
      return {
        kind: 'fresh',
        context: facts.length ? memoryContext({ stamp, facts }) : {},
        ms: this.now() - start,
        slots,
      };
    } catch (error) {
      return this.failed(params.roomId, describe(error));
    }
  }

  private failed(
    roomId: string,
    reason: string,
  ): Extract<GatherResult, { kind: 'failed' }> {
    this.deps.logger.warn(
      `[user-context] failed for room=${roomId}: ${reason} (not retried for ${Math.round(this.failureTtlMs / 1000)}s)`,
    );
    return { kind: 'failed', reason };
  }
}
