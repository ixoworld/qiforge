/**
 * First-turn user-context prefetch — the Workers port of the Node runtime's
 * `UserContextFetcher` plus `@ixo/common`'s
 * `MemoryEngineService.gatherUserContext`.
 *
 * Six memory-engine queries (identity, work, goals, interests,
 * relationships, recent) go out in one `POST /search-enhanced-batch`; the
 * answers fill `state.userContext`, which the prompt composer renders as the
 * memory-context block before the model's first call.
 *
 * Policy:
 *  - The result is a function of the room (and the oracle's domain entity,
 *    which keys every memory space on the engine), not the session,
 *    so the cache is keyed by room: a new session in the same room reuses it.
 *    Positive entries live `cacheTtlMs` (5 min) in an LRU of `maxCachedRooms`.
 *    A successful batch is cached even when every slot is empty — "no
 *    memory yet" is a valid answer — but only for `emptyCacheTtlMs` (30 s):
 *    the user's first memories should show up soon after they are written.
 *  - A transport failure (HTTP error, abort, thrown fetch, malformed body)
 *    or a batch whose every slot failed is negative-cached for
 *    `failureTtlMs` (60 s), checked AFTER the positive cache so a late
 *    success wins over an earlier failure. A degraded engine costs one
 *    attempt per window, not one per turn. A failure reason never carries
 *    the engine's response body.
 *  - `invalidate(room)` drops the room's answer; the runtime calls it after
 *    a memory write and after session history is indexed.
 *  - A missing signing key or a failed invocation mint is a skip, never a
 *    negative-cache entry: the user may delegate `ixo:memory` before the next
 *    turn. So is a missing domain entity (`ORACLE_ENTITY_DID`): the engine
 *    refuses a request that names none, so none is sent; it is warned about
 *    once per fetcher.
 *  - One gather per room at a time; a second caller joins it. The blocking
 *    `fetch` waits at most `blockingCapMs`; past the cap the gather keeps
 *    running and fills the cache for later turns (the caller keeps the
 *    object alive with `ctx.waitUntil(refresh(...))`).
 *  - Stored slots are trimmed to what the composer renders, every stored
 *    string is capped at `USER_CONTEXT_MAX_TEXT_CHARS`, and the whole
 *    context is held under `USER_CONTEXT_MAX_JSON_CHARS` (episodes go
 *    first, then entity summaries), so the checkpointed state stays small;
 *    a slot with nothing to render is omitted.
 *
 * Nothing here touches Workers globals at module scope: timers, `fetch` and
 * `AbortSignal.timeout` only run inside request-time calls.
 */
import type { MemoryContextSection } from '../core/prompt-composer';
import type { Logger, UserContextData } from '../plugin-api/types';
import { MEMORY_ENTITY_HEADER } from '../plugins/memory/memory-entity';
import type {
  ComparisonOperator,
  EntityType,
  KnowledgeLevel,
  SearchStrategy,
} from '../plugins/memory/types';

// ─── Slots and queries ────────────────────────────────────────────────────────

/** Query order of the batch; the response's `results` follow it. */
export const USER_CONTEXT_SLOTS = [
  'identity',
  'work',
  'goals',
  'interests',
  'relationships',
  'recent',
] as const;

export type UserContextSlot = (typeof USER_CONTEXT_SLOTS)[number];

/** The memory engine's date filter; `date: null` pairs with `IS NULL`. */
export interface UserContextDateFilter {
  date: string | null;
  comparison_operator: ComparisonOperator;
}

/** One `/search-enhanced` request inside the batch. */
export interface UserContextQuery {
  oracle_dids: string[];
  query: string;
  strategy: SearchStrategy;
  max_facts: number;
  max_entities: number;
  max_episodes: number;
  max_communities: number;
  knowledge_level: KnowledgeLevel;
  search_filters: {
    node_labels?: EntityType[];
    invalid_at?: UserContextDateFilter[][];
    created_at?: UserContextDateFilter[][];
  };
}

/** Superseded facts carry an `invalid_at`; every slot but `recent` drops them. */
const CURRENT_FACTS_ONLY: UserContextDateFilter[][] = [
  [{ date: null, comparison_operator: 'IS NULL' }],
];

const RECENT_WINDOW_DAYS = 90;

