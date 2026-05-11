import { type AgentMiddleware, createMiddleware } from 'langchain';
import { z } from 'zod';
import type { Logger } from '../../plugin-api/types.js';
import type {
  UserPreferences,
  UserPreferencesReader,
} from './service/user-preferences.service.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface UserPreferencesMiddlewareOptions {
  /** Service the middleware delegates to (typically the singleton). */
  service: UserPreferencesReader;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Read `session.roomId` off the LangGraph runtime context without trusting its
 * shape. The runtime channel is typed `unknown` in plain middlewares, so a
 * narrowing walk is the only honest way to surface the room id.
 */
function extractRoomId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || !('session' in context)) {
    return undefined;
  }
  const { session } = context;
  if (!session || typeof session !== 'object' || !('roomId' in session)) {
    return undefined;
  }
  const { roomId } = session;
  return typeof roomId === 'string' && roomId.length > 0 ? roomId : undefined;
}

/**
 * Loads user preferences for the active user↔oracle room and writes them to
 * `state.userPreferences` before the first model call. Subsequent calls in
 * the same run reuse the already-populated state — the prompt-composer reads
 * the field when building the system prompt.
 *
 * Skips silently when no `roomId` is present on the runtime context (e.g.
 * non-Matrix clients) or when the service throws — missing prefs must never
 * break a chat session.
 */
export const createUserPreferencesMiddleware = (
  options: UserPreferencesMiddlewareOptions,
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const { service } = options;

  return createMiddleware({
    name: 'UserPreferencesMiddleware',
    stateSchema: z.object({
      userPreferences: z.unknown().optional(),
    }),
    beforeModel: async (state, runtime) => {
      if (state.userPreferences !== undefined) return;

      const roomId = extractRoomId(runtime.context);
      if (!roomId) return;

      try {
        const prefs: UserPreferences | undefined = await service.get(roomId);
        if (!prefs) return;
        return { userPreferences: prefs };
      } catch (err) {
        logger.warn(
          `[UserPreferencesMiddleware] Failed to load prefs for room ${roomId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  });
};
