import { type DynamicModule } from '@nestjs/common';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import {
  createApprovalGateMiddleware,
  type ApprovalQueueJobData,
} from './internal/approval/approval-gate.middleware.js';
import { QUEUE_NAMES } from './internal/scheduler/queues.js';
import { TasksModule } from './internal/tasks.module.js';
import { createTaskTool } from './internal/tools/create-task.js';
import { getTaskTool } from './internal/tools/get-task.js';
import { listMyTasksTool } from './internal/tools/list-my-tasks.js';
import {
  cancelTaskTool,
  pauseTaskTool,
  resumeTaskTool,
} from './internal/tools/pause-resume-cancel.js';
import { previewTaskTool } from './internal/tools/preview-task.js';
import { suggestSpecFixTool } from './internal/tools/suggest-spec-fix.js';
import { updateTaskTool } from './internal/tools/update-task.js';
import { tasksManifest } from './manifest.js';
import { Queue } from 'bullmq';

const TasksConfigSchema = z.object({
  REDIS_URL: z.string(),
  TASKS_DEFAULT_TIMEZONE: z.string().default('UTC'),
  TASKS_MAX_PER_USER: z.coerce.number().int().positive().default(50),
  TASKS_RUN_LOCK_TTL_SEC: z.coerce.number().int().positive().default(600),
});

/**
 * Scheduled-tasks plugin. Auto-detects on `REDIS_URL`. When loaded:
 *
 *   - Exposes 9 tools on the main agent (preview / create / list / get /
 *     update / pause / resume / cancel / suggest_spec_fix).
 *   - Installs a pre-LLM middleware that intercepts user replies to
 *     pending approval requests (the "approval gate").
 *   - Registers a NestJS module with two BullMQ queues (`task_run`,
 *     `task_approval`) and two workers.
 *
 * The plugin itself owns no Redis client — the inner `TasksModule` does.
 * The approval-gate middleware is built per-request from a tiny side-channel
 * Redis + Queue pair (constructed in `getMiddlewares(ctx)`); these are kept
 * alive for the process lifetime via a module-level cache.
 */
export class TasksPlugin extends OraclePlugin {
  static readonly NAME = 'tasks';

  readonly name = TasksPlugin.NAME;

  readonly version = '1.0.0';

  readonly manifest: PluginManifest = tasksManifest;

  override readonly configSchema = TasksConfigSchema;

  override readonly softDependsOn = ['memory'];

  override readonly autoDetectHint = 'REDIS_URL';

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.REDIS_URL);
  }

  override getTools(): PluginTool[] {
    return [
      previewTaskTool,
      createTaskTool,
      listMyTasksTool,
      getTaskTool,
      updateTaskTool,
      pauseTaskTool,
      resumeTaskTool,
      cancelTaskTool,
      suggestSpecFixTool,
    ];
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    const cfg = ctx.config as Partial<z.infer<typeof TasksConfigSchema>>;
    const redisUrl = cfg.REDIS_URL;
    if (!redisUrl) {
      ctx.logger.warn?.(
        '[TasksPlugin] REDIS_URL missing — approval gate middleware disabled.',
      );
      return [];
    }

    const { redis, queue } = getSideChannel(redisUrl);
    return [
      createApprovalGateMiddleware({
        redis,
        approvalQueue: queue,
        logger: ctx.logger,
      }),
    ];
  }

  override getNestModules(): Array<DynamicModule> {
    return [TasksModule.register()];
  }
}

// --- middleware side-channel (Redis + BullMQ Queue) -------------------------
// Created once per process per Redis URL. The approval-gate middleware lives
// in the closure of `createApprovalGateMiddleware`; we keep its Redis +
// Queue handles alive here so they aren't recreated on every plugin context.

interface SideChannel {
  redis: Redis;
  queue: Queue<ApprovalQueueJobData>;
}

const sideChannels = new Map<string, SideChannel>();

function getSideChannel(redisUrl: string): SideChannel {
  const existing = sideChannels.get(redisUrl);
  if (existing) return existing;
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  const queue: Queue<ApprovalQueueJobData> = new Queue(QUEUE_NAMES.APPROVAL, {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
  });
  const channel: SideChannel = { redis, queue };
  sideChannels.set(redisUrl, channel);
  return channel;
}
