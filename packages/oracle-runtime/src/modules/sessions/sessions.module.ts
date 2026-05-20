import { MemoryEngineService, SessionManagerService } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagesModule } from '../messages/messages.module.js';
import { UcanModule } from '../ucan/ucan.module.js';
import { CheckpointStorageSyncModule } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.module.js';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { SessionHistoryProcessor } from './session-history-processor.service.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [MessagesModule, CheckpointStorageSyncModule, UcanModule],
  controllers: [SessionsController],
  providers: [
    SessionsService,
    SessionHistoryProcessor,
    {
      // MEMORY_ENGINE_URL is optional — see comment in messages.module.ts.
      provide: MemoryEngineService,
      useFactory: (configService: ConfigService) => {
        const memoryEngineUrl =
          configService.get<string>('MEMORY_ENGINE_URL');
        return memoryEngineUrl
          ? new MemoryEngineService(memoryEngineUrl)
          : null;
      },
      inject: [ConfigService],
    },
    {
      provide: SessionManagerService,
      useFactory: (syncService: UserMatrixSqliteSyncService) => {
        return new SessionManagerService(
          syncService,
          MatrixManager.getInstance(),
        );
      },
      inject: [UserMatrixSqliteSyncService],
    },
  ],
  exports: [SessionsService, SessionHistoryProcessor],
})
export class SessionsModule {}
