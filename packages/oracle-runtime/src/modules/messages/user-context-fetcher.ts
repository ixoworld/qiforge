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

const CACHE_TTL_MS = minutes(1);

function cacheKey(sessionId: string): string {
  return `user-context:${sessionId}`;
}

/**
 * Per-room fetcher for Memory Engine `userContext`, cached for 3 minutes.
 *
 * Used by `AgentBuilder` to populate `state.userContext` BEFORE the agent is
 * compiled so the system prompt sees the value on turn 1. The previous
 * middleware-based approach wrote the value mid-run, by which point the
 * prompt was already a frozen string — so turn-1 prompts were always empty.
 *
 * Returns `undefined` when:
 *  - `MEMORY_ENGINE_URL` is not configured (`MemoryEngineService` is null)
 *  - UCAN signing key is missing (Matrix listener path, no per-user UCAN)
 *  - the Memory Engine call throws — userContext is best-effort, missing
 *    enrichment must never break a chat.
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
    sessionId:string
  }): Promise<UserContextRecord | undefined> {
    const { roomId, userDid,sessionId } = params;
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

    const cached = await this.cache.get<UserContextRecord>(cacheKey(sessionId));
    if (cached) {
      this.logger.log(
        `[UserContextFetcher] cache hit — room=${roomId}, keys=${Object.keys(cached).length}`,
      );
      return cached;
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
      );
    } catch (err) {
      this.logger.warn(
        `[UserContextFetcher] UCAN invocation threw for room ${roomId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
    if (!invocation) {
      this.logger.warn(
        `[UserContextFetcher] UCAN invocation returned null for room ${roomId} (did:web resolution failed?)`,
      );
      return undefined;
    }

    const oracleDid = this.configService.get<string>('ORACLE_DID') ?? '';
    this.logger.log(
      `[UserContextFetcher] calling gatherUserContext — engine=${engineUrl}, room=${roomId}, oracle=${oracleDid}`,
    );

    try {
      const context = await this.memoryEngine.gatherUserContext({
        oracleDid,
        roomId,
        oracleToken: '',
        userToken: '',
        oracleHomeServer: '',
        userHomeServer: '',
        ucanInvocation: invocation,
      });
      const widened: UserContextRecord = { ...context };
      const keyCount = Object.keys(widened).length;
      this.logger.log(
        `[UserContextFetcher] gather returned ${keyCount} key(s) for room ${roomId}: ${keyCount > 0 ? Object.keys(widened).join(', ') : '(empty)'}`,
      );
      await this.cache.set(cacheKey(sessionId), widened, CACHE_TTL_MS);
      return widened;
    } catch (err) {
      this.logger.warn(
        `[UserContextFetcher] gatherUserContext threw for room ${roomId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }
}