/**
 * The six requests, identical to `@ixo/common`'s `MemoryEngineService`
 * builders: natural-language queries (embedding search ranks sentences
 * better than keyword bags), no `edge_types` (AND-ed with labels, too
 * brittle), `node_labels` only where it discriminates, and the `recent`
 * slot bounded to the last 90 days explicitly (the server's
 * `recent_memory` strategy injects the same lower bound and keeps an
 * existing one). `oracle_dids` names the oracle's domain entity.
 */
export function buildUserContextQueries(
  entityDid: string,
  now: Date,
): UserContextQuery[] {
  const recentSince = new Date(now.getTime());
  recentSince.setUTCDate(recentSince.getUTCDate() - RECENT_WINDOW_DAYS);
  // The wire name predates entity keying; the engine reads its entries as
  // domain entity DIDs (the knowledge spaces the queries also search).
  const oracle_dids = [entityDid];
  return [
    {
      oracle_dids,
      query:
        'Who is the user — their name, age, background, personality traits, communication style, beliefs, values, and the core attributes that define how they see themselves and how they like to be addressed.',
      strategy: 'balanced',
      max_facts: 12,
      max_entities: 8,
      max_episodes: 3,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: {
        node_labels: [
          'Person',
          'Trait',
          'Value',
          'Identity',
          'Attribute',
          'Belief',
          'CommunicationStyle',
          'Language',
        ],
        invalid_at: CURRENT_FACTS_ONLY,
      },
    },
    {
      oracle_dids,
      query:
        'What the user works on — their job and role, current and past projects, the tools and technologies they use, code or systems they build, technical problems they solve (migrations, refactors, bug fixes, integrations), and the people they collaborate with at work.',
      strategy: 'balanced',
      max_facts: 15,
      max_entities: 10,
      max_episodes: 5,
      max_communities: 2,
      knowledge_level: 'both',
      search_filters: { invalid_at: CURRENT_FACTS_ONLY },
    },
    {
      oracle_dids,
      query:
        'What the user is trying to achieve or improve — goals and aspirations they have stated, things they are learning, habits and routines they are building, milestones they are working toward, and causes they care about.',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: { invalid_at: CURRENT_FACTS_ONLY },
    },
    {
      oracle_dids,
      query:
        'What the user enjoys, cares about, or finds interesting — hobbies, favorite topics, preferences, products and content they engage with, things they like and dislike, and areas they have built expertise in outside of work.',
      strategy: 'balanced',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: { invalid_at: CURRENT_FACTS_ONLY },
    },
    {
      oracle_dids,
      query:
        'People the user interacts with or has mentioned — colleagues they work with, collaborators on projects, friends and family members, and any named individuals or groups they have brought up in conversation.',
      strategy: 'balanced',
      max_facts: 8,
      max_entities: 10,
      max_episodes: 3,
      max_communities: 1,
      knowledge_level: 'both',
      search_filters: { invalid_at: CURRENT_FACTS_ONLY },
    },
    {
      oracle_dids,
      query:
        'What the user has been doing, focusing on, or talking about recently — current activities, decisions they have made, ongoing problems they are working through, and topics that have come up in recent conversations.',
      strategy: 'recent_memory',
      max_facts: 10,
      max_entities: 6,
      max_episodes: 8,
      max_communities: 2,
      knowledge_level: 'both',
      // No node_labels: recent activity can be of any type.
      search_filters: {
        created_at: [
          [
            {
              date: recentSince.toISOString(),
              comparison_operator: '>=',
            },
          ],
        ],
      },
    },
  ];
}

// ─── Trimming ─────────────────────────────────────────────────────────────────

export interface UserContextTotals {
  facts: number;
  entities: number;
  episodes: number;
  communities: number;
}

/**
 * A `/search-enhanced` answer as far as trimming needs it. Elements are
 * `unknown` because they come straight from JSON; `trimUserContextSlot`
 * keeps only well-formed ones. `@ixo/common`'s `SearchEnhancedResponse` is
 * assignable to it.
 */
export interface SearchEnhancedResponseLike {
  total_results?: Partial<UserContextTotals>;
  facts?: readonly unknown[];
  entities?: readonly unknown[];
  episodes?: readonly unknown[];
  communities?: readonly unknown[];
}

