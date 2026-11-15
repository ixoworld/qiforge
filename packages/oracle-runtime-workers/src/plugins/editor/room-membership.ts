/**
 * Cached Matrix room-membership guard, Workers edition.
 *
 * The editor and flows plugins act on a room with the oracle's privileged
 * admin identity, where the *room id comes from the request*. Left unchecked,
 * a user could pass another user's room id and have the oracle read or edit a
 * page they don't own. Before any such read/write we assert the requesting
 * user is actually a joined member of the room.
 *
 * On Workers, membership is resolved through the gateway Durable Object via
 * `ctx.matrix.getRoomState(roomId)` — the full state array carries every
 * `m.room.member` event — and cached per room for a short TTL so repeated
 * tool calls in one turn don't pay the gateway round-trip each time.
 */
import type { RuntimeContext } from '../../plugin-api/types';

interface MembershipEntry {
  members: Set<string>;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const cache = new Map<string, MembershipEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined | null {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return undefined;
  return isRecord(descriptor.value) ? descriptor.value : null;
}

function optionalPowerLevel(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return fallback;
  const value = descriptor.value;
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

/**
 * Whether a joined user may send a non-state event of `eventType` according
 * to a current room-state snapshot. Missing power-level state uses Matrix's
 * default of level zero for both users and events; malformed or duplicate
 * authority state fails closed.
 */
export function canUserSendEventInState(
  state: ReadonlyArray<unknown>,
  matrixUserId: string,
  eventType: string,
): boolean {
  let joined = false;
  let membershipSeen = false;
  let powerLevels: Record<string, unknown> | undefined;
  let powerLevelsSeen = false;

  for (const event of state) {
    if (!isRecord(event)) continue;

    if (
      event.type === 'm.room.member' &&
      event.state_key === matrixUserId
    ) {
      if (membershipSeen) return false;
      membershipSeen = true;
      const content = event.content;
      joined = isRecord(content) && content.membership === 'join';
    }

    if (
      event.type === 'm.room.power_levels' &&
      event.state_key === ''
    ) {
      if (powerLevelsSeen) return false;
      powerLevelsSeen = true;
      if (!isRecord(event.content)) return false;
      powerLevels = event.content;
    }
  }

  if (!joined) return false;
  if (!powerLevels) return true;

  const usersDefault = optionalPowerLevel(powerLevels, 'users_default', 0);
  const eventsDefault = optionalPowerLevel(powerLevels, 'events_default', 0);
  const users = optionalRecord(powerLevels, 'users');
  const events = optionalRecord(powerLevels, 'events');
  if (
    usersDefault === undefined ||
    eventsDefault === undefined ||
    users === null ||
    events === null
  ) {
    return false;
  }

  const userLevel = users
    ? optionalPowerLevel(users, matrixUserId, usersDefault)
    : usersDefault;
  const required = events
    ? optionalPowerLevel(events, eventType, eventsDefault)
    : eventsDefault;
  return userLevel !== undefined && required !== undefined
    ? userLevel >= required
    : false;
}

/**
 * Read current room authority and fail closed unless the requester is joined
 * and may send `eventType` directly. This deliberately bypasses the membership
 * cache so every requested mutation observes one current authority snapshot.
 */
export async function canUserSendRoomEvent(
  ctx: Pick<RuntimeContext, 'matrix'>,
  roomId: string,
  matrixUserId: string | undefined,
  eventType: string,
): Promise<boolean> {
  if (!roomId || !matrixUserId || !eventType) return false;
  try {
    const snapshot = await ctx.matrix.getRoomState(roomId);
    return canUserSendEventInState(snapshot.state, matrixUserId, eventType);
  } catch {
    return false;
  }
}

/** Joined member ids from a room-state snapshot's event array. */
function joinedMembers(state: ReadonlyArray<unknown>): Set<string> {
  const members = new Set<string>();
  for (const event of state) {
    if (!isRecord(event)) continue;
    if (event.type !== 'm.room.member') continue;
    const stateKey = event.state_key;
    if (typeof stateKey !== 'string' || stateKey.length === 0) continue;
    const content = event.content;
    if (isRecord(content) && content.membership === 'join') {
      members.add(stateKey);
    }
  }
  return members;
}

function sweepExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

async function getRoomMembers(
  ctx: Pick<RuntimeContext, 'matrix'>,
  roomId: string,
  ttlMs: number,
): Promise<Set<string>> {
  const cached = cache.get(roomId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.members;
  }
  const snapshot = await ctx.matrix.getRoomState(roomId);
  const members = joinedMembers(snapshot.state);
  sweepExpiredEntries();
  cache.set(roomId, { members, expiresAt: Date.now() + ttlMs });
  return members;
}

/**
 * True when `matrixUserId` is a joined member of `roomId`. Fails closed:
 * returns `false` on a missing id or any lookup error, so a Matrix outage
 * denies access rather than silently granting it.
 */
export async function isUserInRoom(
  ctx: Pick<RuntimeContext, 'matrix'>,
  roomId: string,
  matrixUserId: string | undefined,
  opts: { ttlMs?: number } = {},
): Promise<boolean> {
  if (!roomId || !matrixUserId) return false;
  try {
    const members = await getRoomMembers(
      ctx,
      roomId,
      opts.ttlMs ?? DEFAULT_TTL_MS,
    );
    return members.has(matrixUserId);
  } catch {
    return false;
  }
}

/** Drop a room's cached membership (e.g. after a known membership change). */
export function invalidateRoomMembership(roomId: string): void {
  cache.delete(roomId);
}
