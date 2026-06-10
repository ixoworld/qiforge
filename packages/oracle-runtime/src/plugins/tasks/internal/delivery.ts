import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MatrixManager } from '@ixo/matrix';
import { getMatrixHomeServerCroppedForDid } from '@ixo/oracles-chain-client';
import { CronExpressionParser } from 'cron-parser';
import { renderSpec, type TaskSpec, type Trigger } from './spec.js';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Should this task get its own `[Task]` Matrix room? Pure heuristic, applied
 * once at create time. `'auto'`: sub-day cron frequency or "ongoing" intents.
 */
export function shouldCreateDedicatedRoom(args: {
  trigger: Trigger;
  intentBody: string;
  explicit: 'auto' | 'yes' | 'no';
}): boolean {
  if (args.explicit !== 'auto') return args.explicit === 'yes';
  if (args.trigger.type === 'time.cron') {
    const interval = cronIntervalMs(args.trigger.pattern, args.trigger.tz);
    if (interval !== null && interval < DAY_MS) return true;
  }
  if (args.intentBody.length > 800) return true;
  return /\b(monitor|ongoing|watch|track)\b/i.test(args.intentBody);
}

function cronIntervalMs(pattern: string, tz: string): number | null {
  try {
    const it = CronExpressionParser.parse(pattern, { tz });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    return b - a;
  } catch {
    return null;
  }
}

/**
 * Everything that touches a Matrix room: result delivery, approval prompts,
 * dedicated-room creation, and main-room resolution. Uses the
 * `MatrixManager` singleton — the only client that can act as the bot from
 * a background worker.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * The concrete room a task delivers to. `'main'` resolves to the user's
   * main oracle room; returns null when that resolution fails.
   */
  async resolveRoom(spec: TaskSpec): Promise<string | null> {
    if (spec.frontmatter.delivery.roomId !== 'main') {
      return spec.frontmatter.delivery.roomId;
    }
    try {
      const owner = spec.frontmatter.owner;
      const { roomId } =
        await MatrixManager.getInstance().getOracleRoomIdWithHomeServer({
          userDid: owner,
          oracleEntityDid: this.config.getOrThrow<string>('ORACLE_ENTITY_DID'),
          userHomeServer: await getMatrixHomeServerCroppedForDid(owner),
        });
      return roomId ?? null;
    } catch (err) {
      this.logger.warn(
        `Main-room resolution failed for ${spec.frontmatter.owner}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Create the `[Task] <title>` room, invite the user, and post the spec as
   * the opening message. Returns null on failure — callers fall back to the
   * main room.
   */
  async createDedicatedRoom(
    spec: TaskSpec,
    userMatrixId: string,
  ): Promise<string | null> {
    try {
      const client = MatrixManager.getInstance().getClient();
      if (!client) return null;
      // matrix-bot-sdk: createRoom resolves to the new room id string.
      const roomId = await client.mxClient.createRoom({
        name: `[Task] ${spec.frontmatter.title}`,
        topic: `Scheduled task: ${spec.frontmatter.title}`,
        visibility: 'private',
        preset: 'private_chat',
        invite: [userMatrixId],
      });
      if (!roomId) return null;
      await this.post(roomId, `📋 **Task created**\n\n${renderSpec(spec)}`);
      return roomId;
    } catch (err) {
      this.logger.warn(
        `Dedicated-room creation failed for "${spec.frontmatter.title}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  async post(roomId: string, message: string): Promise<void> {
    try {
      await MatrixManager.getInstance().sendMessage({
        roomId,
        message,
        isOracleAdmin: true,
      });
    } catch (err) {
      this.logger.error(`Post to ${roomId} failed: ${(err as Error).message}`);
    }
  }
}
