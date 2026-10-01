import { MatrixManager } from '@ixo/matrix';
import { sweepExpired } from '../../utils/expiring-map.js';
import type { RoomTypeInfo } from './guard.js';

interface CacheEntry {
  info: RoomTypeInfo & { joinedMemberIds: string[] };
  expiresAt: number;
}

/**
 * Tiny TTL cache around `MatrixManager.getRoomInfo`. Reused by the
 * group-chat middleware and the request-time tool builder so we don't pay
 * a Matrix round-trip on every turn.
 */
export class RoomInfoCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  async get(roomId: string): Promise<CacheEntry['info']> {
    const cached = this.entries.get(roomId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.info;
    }
    const fresh = await MatrixManager.getInstance().getRoomInfo(roomId);
    const info: CacheEntry['info'] = {
      isDirect: fresh.isDirect,
      memberCount: fresh.memberCount,
      joinedMemberIds: fresh.joinedMemberIds,
    };
    sweepExpired(this.entries);
    this.entries.set(roomId, { info, expiresAt: Date.now() + this.ttlMs });
    return info;
  }

  /** Drop a single room (e.g. on member event). */
  invalidate(roomId: string): void {
    this.entries.delete(roomId);
  }

  clear(): void {
    this.entries.clear();
  }
}
