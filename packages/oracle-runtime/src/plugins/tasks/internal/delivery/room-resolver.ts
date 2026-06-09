import { Injectable } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import type { TaskSpec } from '../domain/spec.js';
import type { Trigger } from '../domain/trigger.js';

@Injectable()
export class RoomResolver {
  /**
   * Decide whether a task should get its own Matrix room. Called at create
   * time, then the resolution is baked into `spec.delivery.roomId`.
   */
  shouldCreateDedicatedRoom(args: {
    trigger: Trigger;
    intentBody: string;
    explicit: 'auto' | 'yes' | 'no';
  }): boolean {
    if (args.explicit === 'yes') return true;
    if (args.explicit === 'no') return false;

    // auto — apply heuristic
    if (args.trigger.type === 'time.cron') {
      const intervalMs = approxCronIntervalMs(
        args.trigger.pattern,
        args.trigger.tz,
      );
      // Sub-day frequency → dedicated room.
      if (intervalMs !== null && intervalMs < 24 * 3600 * 1000) return true;
    }
    // Long / "monitor" / "ongoing" intents
    if (args.intentBody.length > 800) return true;
    const lower = args.intentBody.toLowerCase();
    if (
      /(monitor|ongoing|watch|track|every (hour|few hours|minutes))/.test(lower)
    )
      return true;
    return false;
  }

  /**
   * Resolve the actual Matrix room ID a delivery should land in. Returns
   * null when the spec says "main" and we don't know the user's main room
   * yet (caller falls back to no-op or a follow-up).
   */
  resolveDeliveryRoom(
    spec: TaskSpec,
    mainRoomId: string | null,
  ): string | null {
    if (spec.frontmatter.delivery.roomId !== 'main') {
      return spec.frontmatter.delivery.roomId;
    }
    return mainRoomId;
  }
}

/**
 * Approximate the interval between consecutive cron firings, in ms.
 * Returns null if we can't parse the pattern.
 */
function approxCronIntervalMs(pattern: string, tz: string): number | null {
  try {
    const it = CronExpressionParser.parse(pattern, {
      tz,
      currentDate: new Date(),
    });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    return b - a;
  } catch {
    return null;
  }
}
