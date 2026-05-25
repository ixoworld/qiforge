import { MemoryEngineService, SessionManagerService } from '@ixo/common';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MainAgentGraph } from 'src/graph';
import { type ENV } from 'src/types';
// SseService is provided globally by SseModule, no need to import or provide here.
import { MatrixManager } from '@ixo/matrix';
import { ChannelMemoryModule } from 'src/channel-memory/channel-memory.module';
import { isRedisEnabled } from 'src/config';
import { TasksModule } from 'src/tasks/tasks.module';
import { UcanModule } from 'src/ucan/ucan.module';
import { CheckpointStorageSyncModule } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.module';
import { UserMatrixSqliteSyncService } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import { FileProcessingService } from './file-processing.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [
    CheckpointStorageSyncModule,
    ChannelMemoryModule,
    // TasksModule requires Redis for BullMQ job queues
    ...(isRedisEnabled() ? [TasksModule] : []),
    UcanModule,
  ],
  controllers: [MessagesController],
  providers: [
    MessagesService,
    FileProcessingService,
    MainAgentGraph,
    {
      provide: MemoryEngineService,
      useFactory: (configService: ConfigService<ENV>) => {
        const memoryEngineUrl =
          configService.getOrThrow<string>('MEMORY_ENGINE_URL');
        return new MemoryEngineService(memoryEngineUrl);
      },
      inject: [ConfigService],
    },
    {
      provide: SessionManagerService,
      useFactory: (
        syncService: UserMatrixSqliteSyncService,
        memoryEngineService: MemoryEngineService,
      ) => {
        return new SessionManagerService(
          syncService,
          MatrixManager.getInstance(),
          memoryEngineService,
        );
      },
      inject: [UserMatrixSqliteSyncService, MemoryEngineService],
    },
  ],
  exports: [MessagesService, MemoryEngineService, SessionManagerService],
})
export class MessagesModule {}
