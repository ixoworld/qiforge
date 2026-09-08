/**
 * Per-room user preferences, persisted as the `ixo.room.state` /
 * `user_prefs` state event of the user↔oracle room — the SAME event, in the
 * SAME Node-compatible envelope, that the Node runtime's
 * `UserPreferencesService` reads and writes. A user migrated from Node keeps
 * their preferences; a user who sets them here keeps them if they ever move
 * back.
 *
 * The store is a host object (one per `UserOracleDO`): the turn preparer
 * reads through it to hydrate `state.userPreferences` before the agent is
 * built, and the `set_user_preferences` tool writes through it, so the
 * 5-minute read cache is invalidated by the very write that changes it —
 * the Node service's cache-manager semantics, without a shared singleton.
 */
import type { UserPreferences } from '../../core/state';
import {
  decodeRoomStateContent,
  encodeRoomStateContent,
  ROOM_STATE_EVENT_TYPE,
} from '../../matrix/room-state-codec';
import type { Logger, UserPreferencesSurface } from '../../plugin-api/types';
import {
  USER_PREFS_STATE_KEY,
  UserPreferencesSchema,
  type StoredUserPreferences,
} from './schema';

/**
 * The slice of the Matrix gateway the store needs. The gateway Durable
 * Object stub satisfies it structurally (`getRoomStateEvent` /
 * `sendStateEvent` are its RPC methods); tests pass an in-memory map.
 */
export interface RoomStateAccess {
  getRoomStateEvent(
    roomId: string,
    type: string,
    stateKey?: string,
  ): Promise<string | null>;
  sendStateEvent(
    roomId: string,
    type: string,
    content: string,
    stateKey?: string,
  ): Promise<string>;
}

export interface UserPreferencesStoreOptions {
  /** Read-cache TTL. Node caches for 5 minutes; same default here. */
  ttlMs?: number;
  logger?: Logger;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Bound the cache — one store serves one user, but rooms can accrue. */
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  value: StoredUserPreferences | undefined;
  expiresAt: number;
}

export class UserPreferencesStore implements UserPreferencesSurface {
  private readonly cache = new Map<string, CacheEntry>();

  private readonly ttlMs: number;

  private readonly logger: Logger | undefined;

  private readonly now: () => number;

  constructor(
    private readonly access: RoomStateAccess,
    options: UserPreferencesStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The room's preferences, or `undefined` when none are set, the payload
   * is unreadable, or the read failed (each logged, never thrown — a
   * preferences hiccup must not fail a turn). Misses are cached too, so a
   * user without preferences costs one state read per TTL, not per turn.
   */
  async get(roomId: string): Promise<UserPreferences | undefined> {
    const hit = this.cache.get(roomId);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    let decoded: unknown;
    try {
      const json = await this.access.getRoomStateEvent(
        roomId,
        ROOM_STATE_EVENT_TYPE,
        USER_PREFS_STATE_KEY,
      );
      decoded =
        json === null
          ? null
          : await decodeRoomStateContent(JSON.parse(json) as unknown);
    } catch (error) {
      this.logger?.warn(
        `[user-preferences] failed to load prefs for room ${roomId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }

    if (decoded === null) {
      this.remember(roomId, undefined);
      return undefined;
    }
    const parsed = UserPreferencesSchema.safeParse(decoded);
    if (!parsed.success) {
      this.logger?.warn(
        `[user-preferences] invalid prefs payload for room ${roomId}: ${parsed.error.message}`,
      );
      return undefined;
    }
    this.remember(roomId, parsed.data);
    return parsed.data;
  }

  /**
   * Merge `partial` into the stored preferences (only the provided fields
   * change; `undefined` values are ignored rather than clearing a field) and
   * persist the result with a fresh `updatedAt`. Returns the merged record.
   * An empty `partial` is a no-op that returns the current record.
   */
  async set(
    roomId: string,
    partial: Partial<UserPreferences>,
  ): Promise<UserPreferences> {
    const current = (await this.get(roomId)) ?? {};
    const provided = Object.fromEntries(
      Object.entries(partial).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(provided).length === 0) return current;

    const merged = UserPreferencesSchema.parse({
      ...current,
      ...provided,
      updatedAt: new Date(this.now()).toISOString(),
    });
    await this.access.sendStateEvent(
      roomId,
      ROOM_STATE_EVENT_TYPE,
      JSON.stringify(await encodeRoomStateContent(merged)),
      USER_PREFS_STATE_KEY,
    );
    this.invalidate(roomId);
    return merged;
  }

  invalidate(roomId: string): void {
    this.cache.delete(roomId);
  }

  private remember(
    roomId: string,
    value: StoredUserPreferences | undefined,
  ): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(roomId, { value, expiresAt: this.now() + this.ttlMs });
  }
}
