import type { DynamicModule } from '@nestjs/common';
import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  AgentMiddleware,
  PluginContext,
  PluginManifest,
  PluginTool,
} from '../../plugin-api/types.js';
import { createApprovalGateMiddleware } from './internal/middleware.js';
import type { TasksRuntime } from './internal/runtime.js';
import { TasksModule } from './internal/tasks.module.js';
import { createTaskTools } from './internal/tools.js';
import { tasksManifest } from './manifest.js';

const configSchema = z.object({
  REDIS_URL: z.string(),
  TASKS_MAX_PER_USER: z.coerce.number().int().positive().default(50),
  TASKS_RUN_LOCK_TTL_SEC: z.coerce.number().int().positive().default(600),
});

/**
 * Scheduled-tasks plugin. Auto-detects on `REDIS_URL`. When loaded:
 *
 *   - 10 always-on tools (preview / create / list / get / update / pause /
 *     resume / cancel / suggest_spec_fix / resolve_pending_approval)
 *   - one model-call middleware — the approval gate — that intercepts user
 *     replies to pending approval requests
 *   - a NestJS module with two BullMQ queues (`task_run`, `task_approval`)
 *     and their workers
 *
 * Tools and the middleware are built at boot, but the module's services only
 * exist once Nest initialises — so the module hands the wired bundle back via
 * `onReady` and everything reads it lazily through `this.runtime`.
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
      createApprovalGateMiddleware({
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
