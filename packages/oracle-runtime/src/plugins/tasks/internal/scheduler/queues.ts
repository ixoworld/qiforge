import type { JobsOptions } from 'bullmq';

export const QUEUE_NAMES = {
  RUN: 'task_run',
  APPROVAL: 'task_approval',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUE_DEFAULT_OPTIONS: Record<QueueName, JobsOptions> = {
  [QUEUE_NAMES.RUN]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 100, age: 24 * 3600 },
    removeOnFail: { count: 200, age: 7 * 24 * 3600 },
  },
  [QUEUE_NAMES.APPROVAL]: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 10_000 },
    removeOnComplete: { count: 100, age: 24 * 3600 },
    removeOnFail: { count: 100, age: 7 * 24 * 3600 },
  },
};

export interface TaskRunJobData {
  taskId: string;
  owner: string;
  runId: string;
}

export type ApprovalTimeoutPhase = 'reminder' | 'expiry';

export interface ApprovalTimeoutJobData {
  taskId: string;
  owner: string;
  roomId: string;
  phase: ApprovalTimeoutPhase;
}

export const RUN_JOB_NAME = 'run';
export const APPROVAL_TIMEOUT_JOB_NAME = 'timeout';
