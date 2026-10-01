export const TASK_EXECUTION_PROFILES = ['supplied-context-markdown'] as const;

export type TaskExecutionProfile = (typeof TASK_EXECUTION_PROFILES)[number];

export function isTaskExecutionProfile(
  value: unknown,
): value is TaskExecutionProfile {
  return (TASK_EXECUTION_PROFILES as readonly unknown[]).includes(value);
}

export function taskExecutionProfile(
  value: unknown,
): TaskExecutionProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (isTaskExecutionProfile(value)) return value;
  throw new Error('Unsupported task execution profile');
}
