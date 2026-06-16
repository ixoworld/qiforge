import { SessionManagerService, type ChatSession } from '@ixo/common';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import * as crypto from 'node:crypto';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { type SendMessagePayload } from './dto/send-message.dto.js';
import { HomeServerCache } from './homeserver-cache.js';

export interface RuntimeRequestConfig {
  configurable: {
    thread_id: string;
    requestId: string;
    sessionId: string;
  };
}

export interface PreparedRequest {
  sessionId: string;
  langchainThreadId: string;
  roomId: string;
  homeServerName: string;
  requestId: string;
  runnableConfig: RuntimeRequestConfig;
  targetSession: ChatSession;
  timezone?: string;
  currentTime?: string;
}

export type PrepareInput = SendMessagePayload & {
  req?: Request;
  overrideLangchainThreadId?: string;
};

/**
 * Resolves everything the agent build needs from the incoming request:
 *
 *   - session lookup (parallel with the Matrix → SQLite sync triggered the
 *     first time we see this user this process)
 *   - room id resolution (uses the cached value when present, otherwise asks
 *     Matrix)
 *   - per-DID home-server cache
 *   - timezone / current-time extraction
 *   - the `runnableConfig` LangGraph needs for checkpointing
 *
 * Construction is hot-path code — every chat request runs this once.
 */
@Injectable()
export class RequestPreparer {
  constructor(
    private readonly sessions: SessionManagerService,
    private readonly checkpointSync: UserMatrixSqliteSyncService,
    private readonly homeServerCache: HomeServerCache,
    private readonly config: ConfigService,
  ) {}

  async prepare(payload: PrepareInput): Promise<PreparedRequest> {
    const did = payload.did;
    const sessionId = payload.sessionId;
    const requestId =
      payload.stream && 'requestId' in payload
        ? (payload.requestId as string)
        : crypto.randomUUID();

    // Home-server lookup, SQLite warm-up, and session read are mutually
    // independent, so run them concurrently — a cold home-server cache is a
    // 50-200ms chain lookup that should overlap the DB sync, not precede it.
    // Per-process sync-once is owned by `UserMatrixSqliteSyncService`: the
    // first request per user warms the SQLite, subsequent requests reuse it.
    // `payload.homeServer`, when supplied, short-circuits the cache call.
    const [homeServerName, , targetSession] = await Promise.all([
      payload.homeServer
        ? Promise.resolve(payload.homeServer)
        : this.homeServerCache.get(did),
      this.checkpointSync.getUserDatabase(did),
      this.sessions.getSession(sessionId, did, false),
    ]);

    if (!targetSession) {
      throw new NotFoundException('Session not found');
    }

    let roomId = targetSession.roomId;
    if (!roomId) {
      const oracleEntityDid =
        this.config.getOrThrow<string>('ORACLE_ENTITY_DID');
      const roomResult =
        await this.sessions.matrixManger.getOracleRoomIdWithHomeServer({
          userDid: did,
          oracleEntityDid,
          userHomeServer: homeServerName,
        });
      roomId = roomResult.roomId;
      if (!roomId) {
        throw new NotFoundException('Room not found or Invalid Session Id');
      }
    }

    const timezone = this.resolveTimezone(payload, payload.req);
    const currentTime = timezone
      ? this.formatTimeInTimezone(timezone)
      : undefined;

    const threadId = payload.overrideLangchainThreadId ?? sessionId;
    const runnableConfig: RuntimeRequestConfig = {
      configurable: {
        thread_id: threadId,
        requestId,
        sessionId: threadId,
      },
    };

    return {
      sessionId,
      langchainThreadId: threadId,
      roomId,
      homeServerName,
      requestId,
      runnableConfig,
      targetSession,
      timezone,
      currentTime,
    };
  }

  validateSessionId(sessionId: string | undefined, did: string | undefined) {
    if (!sessionId || !did) {
      throw new BadRequestException('Invalid parameters');
    }
  }

  private resolveTimezone(
    payload?: SendMessagePayload,
    req?: Request,
  ): string | undefined {
    if (payload?.timezone) {
      return payload.timezone.trim() || undefined;
    }
    const header = req?.headers['x-timezone'];
    if (!header) return undefined;
    const tz = typeof header === 'string' ? header : header[0];
    return tz?.trim() || undefined;
  }

  private formatTimeInTimezone(timezone: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(new Date());
    } catch {
      return new Date().toLocaleString('en-US', {
        timeZone: 'UTC',
        timeZoneName: 'short',
      });
    }
  }
}
