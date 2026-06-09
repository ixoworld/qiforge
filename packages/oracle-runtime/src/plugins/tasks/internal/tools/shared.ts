import type { ApprovalService } from '../approval/approval.service.js';
import type { DedicatedRoomService } from '../delivery/dedicated-room.service.js';
import type { PostResultService } from '../delivery/post-result.js';
import type { RoomResolver } from '../delivery/room-resolver.js';
import type { AutomationInvoker } from '../runtime/automation-invoker.js';
import type { SchedulerService } from '../scheduler/scheduler.service.js';
import type { EphemeralStateService } from '../store/ephemeral-state.js';
import type { TaskFs } from '../store/task-fs.js';

/**
 * Module-scoped service locator. Plain-function tools returned by
 * `getTools(ctx)` need access to Nest-DI'd services, but they're constructed
 * before NestJS initialises providers. `TasksModule.onModuleInit` binds the
 * services into this registry; tool handlers read them at handler execution.
 *
 * Yes, it's a service locator. It's localised to this plugin, the surface
 * is small, and the alternative (deferred-tool registration, threading
 * services through `ctx`) is more plumbing than the runtime gives us. The
 * `notReady()` error path is the safety net.
 */
export interface TasksToolRegistry {
  fs: TaskFs;
  scheduler: SchedulerService;
  state: EphemeralStateService;
  approval: ApprovalService;
  roomResolver: RoomResolver;
  dedicatedRoom: DedicatedRoomService;
  post: PostResultService;
  invoker: AutomationInvoker;
}

let registry: Partial<TasksToolRegistry> = {};

export function bindTasksTools(r: TasksToolRegistry): void {
  registry = { ...r };
}

export function tools(): TasksToolRegistry {
  const missing = (
    [
      'fs',
      'scheduler',
      'state',
      'approval',
      'roomResolver',
      'dedicatedRoom',
      'post',
      'invoker',
    ] as const
  ).filter((k) => registry[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`Tasks plugin not ready — missing: ${missing.join(', ')}`);
  }
  return registry as TasksToolRegistry;
}

/** Reset — useful in tests. */
export function resetTasksTools(): void {
  registry = {};
}
