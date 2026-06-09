/**
 * DI token for the shared ioredis client used by tasks.
 * Provided by `TasksModule` from `REDIS_URL`.
 */
export const TASKS_REDIS = Symbol('TASKS_REDIS');