/** One stored slot: what the composer renders, plus the engine's totals. */
export type TrimmedUserContextSlot = MemoryContextSection & {
  total_results?: UserContextTotals;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Longest stored fact, summary or episode text (characters, ellipsis included). */
export const USER_CONTEXT_MAX_TEXT_CHARS = 400;

/** Budget of the whole stored context, measured as its JSON length. */
export const USER_CONTEXT_MAX_JSON_CHARS = 16_384;

/**
 * Cap a stored string at `max` characters: cut at the last word boundary
 * inside the limit (or hard, when that would drop more than half) and end
 * with `…`.
 */
export function capUserContextText(
  text: string,
  max: number = USER_CONTEXT_MAX_TEXT_CHARS,
): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const lastSpace = head.search(/\s\S*$/);
  const cut = lastSpace >= max / 2 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}

function readTotals(value: unknown): UserContextTotals | undefined {
  if (!isRecord(value)) return undefined;
  const { facts, entities, episodes, communities } = value;
  if (
    typeof facts !== 'number' ||
    typeof entities !== 'number' ||
    typeof episodes !== 'number' ||
    typeof communities !== 'number'
  )
    return undefined;
  return { facts, entities, episodes, communities };
}

/**
 * Keep the fields the prompt composer reads (`MemoryContextSection`):
 * entities `{name, labels, summary}`, facts `{fact}`, episodes
 * `{content, created_at}`, communities `{name, summary}`. Uuids, group ids
 * and timestamps the prompt never shows are dropped; entries without the
 * text the composer renders are dropped too. Facts, summaries and episode
 * contents are capped at `USER_CONTEXT_MAX_TEXT_CHARS`.
 */
export function trimUserContextSlot(
  slot: SearchEnhancedResponseLike,
): TrimmedUserContextSlot {
  const entities: NonNullable<MemoryContextSection['entities']> = [];
  for (const raw of slot.entities ?? []) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name.trim())
      continue;
    const labels = Array.isArray(raw.labels)
      ? raw.labels.filter((l): l is string => typeof l === 'string')
      : undefined;
    const summary = capped(raw.summary);
    entities.push({
      name: raw.name,
      ...(labels && labels.length > 0 ? { labels } : {}),
      ...(summary ? { summary } : {}),
    });
  }

  const facts: NonNullable<MemoryContextSection['facts']> = [];
  for (const raw of slot.facts ?? []) {
    if (!isRecord(raw)) continue;
    const fact = capped(raw.fact);
    if (fact) facts.push({ fact });
  }

  const episodes: NonNullable<MemoryContextSection['episodes']> = [];
  for (const raw of slot.episodes ?? []) {
    if (!isRecord(raw)) continue;
    const content = capped(raw.content);
    if (!content) continue;
    const createdAt = optionalText(raw.created_at);
    episodes.push({
      content,
      ...(createdAt ? { created_at: createdAt } : {}),
    });
  }

  const communities: NonNullable<MemoryContextSection['communities']> = [];
  for (const raw of slot.communities ?? []) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name.trim())
      continue;
    const summary = capped(raw.summary);
    communities.push({ name: raw.name, ...(summary ? { summary } : {}) });
  }

  const totals = readTotals(slot.total_results);
  return {
    ...(entities.length > 0 ? { entities } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ...(episodes.length > 0 ? { episodes } : {}),
    ...(communities.length > 0 ? { communities } : {}),
    ...(totals ? { total_results: totals } : {}),
  };
}

/** A non-blank string, capped; undefined otherwise. */
function capped(value: unknown): string | undefined {
  const text = optionalText(value);
  return text && text.trim() ? capUserContextText(text) : undefined;
}

function hasContent(slot: TrimmedUserContextSlot): boolean {
  return Boolean(
    slot.entities?.length ||
    slot.facts?.length ||
    slot.episodes?.length ||
    slot.communities?.length,
  );
}

/** `f12/e8/p3/c1`: the rendered counts of a slot, for logs and status. */
function slotSummary(slot: TrimmedUserContextSlot): string {
  return `f${slot.facts?.length ?? 0}/e${slot.entities?.length ?? 0}/p${slot.episodes?.length ?? 0}/c${slot.communities?.length ?? 0}`;
}

export type TrimmedUserContext = Partial<
  Record<UserContextSlot, TrimmedUserContextSlot>
>;

/**
 * Hold a trimmed context under `maxChars` of JSON: drop episodes from the
 * end of each slot, one slot at a time in query order, until it fits; then
 * entity summaries the same way. A slot left with nothing to render is
 * omitted. Facts, entity names and communities are never dropped, so a
 * context made only of those can stay above the budget (each fact is
 * already capped at `USER_CONTEXT_MAX_TEXT_CHARS`, and the engine returns
 * at most 65 across the six queries). The input is not modified.
 */
