import { BullModule } from '@nestjs/bullmq';
import { Inject, Module, type DynamicModule } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { MatrixListenerBridge } from '../../../modules/messages/matrix-listener-bridge.js';
import { MessagesModule } from '../../../modules/messages/messages.module.js';
import { SessionsModule } from '../../../modules/sessions/sessions.module.js';
import { DeliveryService } from './delivery.js';
import { AgentInvoker } from './invoker.js';
import { RedisState, TASKS_REDIS } from './redis-state.js';
import { TaskRunWorker } from './run.worker.js';
import {
  TASKS_RUNTIME_CONFIG,
  type TasksRuntime,
  type TasksRuntimeConfig,
} from './runtime.js';
import { RUN_QUEUE, RUN_QUEUE_OPTIONS, SchedulerService } from './scheduler.js';
import { RedisTaskFs, TASK_FS } from './task-fs.js';
import { TaskStore } from './task-store.js';

export interface TasksModuleOptions {
  /**
   * Called from `onModuleInit` with the wired service bundle. The plugin
   * instance stores it so its tools (created at boot, before Nest
   * initialises) can reach the module's services lazily.
   */
  onReady: (runtime: TasksRuntime) => void;
}

const OPTIONS = Symbol('TASKS_MODULE_OPTIONS');

@Module({})
export class TasksModule implements OnModuleInit, OnModuleDestroy {
  static register(options: TasksModuleOptions): DynamicModule {
    return {
      module: TasksModule,
      imports: [
        ConfigModule,
        MessagesModule,
        SessionsModule,
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: {
              url: config.getOrThrow<string>('REDIS_URL'),
              maxRetriesPerRequest: null,
              enableReadyCheck: true,
            },
          }),
        }),
        BullModule.registerQueue({
          name: RUN_QUEUE,
          defaultJobOptions: RUN_QUEUE_OPTIONS,
        }),
      ],
      providers: [
        { provide: OPTIONS, useValue: options },
        {
          provide: TASKS_RUNTIME_CONFIG,
          inject: [ConfigService],
          useFactory: (config: ConfigService): TasksRuntimeConfig => ({
            maxTasksPerUser: Number(config.get('TASKS_MAX_PER_USER') ?? 50),
            runLockTtlSec: Number(config.get('TASKS_RUN_LOCK_TTL_SEC') ?? 600),
            minCronIntervalSec: Number(
              config.get('TASKS_MIN_CRON_INTERVAL_SEC') ?? 300,
            ),
          }),
        },
        {
          provide: TASKS_REDIS,
          inject: [ConfigService],
          // Unlike the BullMQ root connection (where blocking worker reads
          // require `maxRetriesPerRequest: null`), this state client keeps
          // ioredis's default retry cap so reads fail fast during a Redis
          // outage instead of queueing forever and stalling chat turns.
          useFactory: (config: ConfigService) =>
            new Redis(config.getOrThrow<string>('REDIS_URL'), {
              enableReadyCheck: true,
            }),
        },
        { provide: TASK_FS, useClass: RedisTaskFs },
        RedisState,
        TaskStore,
        SchedulerService,
        DeliveryService,
        AgentInvoker,
        TaskRunWorker,
      ],
    };
  }

  constructor(
    @Inject(OPTIONS) private readonly options: TasksModuleOptions,
    @Inject(TASKS_RUNTIME_CONFIG) private readonly config: TasksRuntimeConfig,
    @Inject(TASKS_REDIS) private readonly redis: Redis,
    private readonly store: TaskStore,
    private readonly state: RedisState,
    private readonly scheduler: SchedulerService,
    private readonly delivery: DeliveryService,
    private readonly invoker: AgentInvoker,
    private readonly bridge: MatrixListenerBridge,
  ) {}

  onModuleInit(): void {
    this.options.onReady({
      config: this.config,
      store: this.store,
      state: this.state,
      scheduler: this.scheduler,
      delivery: this.delivery,
      invoker: this.invoker,
    });
    // Pin every message in a dedicated task room to that room's bound run
    // session, so a user's plainly-typed approval reply continues the run's
    // thread instead of starting a fresh one.
    this.bridge.setRoomSessionResolver((roomId) =>
      this.state.getRoomSession(roomId),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
