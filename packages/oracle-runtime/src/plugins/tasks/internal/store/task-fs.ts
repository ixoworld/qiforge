/**
 * The 4-method filesystem port. Today: Redis-backed. Tomorrow: a UCAN per-user
 * filesystem (same auth model as sandbox). Swapping adapters is one DI
 * binding — workers and tools never see the backend.
 */
export const TASK_FS = Symbol('TASK_FS');

export interface TaskFs {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Returns absolute paths under `prefix`. */
  list(prefix: string): Promise<string[]>;
}
