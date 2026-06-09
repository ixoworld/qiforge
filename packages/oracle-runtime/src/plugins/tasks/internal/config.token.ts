export const TASKS_CONFIG = Symbol('TASKS_CONFIG');

export interface TasksConfig {
  redisUrl: string;
  defaultTimezone: string;
  maxPerUser: number;
  runLockTtlSec: number;
  /** Default `maxConsecutiveFailures` for new tasks (override per-task is V2). */
  maxConsecutiveFailures: number;
}
