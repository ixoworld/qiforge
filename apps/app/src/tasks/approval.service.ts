/**
 * ApprovalService — Core logic for task approval gates.
 *
 * Handles storing pending work results in Redis, processing user
 * approval/rejection responses, and delivering or discarding results.
 *
 * Shared between Portal API and Matrix message paths.
 *
 * @see spec §14 — Approval Gates
 */

import { SessionManagerService } from '@ixo/common';
import { MatrixManager } from '@ixo/matrix';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import type { ENV } from 'src/types';

import {
  APPROVAL_EXPIRY_MS,
  APPROVAL_REMINDER_MS,
  APPROVAL_REQUEST_EVENT_TYPE,
  APPROVAL_RESULT_PREFIX,
  APPROVAL_RESULT_TTL_SECONDS,
  APPROVAL_ROOM_PREFIX,
  APPROVAL_ROOMREF_PREFIX,
  formatApprovalRequestMessage,
  sendTaskNotification,
  TASK_RUN_EVENT_TYPE,
  truncateText,
  type ApprovalRequestEventContent,
  type TaskRunEventContent,
  type WorkResult,
} from './processors/processor-utils';
import { QUEUE_NAMES } from './scheduler/task-queues';
import { TasksScheduler } from './scheduler/tasks-scheduler.service';
import type { ApprovalTimeoutJobData } from './scheduler/types';
import { appendOutputToPage, appendRejectionToPage } from './task-doc-helpers';
import type { TaskMeta } from './task-meta';
import { TasksService } from './task.service';

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly tasksService: TasksService,
    private readonly scheduler: TasksScheduler,
    private readonly config: ConfigService<ENV>,
    private readonly sessionManagerService: SessionManagerService,
    @InjectQueue(QUEUE_NAMES.APPROVAL)
    private readonly approvalQueue: Queue<ApprovalTimeoutJobData>,
  ) {}

  /**
   * Fast lookup: is there a pending approval in this room?
   * Returns the taskId if yes, null otherwise. Single Redis GET.
   */
  async getPendingTaskForRoom(roomId: string): Promise<string | null> {
    const client = await this.approvalQueue.client;
    const taskId = await client.get(`${APPROVAL_ROOM_PREFIX}${roomId}`);
    return taskId ?? null;
  }

  /**
   * Store a work result in Redis and post an approval request message.
   * Called by the DeliverProcessor when `requiresApproval` is true.
   *
   * @returns The event ID of the approval request message
   */
  async requestApproval(params: {
    taskId: string;
    userDid: string;
    matrixUserId: string;
    roomId: string;
    mainRoomId: string;
    workResult: WorkResult;
    meta: TaskMeta;
    title?: string;
  }): Promise<string | undefined> {
    const { taskId, userDid, matrixUserId, roomId, mainRoomId, workResult } =
      params;

    // 1. Store work result + title in Redis
    const redisKey = `${APPROVAL_RESULT_PREFIX}${taskId}`;
    const client = await this.approvalQueue.client;
    await client.set(
      redisKey,
      JSON.stringify({ workResult, title: params.title }),
      {
        EX: APPROVAL_RESULT_TTL_SECONDS,
      },
    );
    // Store room→task and task→room lookup keys for fast approval checks
    await client.set(`${APPROVAL_ROOM_PREFIX}${roomId}`, taskId, {
      EX: APPROVAL_RESULT_TTL_SECONDS,
    });
    await client.set(`${APPROVAL_ROOMREF_PREFIX}${taskId}`, roomId, {
      EX: APPROVAL_RESULT_TTL_SECONDS,
    });
    this.logger.debug(
      `Stored work result in Redis: key=${redisKey}, TTL=${APPROVAL_RESULT_TTL_SECONDS}s`,
    );

    // 2. Post approval request message to room (with structured metadata for FE)
    const message = formatApprovalRequestMessage(taskId, workResult.result);
    const mxManager = MatrixManager.getInstance();
    const approvalEventId = await sendTaskNotification({
      roomId,
      matrixUserId,
      message,
      notificationPolicy: 'channel_and_mention',
      isDryRun: false,
      sessionId: params.meta.sessionId,
      sessionManagerService: this.sessionManagerService,
      configService: this.config,
    });

    // 3. Post a custom approval event for tracking
    const approvalContent: ApprovalRequestEventContent = {
      taskId,
      status: 'pending',
      preview: truncateText(workResult.result, 500),
      requestedAt: new Date().toISOString(),
    };
    await mxManager.sendMatrixEvent(
      roomId,
      APPROVAL_REQUEST_EVENT_TYPE,
      approvalContent,
    );

    // 4. Update TaskMeta with pending approval
    await this.tasksService.updateTask({
      taskId,
      mainRoomId,
      updates: { pendingApprovalEventId: approvalEventId ?? null },
    });

    // 5. Schedule timeout jobs (reminder at 24h, expiry at 48h)
    await this.scheduler.scheduleApprovalTimeouts({
      taskId,
      data: {
        taskId,
        userDid,
        matrixUserId,
        roomId,
        mainRoomId,
        phase: 'reminder',
      },
      reminderDelayMs: APPROVAL_REMINDER_MS,
      expiryDelayMs: APPROVAL_EXPIRY_MS,
    });

    this.logger.log(
      `Approval requested for task ${taskId}, eventId=${approvalEventId}`,
    );
    return approvalEventId;
  }

  /**
   * Handle a user's approval or rejection response.
   * Called when the user replies to an approval request (from Portal or Matrix).
   */
  async handleApprovalResponse(params: {
    taskId: string;
    approved: boolean;
    mainRoomId: string;
    rejectionReason?: string;
  }): Promise<void> {
    const { taskId, approved, mainRoomId, rejectionReason } = params;
    this.logger.log(
      `Processing approval response for task ${taskId}: ${approved ? 'APPROVED' : 'REJECTED'}`,
    );

    const client = await this.approvalQueue.client;

    // Atomicity guard: use Redis SETNX to prevent concurrent handling.
    // Only one caller can acquire the lock — duplicates are silently dropped.
    const lockKey = `task:approval-lock:${taskId}`;
    // FIX: Redis v4+ node-redis client: SET options must be an object, not multiple arguments
    const acquired = await client.set(lockKey, '1', {
      EX: 60,
    });
    if (!acquired) {
      this.logger.warn(
        `Task ${taskId} approval response already being processed, ignoring duplicate`,
      );
      return;
    }

    try {
      // 1. Load TaskMeta (bypass cache to get fresh state)
      const meta = await this.tasksService.getTask(
        { taskId, mainRoomId },
        { bypassCache: true },
      );

      if (!meta.pendingApprovalEventId) {
        this.logger.warn(
          `Task ${taskId} has no pending approval, ignoring response`,
        );
        return;
      }

      // 2. Load cached work result from Redis
      const redisKey = `${APPROVAL_RESULT_PREFIX}${taskId}`;
      const rawResult = await client.get(redisKey);

      if (!rawResult) {
        this.logger.warn(
          `No cached work result found for task ${taskId}, may have expired`,
        );
        const mxManager = MatrixManager.getInstance();
        const roomId = meta.customRoomId ?? mainRoomId;
        await mxManager.sendMessage({
          roomId,
          message:
            'The task result has expired and is no longer available. The next scheduled run will produce a new result for review.',
          isOracleAdmin: true,
        });
        await this.clearApprovalState(taskId, mainRoomId);
        return;
      }

      const parsed: { workResult: WorkResult; title?: string } =
        JSON.parse(rawResult);
      // Handle both old format (plain WorkResult) and new format ({ workResult, title })
      const workResult: WorkResult =
        parsed.workResult ?? (parsed as unknown as WorkResult);
      const storedTitle: string | undefined = parsed.title;
      const roomId = meta.customRoomId ?? mainRoomId;
      const now = new Date();

      try {
        if (approved) {
          await this.deliverApprovedResult({
            taskId,
            meta,
            workResult,
            roomId,
            mainRoomId,
            now,
          });
        } else {
          await this.handleRejection({
            taskId,
            roomId,
            mainRoomId,
            meta,
            rejectionReason,
            title: storedTitle,
          });
        }
      } finally {
        // Clean up approval state (clears Redis result, TaskMeta, and timeout jobs)
        // Always runs even if deliverApprovedResult/handleRejection throws
        await this.clearApprovalState(taskId, mainRoomId);
      }
    } finally {
      // Release the atomicity lock
      await client.del(lockKey).catch(() => {});
    }
  }

  /**
   * Deliver an approved work result — mirrors DeliverProcessor's delivery logic.
   */
  private async deliverApprovedResult(params: {
    taskId: string;
    meta: TaskMeta;
    workResult: WorkResult;
    roomId: string;
    mainRoomId: string;
    now: Date;
  }): Promise<void> {
    const { taskId, meta, workResult, roomId, mainRoomId, now } = params;
    const mxManager = MatrixManager.getInstance();

    // Send the actual result to the room
    const formattedMessage = `**Task ${taskId} — Result (Approved)**\n\n${workResult.result}`;
    const messageEventId = await sendTaskNotification({
      roomId,
      matrixUserId: meta.matrixUserId,
      message: formattedMessage,
      notificationPolicy: meta.notificationPolicy,
      isDryRun: false,
      sessionId: meta.sessionId,
      sessionManagerService: this.sessionManagerService,
      configService: this.config,
    });

    // Append output to task page if it exists
    if (meta.hasPage) {
      await appendOutputToPage(meta, mainRoomId, workResult, messageEventId);
    }

    // Post task run event
    const runEventContent: TaskRunEventContent = {
      taskId,
      runAt: now.toISOString(),
      status: 'success',
      totalRuns: meta.totalRuns + 1,
      summary: truncateText(workResult.result, 100),
      tokensUsed: workResult.tokensUsed,
      costUsd: workResult.costUsd,
    };
    await mxManager.sendMatrixEvent(
      roomId,
      TASK_RUN_EVENT_TYPE,
      runEventContent,
    );

    // Update TaskMeta (clear rejection fields on successful delivery)
    await this.tasksService.updateTask({
      taskId,
      mainRoomId,
      updates: {
        lastRunAt: now.toISOString(),
        totalRuns: meta.totalRuns + 1,
        consecutiveFailures: 0,
        totalTokensUsed: meta.totalTokensUsed + workResult.tokensUsed,
        totalCostUsd: meta.totalCostUsd + workResult.costUsd,
        lastRejectionReason: null,
        lastRejectionAt: null,
        rejectionCount: 0,
      },
    });

    this.logger.log(`Delivered approved result for task ${taskId}`);
  }

  /**
   * Handle a rejected approval — persist rejection reason, notify user,
   * and immediately schedule a retry flow so the agent re-runs with feedback.
   */
  /** Maximum consecutive rejections before auto-pausing to avoid infinite LLM loops. */
  private static readonly MAX_REJECTION_COUNT = 3;

  private async handleRejection(params: {
    taskId: string;
    roomId: string;
    mainRoomId: string;
    meta: TaskMeta;
    rejectionReason?: string;
    title?: string;
  }): Promise<void> {
    const { taskId, roomId, mainRoomId, meta, rejectionReason, title } = params;
    const mxManager = MatrixManager.getInstance();
    const newRejectionCount = (meta.rejectionCount ?? 0) + 1;

    // 1. Persist rejection context in TaskMeta so the agent sees it on re-run
    await this.tasksService.updateTask({
      taskId,
      mainRoomId,
      updates: {
        lastRejectionReason: rejectionReason ?? 'No reason provided',
        lastRejectionAt: new Date().toISOString(),
        rejectionCount: newRejectionCount,
      },
    });

    // 2. Log rejection to task page Notes section (audit trail)
    if (meta.hasPage) {
      await appendRejectionToPage({
        meta,
        mainRoomId,
        rejectionCount: newRejectionCount,
        rejectionReason: rejectionReason ?? 'No reason provided',
      }).catch((err) => {
        this.logger.warn(
          `Failed to log rejection to task page: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    // 3. Circuit breaker: auto-pause after too many consecutive rejections
    if (newRejectionCount >= ApprovalService.MAX_REJECTION_COUNT) {
      await mxManager.sendMessage({
        roomId,
        message: `Result rejected ${newRejectionCount} times in a row. The task has been paused to avoid wasting resources. Please update the task page with clearer instructions and resume it when ready.`,
        isOracleAdmin: true,
      });
      await this.tasksService.updateTask({
        taskId,
        mainRoomId,
        updates: { status: 'paused' },
      });
      this.logger.warn(
        `Task ${taskId} auto-paused after ${newRejectionCount} consecutive rejections`,
      );
      return;
    }

    // 4. Notify user that the agent is re-running
    const reasonText = rejectionReason ? `\nReason: ${rejectionReason}` : '';
    await mxManager.sendMessage({
      roomId,
      message: `Result rejected.${reasonText}\nRe-running the task with your feedback… (attempt ${newRejectionCount + 1})`,
      isOracleAdmin: true,
    });

    // 5. Post approval event update
    const approvalContent: ApprovalRequestEventContent = {
      taskId,
      status: 'rejected',
      preview: '',
      requestedAt: '',
      resolvedAt: new Date().toISOString(),
      ...(rejectionReason && { rejectionReason }),
    };
    await mxManager.sendMatrixEvent(
      roomId,
      APPROVAL_REQUEST_EVENT_TYPE,
      approvalContent,
    );

    // 6. Schedule immediate retry flow (work → deliver) so the agent re-runs
    const taskTitle = title ?? meta.taskType;
    const { workJobId } = await this.scheduler.scheduleRetryFlow({
      taskId,
      workData: {
        taskId,
        userDid: meta.userDid,
        roomId,
        title: taskTitle,
        taskType: meta.taskType,
        scheduleCron: meta.scheduleCron ?? undefined,
      },
      deliverData: {
        taskId,
        userDid: meta.userDid,
        matrixUserId: meta.matrixUserId,
        roomId,
        title: taskTitle,
        taskType: meta.taskType,
        scheduleCron: meta.scheduleCron ?? undefined,
      },
    });

    // Store the retry work job ID so the deliver processor can find the result
    await this.tasksService.updateTask({
      taskId,
      mainRoomId,
      updates: { currentWorkJobId: workJobId },
    });

    this.logger.log(
      `Result rejected for task ${taskId}${rejectionReason ? ` — reason: ${rejectionReason}` : ''}, scheduled retry (workJobId=${workJobId})`,
    );
  }

  /**
   * Handle approval timeout — send reminder or auto-discard.
   * Called by the ApprovalProcessor.
   */
  async handleApprovalTimeout(params: {
    taskId: string;
    mainRoomId: string;
    roomId: string;
    phase: 'reminder' | 'expiry';
  }): Promise<void> {
    const { taskId, mainRoomId, roomId, phase } = params;
    const meta = await this.tasksService.getTask(
      { taskId, mainRoomId },
      { bypassCache: true },
    );

    if (!meta.pendingApprovalEventId) {
      this.logger.debug(
        `Task ${taskId} no longer has pending approval (${phase}), skipping`,
      );
      return;
    }

    const mxManager = MatrixManager.getInstance();

    if (phase === 'reminder') {
      await mxManager.sendMessage({
        roomId,
        message:
          'Reminder: A task result is still waiting for your review. Reply with **yes** to deliver, or **no** to discard.',
        isOracleAdmin: true,
      });
      this.logger.log(`Sent approval reminder for task ${taskId}`);
    } else {
      // Expiry — auto-discard
      const client = await this.approvalQueue.client;
      const redisKey = `${APPROVAL_RESULT_PREFIX}${taskId}`;
      await client.del(redisKey);

      await mxManager.sendMessage({
        roomId,
        message:
          'The pending task result has expired after 48 hours without a response and has been discarded. The next scheduled run will produce a new result.',
        isOracleAdmin: true,
      });

      const approvalContent: ApprovalRequestEventContent = {
        taskId,
        status: 'expired',
        preview: '',
        requestedAt: '',
        resolvedAt: new Date().toISOString(),
      };
      await mxManager.sendMatrixEvent(
        roomId,
        APPROVAL_REQUEST_EVENT_TYPE,
        approvalContent,
      );

      await this.clearApprovalState(taskId, mainRoomId);
      this.logger.log(`Approval expired for task ${taskId}, result discarded`);
    }
  }

  /**
   * Clear the approval state from TaskMeta and cancel timeout jobs.
   * Also removes cached work result from Redis.
   *
   * Called when:
   * - User approves/rejects a result
   * - Approval times out
   * - Task is cancelled/paused while approval is pending
   */
  async clearApprovalState(taskId: string, mainRoomId: string): Promise<void> {
    // Remove cached work result and room lookup keys from Redis
    const client = await this.approvalQueue.client;
    const redisKey = `${APPROVAL_RESULT_PREFIX}${taskId}`;
    const roomRefKey = `${APPROVAL_ROOMREF_PREFIX}${taskId}`;
    const roomId = await client.get(roomRefKey).catch(() => null);
    await Promise.all([
      client.del(redisKey).catch(() => {}),
      client.del(roomRefKey).catch(() => {}),
      roomId
        ? client.del(`${APPROVAL_ROOM_PREFIX}${roomId}`).catch(() => {})
        : Promise.resolve(),
    ]);

    await this.tasksService.updateTask({
      taskId,
      mainRoomId,
      updates: { pendingApprovalEventId: null },
    });
    await this.scheduler.cancelApprovalTimeouts(taskId);
  }
}
