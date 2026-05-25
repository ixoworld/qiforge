import { MatrixManager } from '@ixo/matrix';
import { Logger } from '@nestjs/common';

const logger = new Logger('GroupChatPowerLevels');

interface PowerLevelsContent {
  users?: Record<string, number>;
  users_default?: number;
  events?: Record<string, number>;
  events_default?: number;
}

export interface BotPowerLevel {
  /** Bot's effective power level in this room. */
  pl: number;
  /** Power level required to send `m.room.message` events. */
  sendThreshold: number;
  /** True when bot has at least `max(sendThreshold, requiredMin)` PL. */
  allowed: (requiredMin?: number) => boolean;
}

/**
 * Read `m.room.power_levels` for the room and resolve whether the bot has
 * permission to send `m.room.message` events. Missing power-levels event
 * is treated as "everyone allowed" — that's the Matrix default.
 */
export async function getBotPowerLevel(
  roomId: string,
  botUserId: string,
): Promise<BotPowerLevel> {
  let content: PowerLevelsContent | null = null;
  try {
    const client = MatrixManager.getInstance().getClient();
    if (!client) {
      throw new Error('Matrix client not initialised');
    }
    const event = await client.mxClient.getRoomStateEvent(
      roomId,
      'm.room.power_levels',
      '',
    );
    if (event && typeof event === 'object') {
      content = event as PowerLevelsContent;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/M_NOT_FOUND|not found/i.test(message)) {
      logger.warn(`Failed to read power_levels for ${roomId}: ${message}`);
    }
  }

  const usersDefault = content?.users_default ?? 0;
  const eventsDefault = content?.events_default ?? 0;
  const pl = content?.users?.[botUserId] ?? usersDefault;
  const sendThreshold = content?.events?.['m.room.message'] ?? eventsDefault;

  return {
    pl,
    sendThreshold,
    allowed: (requiredMin = 0) => pl >= Math.max(sendThreshold, requiredMin),
  };
}