export function fitUserContextBudget(
  context: TrimmedUserContext,
  maxChars: number = USER_CONTEXT_MAX_JSON_CHARS,
): {
  context: TrimmedUserContext;
  droppedEpisodes: number;
  droppedSummaries: number;
} {
  const work: TrimmedUserContext = {};
  for (const label of USER_CONTEXT_SLOTS) {
    const slot = context[label];
    if (!slot) continue;
    work[label] = {
      ...slot,
      ...(slot.entities
        ? { entities: slot.entities.map((e) => ({ ...e })) }
        : {}),
      ...(slot.episodes ? { episodes: [...slot.episodes] } : {}),
    };
  }
  const over = (): boolean => JSON.stringify(work).length > maxChars;
  /** One drop per slot per round, until it fits or nothing is left to drop. */
  const roundRobin = (
    dropOne: (slot: TrimmedUserContextSlot) => boolean,
  ): number => {
    let dropped = 0;
    let progressed = true;
    while (progressed && over()) {
      progressed = false;
      for (const label of USER_CONTEXT_SLOTS) {
        const slot = work[label];
        if (!slot || !dropOne(slot)) continue;
        dropped += 1;
        progressed = true;
        if (!over()) return dropped;
      }
    }
    return dropped;
  };
  const droppedEpisodes = roundRobin((slot) => {
    if (!slot.episodes?.length) return false;
    slot.episodes.pop();
    if (slot.episodes.length === 0) delete slot.episodes;
    return true;
  });
  const droppedSummaries = roundRobin((slot) => {
    const entities = slot.entities ?? [];
    for (let i = entities.length - 1; i >= 0; i -= 1) {
      const entity = entities[i];
      if (entity?.summary === undefined) continue;
      const { summary: _dropped, ...rest } = entity;
      entities[i] = rest;
      return true;
    }
    return false;
  });
  const out: TrimmedUserContext = {};
  for (const label of USER_CONTEXT_SLOTS) {
    const slot = work[label];
    if (slot && hasContent(slot)) out[label] = slot;
  }
  return { context: out, droppedEpisodes, droppedSummaries };
}

function asResponseLike(
  value: Record<string, unknown>,
): SearchEnhancedResponseLike {
  const arrayOrUndefined = (v: unknown): readonly unknown[] | undefined =>
    Array.isArray(v) ? v : undefined;
  const totals = readTotals(value.total_results);
  return {
    ...(totals ? { total_results: totals } : {}),
    facts: arrayOrUndefined(value.facts),
    entities: arrayOrUndefined(value.entities),
    episodes: arrayOrUndefined(value.episodes),
    communities: arrayOrUndefined(value.communities),
  };
}

