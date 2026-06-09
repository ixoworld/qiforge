import { Injectable, Logger } from '@nestjs/common';
import { MatrixManager } from '@ixo/matrix';
import { PostResultService } from './post-result.js';
import type { TaskSpec } from '../domain/spec.js';

@Injectable()
export class DedicatedRoomService {
  private readonly logger = new Logger(DedicatedRoomService.name);

  constructor(private readonly post: PostResultService) {}

  /**
   * Create a `[Task] <title>` room, invite the user, post the spec as the
   * opening message, and return the roomId. Returns null on failure — the
   * caller falls back to delivering in the user's main room.
   */
  async createForTask(args: {
    title: string;
    userMatrixId: string;
    spec: TaskSpec;
  }): Promise<string | null> {
    try {
      const sm = MatrixManager.getInstance().getClient();
      if (!sm) {
        this.logger.warn(
          'No matrix client available — skipping dedicated room',
        );
        return null;
      }
      const response = await sm.mxClient.createRoom({
        name: `[Task] ${args.title}`,
        topic: `Scheduled task: ${args.title}`,
        visibility: 'private',
        preset: 'private_chat',
        invite: [args.userMatrixId],
      });
      const roomId = (response as { room_id?: string }).room_id;
      if (!roomId) return null;
      await this.post.postSpecPosted(roomId, args.spec);
      return roomId;
    } catch (err) {
      this.logger.warn(
        `Failed to create dedicated room for "${args.title}": ${(err as Error).message}`,
      );
      return null;
    }
  }
}
