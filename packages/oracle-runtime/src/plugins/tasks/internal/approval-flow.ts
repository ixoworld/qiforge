import { Injectable, Logger } from '@nestjs/common';
import { RedisState } from './redis-state.js';
import { TaskStore } from './task-store.js';
import type { TaskStatus, Trigger } from './spec.js';

export type ApprovalOutcome = 'approved' | 'declined';

/**
 * Pure transition table for resolving a `pending-approval` task. A cron task
 * always returns to `active` — its cadence continues whether the draft was
 * approved or declined (a decline just drops that one draft). A one-shot has
 * no next occurrence: approval completes it, a decline cancels it.
 */
export function nextStatusFor(
  outcome: ApprovalOutcome,
  trigger: Trigger['type'],
): TaskStatus {
  if (trigger === 'time.cron') return 'active';
  return outcome === 'approved' ? 'completed' : 'cancelled';
}

/**
 * The single place a pending approval is resolved — used by both the
 * task-room gate middleware (plain yes/no replies) and the
 * `resolve_task_approval` tool (nuanced replies the agent handled itself).
 * Only flips status; performing or skipping the drafted action is the
 * agent's job on the same turn.
 */
@Injectable()
export class ApprovalFlow {
  private readonly logger = new Logger(ApprovalFlow.name);

  constructor(
    private readonly store: TaskStore,
    private readonly state: RedisState,
  ) {}

  async resolve(
    owner: string,
    taskId: string,
    outcome: ApprovalOutcome,
  ): Promise<{ ok: true; status: TaskStatus } | { ok: false; error: string }> {
    const spec = await this.store.load(owner, taskId);
    if (!spec) return { ok: false, error: 'Task not found.' };
    if (spec.frontmatter.status !== 'pending-approval') {
      return { ok: false, error: 'No approval is pending for this task.' };
    }

    const trigger = spec.frontmatter.trigger;
    const status = nextStatusFor(outcome, trigger.type);
    // A cron task's next run was already enqueued when the draft was posted —
    // keep its timestamp. A one-shot has nothing left to run.
    const nextRunAt =
      trigger.type === 'time.cron' ? spec.frontmatter.stats.nextRunAt : null;
    await this.store.setStatus(owner, taskId, status, nextRunAt);

    // An approved draft proves the task works end-to-end. A decline is the
    // user's editorial call, not a failure — leave the counter alone.
    if (outcome === 'approved') await this.state.resetFailures(taskId);

    this.logger.log(`Approval resolved: ${taskId} ${outcome} → ${status}`);
    return { ok: true, status };
  }
}
