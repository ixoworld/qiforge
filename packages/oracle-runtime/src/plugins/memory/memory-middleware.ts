import { type AgentMiddleware, createMiddleware } from 'langchain';
import { z } from 'zod';
import type { Logger, UserContextData } from '../../plugin-api/types.js';

const NOOP_LOGGER: Logger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Contract the middleware delegates to when it needs to fetch a user's
 * enriched memory context for the active room. Implementations typically
 * call the Memory Engine HTTP API or read from a session cache.
 */
export interface UserContextReader {
  get(roomId: string): Promise<UserContextData | undefined>;
}

export interface MemoryMiddlewareOptions {
  /** Reader the middleware delegates to. */
  reader: UserContextReader;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Read `session.roomId` off the LangGraph runtime context without trusting
 * its shape. The runtime channel is typed `unknown` in plain middlewares, so
 * a narrowing walk is the only honest way to surface the room id.
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
 * Loads memory-enriched user context for the active user↔oracle room and
 * writes it to `state.userContext` before the first model call. Subsequent
 * calls in the same run reuse the already-populated state — the prompt
 * composer reads `userContext` when building the system prompt.
 *
 * Skips silently when no `roomId` is present on the runtime context (e.g.
 * non-Matrix clients), when `state.userContext` already has content (the
 * caller may have hydrated it from the session), or when the reader throws
 * — missing context must never break a chat session.
 */
export const createMemoryMiddleware = (
  options: MemoryMiddlewareOptions,
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const { reader } = options;

  return createMiddleware({
    name: 'MemoryMiddleware',
    stateSchema: z.object({
      userContext: z.unknown().optional(),
    }),
    beforeModel: async (state, runtime) => {
      const existing = state.userContext;
      const hasContent =
        existing !== undefined &&
        existing !== null &&
        typeof existing === 'object' &&
        Object.keys(existing as Record<string, unknown>).length > 0;
      if (hasContent) return;

      const roomId = extractRoomId(runtime.context);
      if (!roomId) return;

      try {
        const userContext = await reader.get(roomId);
        if (!userContext) return;
        return { userContext };
      } catch (err) {
        logger.warn(
          `[MemoryMiddleware] Failed to load userContext for room ${roomId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  });
};
