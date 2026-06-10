import type { ApprovalService } from './approval.js';
import type { DeliveryService } from './delivery.js';
import type { AgentInvoker } from './invoker.js';
import type { RedisState } from './redis-state.js';
import type { SchedulerService } from './scheduler.js';
import type { TaskStore } from './task-store.js';

/** Consecutive failed/rejected runs before a task pauses for review. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** DI token for the parsed plugin config (`TasksModule` provides it). */
export const TASKS_RUNTIME_CONFIG = Symbol('TASKS_RUNTIME_CONFIG');

export interface TasksRuntimeConfig {
  maxTasksPerUser: number;
  runLockTtlSec: number;
}

/**
 * The service bundle the Nest module hands back to the plugin instance once
 * DI has initialised (`TasksModule` calls `onReady` from `onModuleInit`).
 * Tool handlers and the approval-gate middleware run long after boot, so
 * they read it lazily via the plugin's getter and fail soft when the module
 * isn't up yet.
 */
export interface TasksRuntime {
  config: TasksRuntimeConfig;
  store: TaskStore;
  state: RedisState;
  scheduler: SchedulerService;
  delivery: DeliveryService;
  approval: ApprovalService;
  invoker: AgentInvoker;
}

export type GetTasksRuntime = () => TasksRuntime | undefined;

export function requireRuntime(get: GetTasksRuntime): TasksRuntime {
  const runtime = get();
  if (!runtime) {
    throw new Error(
      'Tasks plugin is still starting up — try again in a moment.',
    );
  }
  return runtime;
}
