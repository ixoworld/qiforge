import {
  SessionManagerService,
  transformGraphStateMessageToListMessageResponse,
  type ChatSession,
} from '@ixo/common';
import { SqliteSaver } from '@ixo/sqlite-saver';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type BaseMessage } from 'langchain';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';

export interface PostSyncInput {
  did: string;
  sessionId: string;
  langchainThreadId: string;
  roomId: string;
  targetSession: ChatSession;
}

/**
 * Fire-and-forget session sync that runs after each chat turn. Reads the
 * just-written checkpoint via the cached SQLite connection (no Matrix
 * re-sync — the connection is already warm from `RequestPreparer`) and
 * mirrors the message list + lastProcessedCount into
 * `SessionManagerService`.
 *
 * Ref-counted DB activity is handled by the caller via
 * `markUserActive` / `markUserInactive` — this service just performs the
 * read + write without juggling the counter.
 */
@Injectable()
export class PostMessageSyncer {
  private readonly logger = new Logger(PostMessageSyncer.name);

  constructor(
    private readonly checkpointSync: UserMatrixSqliteSyncService,
    private readonly sessions: SessionManagerService,
    private readonly config: ConfigService,
  ) {}

  run(input: PostSyncInput): void {
    void Promise.resolve().then(async () => {
      try {
        const db = await this.checkpointSync.getUserDatabaseNoSync(input.did);
        const saver = SqliteSaver.fromDatabase(db);
        const tuple = await saver.getTuple({
          configurable: { thread_id: input.langchainThreadId },
        });
        const messages =
          (tuple?.checkpoint?.channel_values?.messages as
            | BaseMessage[]
            | undefined) ?? [];
        const transformed =
          transformGraphStateMessageToListMessageResponse(messages);

        await this.sessions.syncSessionSet({
          sessionId: input.sessionId,
          oracleName: this.config.getOrThrow('ORACLE_NAME'),
          did: input.did,
          // Roles are carried through: the session title is only meaningful
          // if the namer can tell the user's ask from the oracle's answer.
          messages: transformed.messages.map((m) => ({
            type: m.type,
            content: m.content.toString(),
          })),
          oracleDid: this.config.getOrThrow<string>('ORACLE_DID'),
          oracleEntityDid: this.config.getOrThrow('ORACLE_ENTITY_DID'),
          lastProcessedCount: input.targetSession?.lastProcessedCount ?? 0,
          roomId: input.roomId,
        });
      } catch (error) {
        this.logger.error('Failed to perform post-message sync', error);
      } finally {
        this.checkpointSync.markUserInactive(input.did);
      }
    });
  }
}
