import {
  type CreateChatSessionResponseDto,
  type ListChatSessionsResponseDto,
  SessionManagerService,
} from '@ixo/common';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { OpenIdTokenProvider } from '@ixo/oracles-chain-client';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ENV } from 'src/types';
import { UcanService } from '../ucan/ucan.service';
import { UserMatrixSqliteSyncService } from '../user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { type CreateSessionDto } from './dto/create-session.dto'; // Import DTO
import { type DeleteSessionDto } from './dto/delete-session.dto'; // Import DTO
import { type ListSessionsDto } from './dto/list-sessions.dto'; // Import DTO
import { SessionHistoryProcessor } from './session-history-processor.service';

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessionManager: SessionManagerService,
    private readonly configService: ConfigService<ENV>,
    private readonly sessionHistoryProcessor: SessionHistoryProcessor,
    private readonly syncService: UserMatrixSqliteSyncService,
    @Optional() private readonly ucanService?: UcanService,
  ) {}

  async processPreviousSessionHistory(data: CreateSessionDto): Promise<void> {
    const oracleEntityDid = this.configService.getOrThrow('ORACLE_ENTITY_DID');

    // Process previous session history before creating new session
    const { sessions } = await this.listSessions({
      did: data.did,
    });

    if (sessions.length > 0) {
      const previousSession = sessions[0]; // Most recent session
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
          userToken: data.userToken,
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

      // Increment ref count BEFORE firing background task so the outer
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

      // Generate auth for memory engine — try UCAN first, fall back to Matrix OpenID
      const oracleMatrixBaseUrl = this.configService
        .getOrThrow<string>('MATRIX_BASE_URL')
        .replace(/\/$/, '');

      let oracleToken: string | undefined;
      let memoryUcanInvocation: string | undefined;

      if (this.ucanService?.hasSigningKey() && data.did) {
        // Create UCAN invocation for memory engine
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

      // Fall back to Matrix OpenID if no UCAN invocation
      if (!memoryUcanInvocation && data.userToken) {
        const oracleOpenIdTokenProvider = new OpenIdTokenProvider({
          matrixAccessToken: this.configService.getOrThrow(
            'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
          ),
          homeServerUrl: oracleMatrixBaseUrl,
          matrixUserId: this.configService.getOrThrow(
            'MATRIX_ORACLE_ADMIN_USER_ID',
          ),
        });
        oracleToken = await oracleOpenIdTokenProvider.getToken();
      }

      const oracleHomeServer = oracleMatrixBaseUrl.replace(/^https?:\/\//, '');

      const session = await this.sessionManager.createSession({
        did: data.did,
        homeServer: data.homeServer,
        oracleName: this.configService.getOrThrow('ORACLE_NAME'),
        oracleEntityDid,
        oracleDid: this.configService.getOrThrow('ORACLE_DID'),
        slackThreadTs: data.slackThreadTs,
        oracleToken,
        userToken: data.userToken,
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

      // Increment ref count BEFORE firing background task so the outer
      // finally's markUserInactive doesn't drop to 0 while the task runs.
      this.syncService.markUserActive(data.did);
      this.sessionHistoryProcessor
        .processSessionHistory({
          sessionId: data.sessionId,
          did: data.did,
          oracleEntityDid,
          homeServer: data.homeServer,
          userToken: data.userToken,
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

      const db = await this.syncService.getUserDatabase(data.did);
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(
        data.sessionId,
      );
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
