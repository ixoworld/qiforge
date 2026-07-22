import { MemoryEngineService } from '@ixo/common';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { minutes } from '@nestjs/throttler';
import { UcanService } from '../ucan/ucan.service.js';

/**
 * Local widening: the graph state's `userContext` field is typed as
 * `Record<string, unknown>`. `@ixo/common`'s `UserContextData` is a
 * structural subtype (typed slots like `identity`, `work`, etc.) but
 * TypeScript treats them as distinct types. We carry the looser shape
 * through this module so the value flows cleanly into `buildTimeState`.
 */
type UserContextRecord = Record<string, unknown>;

const CACHE_TTL_MS = minutes(5);

/**
 * Negative-cache TTL. A failed fetch (mint error, engine down, timeout) is
 * remembered briefly so a degraded Memory Engine costs ONE slow attempt per
 * window instead of stalling every turn.
 */
const FAILURE_TTL_MS = 60 * 1000;

/**
 * How long the awaited path is willing to block the agent build. The
 * transport-level deadlines in `MemoryEngineService` (30s soft / 60s hard)
 * exist to protect sockets, not chat latency — a prompt enrichment that
 * hasn't answered in 3s isn't worth delaying the model call for. The
 * request keeps running past this cap and warms the cache for later turns.
 */
const BLOCKING_FETCH_CAP_MS = 3 * 1000;

/**
 * Cache key for the fetched context. The Memory-Engine result is a function of
 * the room (and oracle), not the session — so keying by `roomId` lets a new
 * session for the same room reuse the cached value instead of paying a fresh
 * fetch.
 */
function cacheKey(roomId: string): string {
  return `user-context:room:${roomId}`;
}

function failureCacheKey(roomId: string): string {
  return `user-context:room:${roomId}:unavailable`;
}

/**
 * Per-room fetcher for Memory Engine `userContext`, cached for 5 minutes.
 *
 * Used by `AgentBuilder` to populate `state.userContext` BEFORE the agent is
 * compiled so the system prompt sees the value on turn 1. The previous
 * middleware-based approach wrote the value mid-run, by which point the
 * prompt was already a frozen string — so turn-1 prompts were always empty.
 *
 * Returns `undefined` when:
 *  - `MEMORY_ENGINE_URL` is not configured (`MemoryEngineService` is null)
 *  - UCAN signing key is missing (Matrix listener path, no per-user UCAN)
 *  - the Memory Engine call throws or exceeds the blocking cap — userContext
 *    is best-effort, missing enrichment must never break (or stall) a chat.
 *
 * Failures are negative-cached for {@link FAILURE_TTL_MS} so a degraded
 * Memory Engine costs one attempt per window, not one per turn. A fetch that
 * outlives {@link BLOCKING_FETCH_CAP_MS} stops blocking the caller but keeps
 * running and still warms the cache for subsequent turns.
 */
@Injectable()
export class UserContextFetcher {
  private readonly logger = new Logger(UserContextFetcher.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Optional()
    @Inject(MemoryEngineService)
    private readonly memoryEngine: MemoryEngineService | null,
    private readonly ucanService: UcanService,
    private readonly configService: ConfigService,
  ) {
    this.logger.log(
      `[UserContextFetcher] constructed — memoryEngine=${this.memoryEngine ? 'available' : 'null'}, hasSigningKey=${this.ucanService.hasSigningKey()}`,
    );
  }

