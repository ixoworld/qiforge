import { MatrixManager } from '@ixo/matrix';

/**
 * Cached Matrix room-membership guard.
 *
 * Several plugins (the editor most notably) act on a room with the oracle's
 * privileged admin identity, where the *room id comes from the request*. Left
 * unchecked, a user could pass another user's room id and have the oracle read
 * or edit a page they don't own. Before any such read/write we assert the
 * requesting user is actually a joined member of the room.
 *
 * Membership is resolved via `MatrixManager.getRoomInfo` (a `/joined_members`
 * round-trip) and cached per room for a short TTL so we don't pay that
 * round-trip on every turn.
 */

interface MembershipEntry {
  members: Set<string>;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const cache = new Map<string, MembershipEntry>();

async function getRoomMembers(
  roomId: string,
  ttlMs: number,
): Promise<Set<string>> {
  const cached = cache.get(roomId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.members;
  }
  const info = await MatrixManager.getInstance().getRoomInfo(roomId);
  const members = new Set(info.joinedMemberIds);
  cache.set(roomId, { members, expiresAt: Date.now() + ttlMs });
  return members;
}

/**
 * True when `matrixUserId` is a joined member of `roomId`. Fails closed:
 * returns `false` on a missing id or any lookup error, so a Matrix outage
 * denies access rather than silently granting it.
 */
export async function isUserInRoom(
  roomId: string,
  matrixUserId: string | undefined,
  opts: { ttlMs?: number } = {},
): Promise<boolean> {
  if (!roomId || !matrixUserId) return false;
  try {
    const members = await getRoomMembers(roomId, opts.ttlMs ?? DEFAULT_TTL_MS);
    return members.has(matrixUserId);
  } catch {
    return false;
  }
}

/** Drop a room's cached membership (e.g. after a known membership change). */
export function invalidateRoomMembership(roomId: string): void {
  cache.delete(roomId);
}
