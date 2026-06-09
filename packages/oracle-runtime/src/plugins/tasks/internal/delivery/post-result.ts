import { Injectable, Logger } from '@nestjs/common';
import { MatrixManager } from '@ixo/matrix';
import type { TaskSpec } from '../domain/spec.js';

/**
 * Posts task-related messages into Matrix rooms. Uses `MatrixManager` directly
 * (the same singleton other plugins reach for off-request) — it's the only
 * client capable of acting as the bot from a background worker.
 */
@Injectable()
export class PostResultService {
  private readonly logger = new Logger(PostResultService.name);

  async postRunResult(roomId: string, output: string): Promise<void> {
    await this.send(roomId, output);
  }

  async postSpecPosted(roomId: string, spec: TaskSpec): Promise<void> {
    const lines = [
      `📋 **Task created: ${spec.frontmatter.title}**`,
      '',
      '```yaml',
      `id: ${spec.frontmatter.id}`,
      `trigger: ${spec.frontmatter.trigger.type}`,
      `approval: ${spec.frontmatter.approval}`,
      '```',
      '',
      spec.body,
    ];
    await this.send(roomId, lines.join('\n'));
  }

  async postApprovalRequest(
    roomId: string,
    taskId: string,
    preview: string,
  ): Promise<void> {
    const lines = [
      `✋ **Approval needed** — task \`${taskId}\``,
      '',
      preview,
      '',
      'Reply **yes** to deliver this result, or **no** to discard.',
    ];
    await this.send(roomId, lines.join('\n'));
  }

  async postApprovalReminder(roomId: string, taskId: string): Promise<void> {
    await this.send(
      roomId,
      `🔔 Reminder — task \`${taskId}\` is still waiting on your approval. Reply yes / no.`,
    );
  }

  async postApprovalExpired(roomId: string): Promise<void> {
    await this.send(
      roomId,
      `⌛ Approval window expired. The pending result was discarded; the task is paused for review.`,
    );
  }

  async postRejection(roomId: string, reason?: string): Promise<void> {
    const suffix = reason ? `: ${reason}` : '';
    await this.send(roomId, `❌ Result rejected${suffix}.`);
  }

  async postFailedPendingReview(roomId: string, taskId: string): Promise<void> {
    await this.send(
      roomId,
      `🛑 Task \`${taskId}\` failed too many times in a row and is paused for review. Ask me to **suggest a fix** when you're ready.`,
    );
  }

  private async send(roomId: string, body: string): Promise<void> {
    try {
      const matrix = MatrixManager.getInstance();
      await matrix.sendMessage({ roomId, message: body, isOracleAdmin: true });
    } catch (err) {
      this.logger.error(
        `Failed to post message to room ${roomId}: ${(err as Error).message}`,
      );
    }
  }
}