  async fetch(params: {
    roomId: string;
    userDid: string;
    sessionId: string;
  }): Promise<UserContextRecord | undefined> {
    const { roomId, userDid, sessionId } = params;
    this.logger.debug(
      `[UserContextFetcher] fetch begin — room=${roomId}, user=${userDid}, sessionid=${sessionId}`,
    );

    if (!this.memoryEngine) {
      this.logger.warn(
        `[UserContextFetcher] skip — MemoryEngineService not configured (MEMORY_ENGINE_URL unset)`,
      );
      return undefined;
    }
    if (!this.ucanService.hasSigningKey()) {
      this.logger.warn(
        `[UserContextFetcher] skip — UCAN signing key not loaded (no per-user invocation)`,
      );
      return undefined;
    }

    const key = cacheKey(roomId);

    const cached = await this.cache.get<UserContextRecord>(key);
    if (cached) {
      this.logger.log(
        `[UserContextFetcher] cache hit — room=${roomId}, keys=${Object.keys(cached).length}`,
      );
      return cached;
    }

    // Negative cache checked AFTER the positive one: a late-completing
    // background fetch warms the positive cache, which must win over an
    // earlier failure marker.
    const recentlyFailed = await this.cache.get<boolean>(
      failureCacheKey(roomId),
    );
    if (recentlyFailed) {
      this.logger.log(
        `[UserContextFetcher] skip — recent fetch failure for room=${roomId} (retry in <${FAILURE_TTL_MS / 1000}s)`,
      );
      return undefined;
    }
    this.logger.log(`[UserContextFetcher] cache miss — room=${roomId}`);

    const engineUrl = this.configService.get<string>('MEMORY_ENGINE_URL');
    if (!engineUrl) {
      this.logger.warn(
        `[UserContextFetcher] skip — MEMORY_ENGINE_URL not in ConfigService (but MemoryEngineService is set?)`,
      );
      return undefined;
    }

    let invocation: string | null;
    try {
      invocation = await this.ucanService.createServiceInvocation(
        engineUrl,
        userDid,
        'ixo:memory',
        // Claim the ability the user's delegation actually grants. A `'*'`
        // claim is satisfiable only by a `'*'` grant.
        { can: 'memory/*' },
      );
    } catch (err) {
      this.logger.warn(
        `[UserContextFetcher] UCAN invocation threw for room ${roomId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.rememberFailure(roomId);
      return undefined;
    }
    if (!invocation) {
      this.logger.warn(
        `[UserContextFetcher] UCAN invocation returned null for room ${roomId} (did:web resolution failed?)`,
      );
      await this.rememberFailure(roomId);
      return undefined;
    }

    const oracleDid = this.configService.get<string>('ORACLE_DID') ?? '';
    this.logger.log(
      `[UserContextFetcher] calling gatherUserContext — engine=${engineUrl}, room=${roomId}, oracle=${oracleDid}`,
    );

    // The gather itself caches its own result (or a failure marker) whenever
    // it settles — even after the blocking cap below has given up — so a slow
    // engine still warms the cache for the NEXT turn.
    const gatherPromise: Promise<UserContextRecord | undefined> =
      this.memoryEngine
        .gatherUserContext({
          oracleDid,
          roomId,
          oracleToken: '',
          userToken: '',
          oracleHomeServer: '',
          userHomeServer: '',
          ucanInvocation: invocation,
        })
        .then(async (context) => {
          const widened: UserContextRecord = { ...context };
          const keyCount = Object.keys(widened).length;
          this.logger.log(
            `[UserContextFetcher] gather returned ${keyCount} key(s) for room ${roomId}: ${keyCount > 0 ? Object.keys(widened).join(', ') : '(empty)'}`,
          );
          await this.cache.set(key, widened, CACHE_TTL_MS);
          return widened;
        })
        .catch(async (err: unknown) => {
          this.logger.warn(
            `[UserContextFetcher] gatherUserContext threw for room ${roomId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await this.rememberFailure(roomId);
          return undefined;
        });

    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<'timeout'>((resolve) => {
      capTimer = setTimeout(() => resolve('timeout'), BLOCKING_FETCH_CAP_MS);
    });
    const outcome = await Promise.race([gatherPromise, cap]);
    if (capTimer) clearTimeout(capTimer);

    if (outcome === 'timeout') {
      this.logger.warn(
        `[UserContextFetcher] gather exceeded ${BLOCKING_FETCH_CAP_MS}ms for room ${roomId} — proceeding without fresh context; fetch continues in background`,
      );
      return undefined;
    }
    return outcome;
  }

  private async rememberFailure(roomId: string): Promise<void> {
    await this.cache.set(failureCacheKey(roomId), true, FAILURE_TTL_MS);
  }
}
