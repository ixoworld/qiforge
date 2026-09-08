/**
 * Scheduled-tasks plugin for the Workers runtime.
 *
 * The heavy lifting — storage in the user's own SQLite file, Durable Object
 * alarm scheduling, run execution, delivery, the approval flow — lives in the
 * HOST (`src/tasks/scheduler.ts`, wired by `UserOracleDO`) and is exposed to
 * plugins as `ctx.tasks` (`OracleTasksSurface`). This plugin contributes:
 *
 *   - the 10 main-agent tools (preview / create / list / get / update /
 *     pause / resume / cancel / resolve_task_approval / suggest_spec_fix),
 *     each driving `ctx.tasks`;
 *   - the approval-gate middleware that hints the model when a
 *     `before-action` run is waiting on the user's decision.
 *
 * Tasks are available whenever the host provides `ctx.tasks` (always on
 * Workers), so `autoDetect` is unconditionally true; on a host without a
 * scheduler every tool degrades to a clear "not available" error.
 *
 * `TASKS_MAX_PER_USER` (default 50) and `TASKS_MIN_CRON_INTERVAL_SEC`
 * (default 300) are declared here so operators can tune them through the
 * Worker env; the host forwards them into `createTaskScheduler` via
 * `TaskSchedulerHost.maxTasksPerUser` / `.minCronIntervalSec`.
 *
 * Middlewares are built once at boot while the tasks surface is per-user, so
 * the plugin stashes each request's `ctx.tasks` keyed by the authenticated
 * user DID (`getRequestTools` runs on every agent build, before any model
 * call) and the middleware looks the surface up per turn.
 */
import { z } from 'zod';
import { defineOraclePlugin } from '../../plugin-api/define-plugin';
import type { OraclePlugin } from '../../plugin-api/oracle-plugin';
import type { OracleTasksSurface } from '../../plugin-api/types';
import { createTaskApprovalGateMiddleware } from './middleware';
import { tasksManifest } from './manifest';
import { createTaskTools } from './tasks-tools';

export const tasksConfigSchema = z.object({
  TASKS_MAX_PER_USER: z.coerce.number().int().positive().default(50),
  TASKS_MIN_CRON_INTERVAL_SEC: z.coerce.number().int().positive().default(300),
});

export const TASKS_PLUGIN_NAME = 'tasks';

export function createTasksPlugin(): OraclePlugin {
  // ctx.tasks per user DID, refreshed on every agent build. One plugin
  // instance can serve several users' Durable Objects in the same isolate,
  // so the key is the authenticated DID from the request context.
  const surfaces = new Map<string, OracleTasksSurface>();

  return defineOraclePlugin({
    name: TASKS_PLUGIN_NAME,
    version: '1.0.0',
    manifest: tasksManifest,
    configSchema: tasksConfigSchema,
    autoDetectHint:
      'always on — the user Durable Object provides the scheduler (ctx.tasks)',
    autoDetect: () => true,
    getTools: () => createTaskTools(),
    getRequestTools: (rtCtx) => {
      if (rtCtx.tasks) surfaces.set(rtCtx.user.did, rtCtx.tasks);
      else surfaces.delete(rtCtx.user.did);
      return [];
    },
    getMiddlewares: (ctx) => [
      createTaskApprovalGateMiddleware({
        surfaceFor: (userDid) => surfaces.get(userDid),
        logger: ctx.logger,
      }),
    ],
  });
}

/** Ready-to-register instance (safe to share — state is keyed per user DID). */
export const TasksPlugin: OraclePlugin = createTasksPlugin();
