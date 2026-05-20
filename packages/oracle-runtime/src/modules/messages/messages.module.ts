import { MemoryEngineService, SessionManagerService } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CheckpointStorageSyncModule } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.module.js';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { UcanModule } from '../ucan/ucan.module.js';
import { AgentBuilder } from './agent-builder.js';
import { BatchInvoker } from './batch-invoker.js';
import { FileProcessingService } from './file-processing.service.js';
import { HomeServerCache } from './homeserver-cache.js';
import { MatrixListenerBridge } from './matrix-listener-bridge.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { OracleRuntimeBundleHolder } from './oracle-runtime-bundle.js';
import { PostMessageSyncer } from './post-message-syncer.js';
import { RequestPreparer } from './request-preparer.js';
import { SseStreamRunner } from './sse-stream-runner.js';
import { UserContextFetcher } from './user-context-fetcher.js';

@Module({
  imports: [CheckpointStorageSyncModule, UcanModule],
  controllers: [MessagesController],
  providers: [
    MessagesService,
    FileProcessingService,
    OracleRuntimeBundleHolder,
    HomeServerCache,
    RequestPreparer,
    AgentBuilder,
    SseStreamRunner,
    UserContextFetcher,
    BatchInvoker,
    PostMessageSyncer,
    MatrixListenerBridge,
    {
      // `MemoryEngineService` is OPTIONAL. `UserContextFetcher` reads it
      // each turn (cached for 3 min) to populate `state.userContext`
      // before the agent is built. When `MEMORY_ENGINE_URL` isn't set,
      // we provide `null` and the fetcher returns `undefined`. The memory
      // plugin still gates its OWN tool surface via `autoDetect`/`configSchema`.
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
  exports: [
    MessagesService,
    MemoryEngineService,
    SessionManagerService,
    OracleRuntimeBundleHolder,
  ],
})
export class MessagesModule {}
