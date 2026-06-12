import { MatrixError, MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { z } from 'zod';

export const USER_PREFS_STATE_KEY = 'user_prefs';

export const UserPreferencesSchema = z.object({
  agentName: z.string().max(80).optional(),
  userName: z.string().max(80).optional(),
  language: z.string().max(20).optional(), // BCP-47-ish, free-form
  tone: z.string().optional(), // e.g. "casual", "playful"
  formality: z
    .enum([
      'casual',
      'friendly',
      'neutral',
      'semi-formal',
      'professional',
      'formal',
      'technical',
      'academic',
    ])
    .optional(),
  customInstructions: z.string().max(2000).optional(),
  updatedAt: z.iso.datetime().optional(), // service sets on every write
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

// Room-state prefs change rarely and every write through this service
// invalidates the cache (`set` → `invalidate`), so a 5-minute TTL trims the
// recurring ~50-100ms Matrix state read off the hot path without serving
// stale prefs for edits that go through the normal path.
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Stores per-room user preferences in Matrix room state, with an optional
 * in-memory cache. The singleton is consumed by the user-preferences
 * middleware which loads prefs into `state.userPreferences` on every request.
 */
export class UserPreferencesService {
  private static instance: UserPreferencesService;

  private cacheManager: Cache | null = null;

  private constructor() {}

  static getInstance(): UserPreferencesService {
    if (!UserPreferencesService.instance) {
      UserPreferencesService.instance = new UserPreferencesService();
    }
    return UserPreferencesService.instance;
  }

  setCacheManager(cache: Cache): void {
    this.cacheManager = cache;
  }

  private cacheKey(roomId: string): string {
    return `user-prefs:${roomId}`;
  }

  /**
   * Read user preferences for a given room.
   * Returns undefined if no preferences have been set, or if anything goes wrong
   * (we never want missing prefs to break a chat session).
   */
  async get(roomId: string): Promise<UserPreferences | undefined> {
    const key = this.cacheKey(roomId);

    const cached = await this.cacheManager?.get<UserPreferences>(key);
    if (cached) {
      return cached;
    }

    let raw: unknown;
    try {
      const stateManager = MatrixManager.getInstance().stateManager;
      raw = await stateManager.getState<unknown>(roomId, USER_PREFS_STATE_KEY);
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
        return undefined;
      }
      Logger.warn(
        `[UserPreferencesService] Failed to load prefs for room ${roomId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }

    const parsed = UserPreferencesSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(
        `[UserPreferencesService] Invalid prefs payload for room ${roomId}: ${parsed.error.message}`,
      );
      return undefined;
    }

    await this.cacheManager?.set(key, parsed.data, CACHE_TTL_MS);
    return parsed.data;
  }

  /**
   * Merge `partial` into the existing preferences, write to Matrix room state,
   * invalidate the cache, and return the merged result.
   * `updatedAt` is always set by this service.
   */
  async set(
    roomId: string,
    partial: Partial<UserPreferences>,
  ): Promise<UserPreferences> {
    const current = (await this.get(roomId)) ?? {};

    if (Object.keys(partial).length === 0 && !partial.updatedAt) {
      return current;
    }

    const merged = UserPreferencesSchema.parse({
      ...current,
      ...partial,
      updatedAt: new Date().toISOString(),
    });

    const stateManager = MatrixManager.getInstance().stateManager;
    await stateManager.setState<UserPreferences>({
      roomId,
      stateKey: USER_PREFS_STATE_KEY,
      data: merged,
    });

    await this.invalidate(roomId);
    return merged;
  }

  async invalidate(roomId: string): Promise<void> {
    await this.cacheManager?.del(this.cacheKey(roomId));
  }
}

/**
 * Narrow contract over `UserPreferencesService` exposing only the read path.
 * The middleware depends on this so tests can swap in a stub without
 * instantiating the full Matrix-backed singleton.
 */
export type UserPreferencesReader = Pick<UserPreferencesService, 'get'>;

/**
 * Narrow contract over `UserPreferencesService` exposing only the write path.
 * The `set_user_preferences` tool depends on this so tests can swap in a
 * stub without instantiating the full Matrix-backed singleton.
 */
export type UserPreferencesWriter = Pick<UserPreferencesService, 'set'>;
