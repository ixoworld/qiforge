import { SYNTHETIC_SESSION_PREFIX } from '../../../modules/messages/synthetic-session.js';
import type { ApprovalFlow } from './approval-flow.js';
import type { DeliveryService } from './delivery.js';
import type { AgentInvoker } from './invoker.js';
import type { RedisState } from './redis-state.js';
import type { SchedulerService } from './scheduler.js';
import type { TaskStore } from './task-store.js';

/** Consecutive failed/rejected runs before a task pauses for review. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Session-id prefix for the synthetic sessions task runs execute on. Sourced
 * from the core constant so the messages layer (replay threading, post-sync,
 * session listing) recognizes task sessions by the same prefix. The leading
 * `$` matches Matrix event-id syntax, and the prefix is what shows up as the
 * LangSmith thread id for those runs.
 */
export const TASK_SESSION_PREFIX = SYNTHETIC_SESSION_PREFIX;

/** DI token for the parsed plugin config (`TasksModule` provides it). */
export const TASKS_RUNTIME_CONFIG = Symbol('TASKS_RUNTIME_CONFIG');

export interface TasksRuntimeConfig {
  maxTasksPerUser: number;
  runLockTtlSec: number;
  minCronIntervalSec: number;
}

/**
 * The service bundle the Nest module hands back to the plugin instance once
 * DI has initialised (`TasksModule` calls `onReady` from `onModuleInit`).
 * Tool handlers run long after boot, so they read it lazily via the plugin's
 * getter and fail soft when the module isn't up yet.
 */
export interface TasksRuntime {
  config: TasksRuntimeConfig;
  store: TaskStore;
  state: RedisState;
  scheduler: SchedulerService;
  delivery: DeliveryService;
  invoker: AgentInvoker;
  approvalFlow: ApprovalFlow;
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
