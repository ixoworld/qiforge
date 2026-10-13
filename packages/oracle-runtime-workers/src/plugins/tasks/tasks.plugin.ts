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
 * the plugin holds each request's `ctx.tasks` keyed by the authenticated
 * user DID for the length of the turn (`getRequestTools` runs on every agent
 * build, before any model call; `onTurnEnd` releases it) and the middleware
 * looks the surface up per model call — see `TaskSurfaceRegistry`.
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

/**
 * `ctx.tasks` per user DID, for the turns that are running. One plugin
 * instance serves every user object in the isolate, and a surface keeps its
 * user object's scheduler and store reachable, so an entry lives only while
 * a turn of that user holds it: `hold` at the agent build, the returned
 * release at the turn's end. Overlapping turns of one user (two sessions)
 * share the entry; the last release drops it.
 */
export class TaskSurfaceRegistry {
  private readonly entries = new Map<
    string,
    { surface: OracleTasksSurface; turns: number }
  >();

  /** Hold `surface` for `did` for one turn. The release runs once. */
  hold(did: string, surface: OracleTasksSurface): () => void {
    let entry = this.entries.get(did);
    if (entry) {
      entry.surface = surface;
      entry.turns += 1;
    } else {
      entry = { surface, turns: 1 };
      this.entries.set(did, entry);
    }
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.turns -= 1;
      if (held.turns <= 0 && this.entries.get(did) === held)
        this.entries.delete(did);
    };
  }

  /** The user's turn runs without a scheduler: forget any surface. */
  clear(did: string): void {
    this.entries.delete(did);
  }

  surfaceFor(did: string): OracleTasksSurface | undefined {
    return this.entries.get(did)?.surface;
  }

  /** Users with an entry (diagnostics, tests). */
  get size(): number {
    return this.entries.size;
  }
}

export function createTasksPlugin(
  surfaces: TaskSurfaceRegistry = new TaskSurfaceRegistry(),
): OraclePlugin {
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
      if (!rtCtx.tasks) {
        surfaces.clear(rtCtx.user.did);
        return [];
      }
      // A host without per-turn cleanup keeps the entry until the user's
      // next turn without a scheduler (the Workers host always has it).
      rtCtx.onTurnEnd?.(surfaces.hold(rtCtx.user.did, rtCtx.tasks));
      return [];
    },
    getMiddlewares: (ctx) => [
      createTaskApprovalGateMiddleware({
        surfaceFor: (userDid) => surfaces.surfaceFor(userDid),
        logger: ctx.logger,
      }),
    ],
  });
}

/** Ready-to-register instance (safe to share — state is keyed per user DID). */
export const TasksPlugin: OraclePlugin = createTasksPlugin();
