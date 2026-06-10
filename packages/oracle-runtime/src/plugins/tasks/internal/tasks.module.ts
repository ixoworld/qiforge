import { BullModule } from '@nestjs/bullmq';
import { Inject, Module, type DynamicModule } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { MessagesModule } from '../../../modules/messages/messages.module.js';
import { SessionsModule } from '../../../modules/sessions/sessions.module.js';
import { ApprovalService, APPROVAL_GATE_PORT } from './approval.js';
import { DeliveryService } from './delivery.js';
import { AgentInvoker } from './invoker.js';
import { RedisState, TASKS_REDIS } from './redis-state.js';
import { TaskRunWorker } from './run.worker.js';
import {
  TASKS_RUNTIME_CONFIG,
  type TasksRuntime,
  type TasksRuntimeConfig,
} from './runtime.js';
import {
  APPROVAL_QUEUE,
  APPROVAL_QUEUE_OPTIONS,
  RUN_QUEUE,
  RUN_QUEUE_OPTIONS,
  SchedulerService,
} from './scheduler.js';
import { RedisTaskFs, TASK_FS } from './task-fs.js';
import { TaskStore } from './task-store.js';
import { ApprovalTimeoutWorker } from './timeout.worker.js';

export interface TasksModuleOptions {
  /**
   * Called from `onModuleInit` with the wired service bundle. The plugin
   * instance stores it so its tools and middleware (created at boot, before
   * Nest initialises) can reach the module's services lazily.
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
        BullModule.registerQueue(
          { name: RUN_QUEUE, defaultJobOptions: RUN_QUEUE_OPTIONS },
          { name: APPROVAL_QUEUE, defaultJobOptions: APPROVAL_QUEUE_OPTIONS },
        ),
      ],
      providers: [
        { provide: OPTIONS, useValue: options },
        {
          provide: TASKS_RUNTIME_CONFIG,
          inject: [ConfigService],
          useFactory: (config: ConfigService): TasksRuntimeConfig => ({
            maxTasksPerUser: Number(config.get('TASKS_MAX_PER_USER') ?? 50),
            runLockTtlSec: Number(config.get('TASKS_RUN_LOCK_TTL_SEC') ?? 600),
          }),
        },
        {
          provide: TASKS_REDIS,
          inject: [ConfigService],
          useFactory: (config: ConfigService) =>
            new Redis(config.getOrThrow<string>('REDIS_URL'), {
              maxRetriesPerRequest: null,
              enableReadyCheck: true,
            }),
        },
        { provide: TASK_FS, useClass: RedisTaskFs },
        RedisState,
        TaskStore,
        SchedulerService,
        DeliveryService,
        AgentInvoker,
        ApprovalService,
        { provide: APPROVAL_GATE_PORT, useExisting: ApprovalService },
        TaskRunWorker,
        ApprovalTimeoutWorker,
      ],
      exports: [APPROVAL_GATE_PORT],
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
    private readonly approval: ApprovalService,
    private readonly invoker: AgentInvoker,
  ) {}

  onModuleInit(): void {
    this.options.onReady({
      config: this.config,
      store: this.store,
      state: this.state,
      scheduler: this.scheduler,
      delivery: this.delivery,
      approval: this.approval,
      invoker: this.invoker,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