/** Evaluate `fn` for each slot, in query order. */
function perSlot<T>(
  fn: (label: UserContextSlot, index: number) => T,
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

// ─── Fetcher ──────────────────────────────────────────────────────────────────

export interface UserContextFetcherDeps {
  /** `MEMORY_ENGINE_URL`; undefined → every call is `skipped`, no request. */
  memoryEngineUrl: string | undefined;
  /**
   * The configured `ORACLE_ENTITY_DID` (a well-formed domain entity DID) —
   * sent as `x-oracle-entity-did` and as the queries' `oracle_dids`. Never
   * the `ORACLE_DID` fallback: undefined → every call is `skipped`
   * (`no-entity`), no request, one warning per fetcher.
   */
  entityDid: string | undefined;
  /** The user's UCAN surface, bound to the user's DID by the caller. */
  ucan: {
    hasSigningKey(): boolean;
    resolveServiceDid(serviceUrl: string): Promise<string | null>;
    mintInvocation(
      target: { did: string; capability: string },
      opts?: { can?: string },
    ): Promise<string>;
  };
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
  | 'no-entity'
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

  /** The missing-entity warning has been logged (it is logged once). */
  private warnedNoEntity = false;

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

    const cached = this.readCache(roomId);
    if (cached) {
      logger.log(
        `[user-context] cache hit room=${roomId} age=${cached.ageMs}ms keys=${Object.keys(cached.context).length}`,
      );
      return this.record(roomId, cached);
    }

    let gather: Promise<GatherResult>;
    try {
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
    const entityDid = this.deps.entityDid;
    if (!entityDid) {
      if (!this.warnedNoEntity) {
        this.warnedNoEntity = true;
        logger.warn(
          `[user-context] skipped: ORACLE_ENTITY_DID is not a domain entity DID (did:ixo:entity:<32 hex>); the memory engine keys every space by it, so no first-turn context is gathered`,
        );
      }
      return { kind: 'skipped', reason: 'no-entity' };
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
      promise: this.gather(engineUrl, entityDid, roomId).then(
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
    if (this.inFlight.get(roomId) !== entry) return result;
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

  /** Mint the invocation, run the batch, map the slots. Never rejects. */
  private async gather(
    engineUrl: string,
    entityDid: string,
    roomId: string,
  ): Promise<GatherResult> {
    const { logger, ucan } = this.deps;
    const start = this.now();

    let invocation: string | null = null;
    try {
      const memoryDid = await ucan.resolveServiceDid(engineUrl);
      if (memoryDid) {
        invocation = await ucan.mintInvocation(
          { did: memoryDid, capability: 'ixo:memory' },
          // Claim the ability the user's delegation actually grants. A `'*'`
          // claim is satisfiable only by a `'*'` grant.
          { can: 'memory/*' },
        );
      }
    } catch (err) {
      logger.warn(
        `[user-context] could not mint a memory engine invocation: ${describe(err)}`,
      );
    }
    if (!invocation) {
      logger.warn(
        `[user-context] skipped: no memory engine invocation for room=${roomId}`,
      );
      return { kind: 'skipped', reason: 'no-invocation' };
    }

    let body: unknown;
    try {
      const res = await this.fetchImpl(`${engineUrl}/search-enhanced-batch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${invocation}`,
          'X-Auth-Type': 'ucan',
          [MEMORY_ENTITY_HEADER]: entityDid,
          'x-room-id': roomId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          queries: buildUserContextQueries(entityDid, new Date(this.now())),
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!res.ok) {
        // The body is never read: an engine error page can echo the user's
        // queries, and the reason reaches logs and `/debug/context`.
        await res.body?.cancel().catch(() => undefined);
        return this.failed(roomId, `memory engine answered ${res.status}`);
      }
      try {
        body = await res.json();
      } catch {
        // A JSON parser's message quotes the body; keep it out of the reason.
        return this.failed(roomId, 'malformed response (invalid JSON)');
      }
    } catch (err) {
      return this.failed(roomId, describe(err));
    }

    const results = isRecord(body) ? body.results : undefined;
    if (!Array.isArray(results)) {
      return this.failed(roomId, 'malformed response (no results array)');
    }
    if (results.length !== USER_CONTEXT_SLOTS.length) {
      logger.warn(
        `[user-context] batch length mismatch for room=${roomId}: expected ${USER_CONTEXT_SLOTS.length}, got ${results.length}`,
      );
    }

    const trimmed: TrimmedUserContext = {};
    const answered = perSlot((label, index): boolean => {
      const raw: unknown = results[index];
      if (!isRecord(raw)) return false;
      if (isRecord(raw.error)) {
        logger.warn(
          `[user-context] slot ${label} failed (${String(raw.error.status_code)})`,
        );
        // The detail can echo the query; only a debug logger sees it.
        const detail = optionalText(raw.error.detail);
        if (detail) {
          logger.debug?.(
            `[user-context] slot ${label} failure detail: ${detail.slice(0, 200)}`,
          );
        }
        return false;
      }
      const slot = trimUserContextSlot(asResponseLike(raw));
      if (hasContent(slot)) trimmed[label] = slot;
      return true;
    });
    if (USER_CONTEXT_SLOTS.every((label) => !answered[label])) {
      return this.failed(roomId, 'every slot failed');
    }

    const fitted = fitUserContextBudget(trimmed);
    if (fitted.droppedEpisodes > 0 || fitted.droppedSummaries > 0) {
      logger.log(
        `[user-context] context over ${USER_CONTEXT_MAX_JSON_CHARS} chars for room=${roomId}; dropped ${fitted.droppedEpisodes} episodes and ${fitted.droppedSummaries} entity summaries`,
      );
    }
    const context: UserContextData = fitted.context;
    const slots = perSlot((label): string => {
      if (!answered[label]) return 'missing';
      const slot = fitted.context[label];
      return slot ? slotSummary(slot) : 'f0/e0/p0/c0';
    });

    const ms = this.now() - start;
    logger.log(
      `[user-context] fetched in ${ms} ms for room=${roomId} (${USER_CONTEXT_SLOTS.map((l) => `${l}=${slots[l]}`).join(', ')})`,
    );
    return { kind: 'fresh', context, ms, slots };
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
