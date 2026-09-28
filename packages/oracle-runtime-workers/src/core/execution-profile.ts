export type TaskExecutionProfile = 'supplied-context-markdown';

export function taskExecutionProfile(
  value: unknown,
): TaskExecutionProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'supplied-context-markdown') return value;
  throw new Error('Unsupported task execution profile');
}
