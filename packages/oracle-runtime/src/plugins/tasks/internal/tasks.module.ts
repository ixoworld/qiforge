import { BullModule, getQueueToken } from '@nestjs/bullmq';
import {
  Global,
  Inject,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  type DynamicModule,
  type Provider,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import {
  ApprovalService,
  APPROVAL_GATE_PORT,
} from './approval/approval.service.js';
import { IntentClassifier } from './approval/intent-classifier.js';
import { TASKS_CONFIG, type TasksConfig } from './config.token.js';
import { DedicatedRoomService } from './delivery/dedicated-room.service.js';
import { PostResultService } from './delivery/post-result.js';
import { RoomResolver } from './delivery/room-resolver.js';
import { AutomationInvoker } from './runtime/automation-invoker.js';
import { QUEUE_DEFAULT_OPTIONS, QUEUE_NAMES } from './scheduler/queues.js';
import { SchedulerService } from './scheduler/scheduler.service.js';
import { EphemeralStateService } from './store/ephemeral-state.js';
import { RedisTaskFs } from './store/redis-task-fs.js';
import { TASKS_REDIS } from './store/redis.token.js';
import { TASK_FS } from './store/task-fs.js';
import { bindTasksTools } from './tools/shared.js';
import { ApprovalEventsWorker } from './worker/approval-events.worker.js';
import { TaskRunWorker } from './worker/task-run.worker.js';
import { MessagesModule } from '../../../modules/messages/messages.module.js';
import { SessionsModule } from '../../../modules/sessions/sessions.module.js';

function configProvider(): Provider {
  return {
    provide: TASKS_CONFIG,
    inject: [ConfigService],
    useFactory: (config: ConfigService): TasksConfig => ({
      redisUrl: config.getOrThrow<string>('REDIS_URL'),
      defaultTimezone: config.get<string>('TASKS_DEFAULT_TIMEZONE') ?? 'UTC',
      maxPerUser: Number(config.get('TASKS_MAX_PER_USER') ?? 50),
      runLockTtlSec: Number(config.get('TASKS_RUN_LOCK_TTL_SEC') ?? 600),
      maxConsecutiveFailures: 3,
    }),
  };
}

function redisProvider(): Provider {
  return {
    provide: TASKS_REDIS,
    inject: [TASKS_CONFIG],
    useFactory: (cfg: TasksConfig): Redis => {
      return new Redis(cfg.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
    },
  };
}

const fsProvider: Provider = {
  provide: TASK_FS,
  useClass: RedisTaskFs,
};

const approvalPortProvider: Provider = {
  provide: APPROVAL_GATE_PORT,
  useExisting: ApprovalService,
};

@Global()
@Module({})
export class TasksModule implements OnModuleInit, OnModuleDestroy {
  static register(): DynamicModule {
    return {
      module: TasksModule,
      imports: [
        ConfigModule,
        MessagesModule,
        SessionsModule,
        BullModule.forRootAsync({
          inject: [TASKS_CONFIG],
          useFactory: (cfg: TasksConfig) => ({
            connection: {
              url: cfg.redisUrl,
              maxRetriesPerRequest: null,
              enableReadyCheck: true,
            },
          }),
        }),
        BullModule.registerQueue({
          name: QUEUE_NAMES.RUN,
          defaultJobOptions: QUEUE_DEFAULT_OPTIONS[QUEUE_NAMES.RUN],
        }),
        BullModule.registerQueue({
          name: QUEUE_NAMES.APPROVAL,
          defaultJobOptions: QUEUE_DEFAULT_OPTIONS[QUEUE_NAMES.APPROVAL],
        }),
      ],
      providers: [
        configProvider(),
        redisProvider(),
        fsProvider,
        EphemeralStateService,
        SchedulerService,
        IntentClassifier,
        PostResultService,
        RoomResolver,
        DedicatedRoomService,
        AutomationInvoker,
        ApprovalService,
        approvalPortProvider,
        TaskRunWorker,
        ApprovalEventsWorker,
      ],
      exports: [
        TASKS_REDIS,
        TASK_FS,
        TASKS_CONFIG,
        ApprovalService,
        APPROVAL_GATE_PORT,
        getQueueToken(QUEUE_NAMES.RUN),
        getQueueToken(QUEUE_NAMES.APPROVAL),
      ],
    };
  }

  constructor(
    @Inject(TASK_FS) private readonly fs: RedisTaskFs,
    private readonly scheduler: SchedulerService,
    private readonly state: EphemeralStateService,
    private readonly approval: ApprovalService,
    private readonly roomResolver: RoomResolver,
    private readonly dedicatedRoom: DedicatedRoomService,
    private readonly post: PostResultService,
    private readonly invoker: AutomationInvoker,
    @Inject(TASKS_REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    bindTasksTools({
      fs: this.fs,
      scheduler: this.scheduler,
      state: this.state,
      approval: this.approval,
      roomResolver: this.roomResolver,
      dedicatedRoom: this.dedicatedRoom,
      post: this.post,
      invoker: this.invoker,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {
      /* ignore */
    });
  }
}
