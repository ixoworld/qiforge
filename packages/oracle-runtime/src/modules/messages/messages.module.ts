import { MemoryEngineService, SessionManagerService } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CheckpointStorageSyncModule } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.module.js';
import { UserMatrixSqliteSyncService } from '../../matrix/checkpointer/user-matrix-sqlite-sync-service.service.js';
import { UcanModule } from '../ucan/ucan.module.js';
import { AgentBuilder } from './agent-builder.js';
import { BatchInvoker } from './batch-invoker.js';
import { CapabilityRouter } from './capability-router.js';
import { DelegationController } from './delegation.controller.js';
import { FileProcessingService } from './file-processing.service.js';
import { HomeServerCache } from './homeserver-cache.js';
import { MatrixListenerBridge } from './matrix-listener-bridge.js';
import { MessageRouterService } from './message-router.service.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { OracleRuntimeBundleHolder } from './oracle-runtime-bundle.js';
import { PostMessageSyncer } from './post-message-syncer.js';
import { RequestPreparer } from './request-preparer.js';
import { SseStreamRunner } from './sse-stream-runner.js';
import { UserContextFetcher } from './user-context-fetcher.js';

@Module({
  imports: [CheckpointStorageSyncModule, UcanModule],
  controllers: [MessagesController, DelegationController],
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
      // The router runs before RuntimeContext exists, but bounded Decisions
      // live on the boot-populated ambient runtime. Resolve them lazily through
      // the holder so module construction still works before createOracleApp
      // has populated the bundle.
      provide: MessageRouterService,
      useFactory: (holder: OracleRuntimeBundleHolder) =>
        new MessageRouterService({
          getDecisionEvaluator: () =>
            holder.isReady() ? holder.get().ambient.decisions : undefined,
        }),
      inject: [OracleRuntimeBundleHolder],
    },
    {
      // Same lazy resolution as the commerce router: the capability router
      // runs inside the agent build, before RuntimeContext exists, and its
      // Decision evaluator lives on the boot-populated bundle.
      provide: CapabilityRouter,
      useFactory: (holder: OracleRuntimeBundleHolder) =>
        new CapabilityRouter({
          getDecisionEvaluator: () =>
            holder.isReady() ? holder.get().ambient.decisions : undefined,
        }),
      inject: [OracleRuntimeBundleHolder],
    },
    {
      // `MemoryEngineService` is OPTIONAL. `UserContextFetcher` reads it
      // each turn (cached for 3 min) to populate `state.userContext`
      // before the agent is built. When `MEMORY_ENGINE_URL` isn't set,
      // we provide `null` and the fetcher returns `undefined`. The memory
      // plugin still gates its OWN tool surface via `autoDetect`/`configSchema`.
      provide: MemoryEngineService,
      useFactory: (configService: ConfigService) => {
        const memoryEngineUrl = configService.get<string>('MEMORY_ENGINE_URL');
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
    MatrixListenerBridge,
  ],
})
export class MessagesModule {}
