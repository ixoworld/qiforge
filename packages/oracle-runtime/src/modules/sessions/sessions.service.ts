import {
  type CreateChatSessionResponseDto,
  type ListChatSessionsResponseDto,
  SessionManagerService,
} from '@ixo/common';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UcanService } from '../ucan/ucan.service.js';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { type CreateSessionDto } from './dto/create-session.dto.js';
import { type DeleteSessionDto } from './dto/delete-session.dto.js';
import { type ListSessionsDto } from './dto/list-sessions.dto.js';
import { SessionHistoryProcessor } from './session-history-processor.service.js';

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessionManager: SessionManagerService,
    private readonly configService: ConfigService,
    private readonly sessionHistoryProcessor: SessionHistoryProcessor,
    private readonly syncService: UserMatrixSqliteSyncService,
    @Optional() private readonly ucanService?: UcanService,
  ) {}

  async processPreviousSessionHistory(data: CreateSessionDto): Promise<void> {
    const oracleEntityDid = this.configService.getOrThrow('ORACLE_ENTITY_DID');

    const { sessions } = await this.listSessions({
      did: data.did,
    });

    const previousSession = sessions[0]; // most recent
    if (previousSession) {
      // Guard the inner fire-and-forget separately — the outer guard on
      // processPreviousSessionHistory drops when this method resolves,
      // but processSessionHistory continues running in the background.
      this.syncService.markUserActive(data.did);
      this.sessionHistoryProcessor
        .processSessionHistory({
          sessionId: previousSession.sessionId,
          did: data.did,
          oracleEntityDid,
          homeServer: data.homeServer,
        })
        .catch((err) =>
          Logger.error(
            `Failed to process previous session ${previousSession.sessionId}:`,
            err,
          ),
        )
        .finally(() => {
          this.syncService.markUserInactive(data.did);
        });
    }
  }

  async createSession(
    data: CreateSessionDto,
  ): Promise<CreateChatSessionResponseDto> {
    this.syncService.markUserActive(data.did);
    try {
      const oracleEntityDid =
        this.configService.getOrThrow('ORACLE_ENTITY_DID');

      // Increment ref count BEFORE firing the background task so the outer
      // finally's markUserInactive doesn't drop to 0 while the task runs.
      this.syncService.markUserActive(data.did);
      this.processPreviousSessionHistory(data)
        .catch((err) =>
          Logger.error(
            `Failed to process previous session history for DID ${data.did}:`,
            err,
          ),
        )
        .finally(() => {
          this.syncService.markUserInactive(data.did);
        });

      // Memory engine auth — UCAN-only. The session is created without
      // a memory invocation if no signing key is available; downstream
      // memory writes will simply skip until UCAN is configured.
      const oracleMatrixBaseUrl = this.configService
        .getOrThrow<string>('MATRIX_BASE_URL')
        .replace(/\/$/, '');

      let memoryUcanInvocation: string | undefined;

      if (this.ucanService?.hasSigningKey() && data.did) {
        try {
          const engineUrl = this.configService.getOrThrow('MEMORY_ENGINE_URL');
          const invocation = await this.ucanService.createServiceInvocation(
            engineUrl,
            data.did,
            'ixo:memory',
          );
          if (invocation) {
            memoryUcanInvocation = invocation;
          }
        } catch (err) {
          Logger.warn(
            `[Session UCAN] Failed to create invocation: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const oracleHomeServer = oracleMatrixBaseUrl.replace(/^https?:\/\//, '');

      const session = await this.sessionManager.createSession({
        did: data.did,
        homeServer: data.homeServer,
        oracleName: this.configService.getOrThrow('ORACLE_NAME'),
        oracleEntityDid,
        oracleDid: this.configService.getOrThrow('ORACLE_DID'),
        slackThreadTs: data.slackThreadTs,
        oracleHomeServer,
        userHomeServer: data.homeServer,
        ucanInvocation: memoryUcanInvocation,
      });
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      Logger.error(
        `Failed to create session for DID ${data.did}: ${message}`,
        stack,
      );
      throw new BadRequestException(`Session creation failed: ${message}`);
    } finally {
      this.syncService.markUserInactive(data.did);
    }
  }

  async listSessions(
    data: ListSessionsDto,
  ): Promise<ListChatSessionsResponseDto> {
    this.syncService.markUserActive(data.did);
    try {
      // Resolve the user's main room so we only return main-room sessions.
      // Task-room sessions (created via Matrix in dedicated task channels)
      // are filtered out — the portal only shows main conversations.
      const userHomeServer =
        data.homeServer || (await getMatrixHomeServerCroppedForDid(data.did));
      const { roomId: mainRoomId } =
        await this.sessionManager.matrixManger.getOracleRoomIdWithHomeServer({
          userDid: data.did,
          oracleEntityDid: this.configService.getOrThrow('ORACLE_ENTITY_DID'),
          userHomeServer,
        });

      const sessionsResult = await this.sessionManager.listSessions({
        did: data.did,
        oracleEntityDid: this.configService.getOrThrow('ORACLE_ENTITY_DID'),
        limit: data.limit ?? 20,
        offset: data.offset ?? 0,
        roomId: mainRoomId ?? undefined,
      });

      return {
        sessions: sessionsResult.sessions,
        total: sessionsResult.total,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      Logger.error(
        `Failed to list sessions for DID ${data.did}: ${message}`,
        stack,
      );
      throw new BadRequestException(`Failed to list sessions: ${message}`);
    } finally {
      this.syncService.markUserInactive(data.did);
    }
  }

  async deleteSession(data: DeleteSessionDto): Promise<{ message: string }> {
    this.syncService.markUserActive(data.did);
    try {
      const oracleEntityDid =
        this.configService.getOrThrow('ORACLE_ENTITY_DID');

      // Increment ref count BEFORE firing the background task so the outer
      // finally's markUserInactive doesn't drop to 0 while the task runs.
      this.syncService.markUserActive(data.did);
      this.sessionHistoryProcessor
        .processSessionHistory({
          sessionId: data.sessionId,
          did: data.did,
          oracleEntityDid,
          homeServer: data.homeServer,
        })
        .catch((err) =>
          Logger.error(
            `Failed to process deleted session ${data.sessionId}:`,
            err,
          ),
        )
        .finally(() => {
          this.syncService.markUserInactive(data.did);
        });

      await this.sessionManager.deleteSession({
        did: data.did,
        sessionId: data.sessionId,
        oracleEntityDid,
      });
      return { message: 'Session deleted successfully' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      Logger.error(
        `Failed to delete session ${data.sessionId} for DID ${data.did}: ${message}`,
        stack,
      );
      throw new BadRequestException(`Failed to delete session: ${message}`);
    } finally {
      this.syncService.markUserInactive(data.did);
    }
  }
}
