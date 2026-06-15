import type { DynamicModule } from '@nestjs/common';
import type { AgentMiddleware } from 'langchain';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import { createTaskRoomGateMiddleware } from './internal/middleware.js';
import type { TasksRuntime } from './internal/runtime.js';
import { TasksModule } from './internal/tasks.module.js';
import { createTaskTools } from './internal/tools.js';
import { tasksManifest } from './manifest.js';

const configSchema = z.object({
  REDIS_URL: z.string(),
  TASKS_MAX_PER_USER: z.coerce.number().int().positive().default(50),
  TASKS_RUN_LOCK_TTL_SEC: z.coerce.number().int().positive().default(600),
  TASKS_MIN_CRON_INTERVAL_SEC: z.coerce.number().int().positive().default(300),
});

/**
 * Scheduled-tasks plugin. Auto-detects on `REDIS_URL`. When loaded:
 *
 *   - 10 always-on tools (preview / create / list / get / update / pause /
 *     resume / cancel / resolve_task_approval / suggest_spec_fix)
 *   - a NestJS module with the `task_run` BullMQ queue and its worker
 *   - the task-room approval-gate middleware
 *
 * Tools are built at boot, but the module's services only exist once Nest
 * initialises — so the module hands the wired bundle back via `onReady` and
 * the tools read it lazily through `this.runtime`.
 *
 * A `before-action` task drafts its action in a dedicated room, lands on
 * `pending-approval`, and the user approves by replying there. The module
 * registers a room→session resolver on the Matrix bridge so a plainly-typed
 * reply continues the run's own conversation; the approval-gate middleware
 * records a plain yes/no decision deterministically before the model runs,
 * and nuanced replies are resolved by the agent via `resolve_task_approval`.
 */
export class TasksPlugin extends OraclePlugin {
  static readonly NAME = 'tasks';

  readonly name = TasksPlugin.NAME;

  readonly version = '2.0.0';

  readonly manifest: PluginManifest = tasksManifest;

  override readonly configSchema = configSchema;

  override readonly softDependsOn = ['memory'];

  override readonly autoDetectHint = 'REDIS_URL';

  private runtime: TasksRuntime | undefined;

  override autoDetect(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.REDIS_URL);
  }

  override getTools(): PluginTool[] {
    return createTaskTools(() => this.runtime);
  }

  override getMiddlewares(ctx: PluginContext): AgentMiddleware[] {
    return [
      createTaskRoomGateMiddleware({
        getRuntime: () => this.runtime,
        logger: ctx.logger,
      }),
    ];
  }

  override getNestModules(): DynamicModule[] {
    return [
      TasksModule.register({
        onReady: (runtime) => {
          this.runtime = runtime;
        },
      }),
    ];
  }
}
