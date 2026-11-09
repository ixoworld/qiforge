import { z } from 'zod';
import type { UserKvSurface } from '../../plugin-api/types';
import { CREDENTIALS_KV_NAMESPACE } from './check-store';
import { GrantSchema, type PermissionGrant } from './hub-client';
import { LINK_STATUSES, type LinkState } from './self-client';

/**
 * What the plugin remembers about one person in their own kv (namespace
 * `credentials`, next to the check rows of `check-store.ts`):
 *
 * - `permissions`: the ids of the permission cards THIS person was asked
 *   (`credentials_permission_status` reads no other id).
 * - `grants:<action>`: the grants of an allowed action card, kept until the
 *   earliest of them ends, so a repeat call does not ask the Hub again.
 * - `link:<linkId>`: the last status read for a link, and `linkrate:<linkId>`
 *   how often the status tool was called for it this minute.
 */

const PERMISSIONS_KEY = 'permissions';
const MAX_PERMISSIONS = 32;
const PERMISSION_IDLE_TTL_MS = 32 * 24 * 3600 * 1000;

const Ids = z.array(z.string());

/** Remember a permission card's id as this person's (oldest dropped first). */
export async function recordPermission(
  kv: UserKvSurface,
  id: string,
): Promise<void> {
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    PERMISSIONS_KEY,
    (current) => {
      const parsed = Ids.safeParse(current);
      const ids = (parsed.success ? parsed.data : []).filter((x) => x !== id);
      ids.push(id);
      return ids.slice(-MAX_PERMISSIONS);
    },
    { idleTtlMs: PERMISSION_IDLE_TTL_MS },
  );
}

/** Whether this person's kv records `id` as one of their permission cards. */
export async function knowsPermission(
  kv: UserKvSurface,
  id: string,
): Promise<boolean> {
  const parsed = Ids.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, PERMISSIONS_KEY),
  );
  return parsed.success && parsed.data.includes(id);
}

// ---------------------------------------------------------------------------
// Allowed grants.

const grantsKey = (action: string) => `grants:${action}`;

const GrantsCache = z.object({
  permissionId: z.string(),
  /** Unix seconds: the earliest `expiresAt` of the grants. */
  until: z.number(),
  grants: z.array(GrantSchema).min(1).max(16),
});

/** The cached grants of `action`'s card, or null when absent, ended or another card's. */
export async function readGrantsCache(
  kv: UserKvSurface,
  action: string,
  permissionId: string,
  nowSeconds: number,
): Promise<PermissionGrant[] | null> {
  const parsed = GrantsCache.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, grantsKey(action)),
  );
  return parsed.success &&
    parsed.data.permissionId === permissionId &&
    parsed.data.until > nowSeconds
    ? parsed.data.grants
    : null;
}

/** Keep `grants` until the earliest of them ends. */
export async function writeGrantsCache(
  kv: UserKvSurface,
  action: string,
  permissionId: string,
  grants: PermissionGrant[],
  nowMs: number,
): Promise<void> {
  if (grants.length === 0) return;
  const until = Math.min(...grants.map((g) => g.expiresAt));
  await kv.set(
    CREDENTIALS_KV_NAMESPACE,
    grantsKey(action),
    { permissionId, until, grants },
    { idleTtlMs: Math.max(1_000, until * 1000 - nowMs) },
  );
}

export async function clearGrantsCache(
  kv: UserKvSurface,
  action: string,
): Promise<void> {
  await kv.delete(CREDENTIALS_KV_NAMESPACE, grantsKey(action));
}

// ---------------------------------------------------------------------------
// Link status.

/** How long a link's status is kept before Self is asked again. */
export const LINK_STATUS_KEEP_MS = 5_000;
/** The most status reads for one link per minute. */
export const LINK_STATUS_CALLS_PER_MINUTE = 6;
const TERMINAL: ReadonlySet<string> = new Set([
  'passed',
  'failed',
  'expired',
  'cancelled',
]);

const linkKey = (linkId: string) => `link:${linkId}`;
const linkRateKey = (linkId: string) => `linkrate:${linkId}`;

const CachedLink = z.object({
  at: z.number(),
  state: z.object({
    linkId: z.string(),
    status: z.enum(LINK_STATUSES),
    updatedAt: z.number(),
    expiresAt: z.number(),
  }),
});

/**
 * The status read last, when it is still good: under 5 s old, or final (a
 * link that ended never changes again).
 */
export async function readLinkCache(
  kv: UserKvSurface,
  linkId: string,
  nowMs: number,
): Promise<LinkState | null> {
  const parsed = CachedLink.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, linkKey(linkId)),
  );
  if (!parsed.success) return null;
  const { at, state } = parsed.data;
  return TERMINAL.has(state.status) || nowMs - at < LINK_STATUS_KEEP_MS
    ? state
    : null;
}

export async function writeLinkCache(
  kv: UserKvSurface,
  state: LinkState,
  nowMs: number,
): Promise<void> {
  await kv.set(
    CREDENTIALS_KV_NAMESPACE,
    linkKey(state.linkId),
    { at: nowMs, state },
    { idleTtlMs: 3600 * 1000 },
  );
}

const Rate = z.object({ start: z.number(), count: z.number() });

/** Count one status call for `linkId`; false when it is past the minute's cap. */
export async function chargeLinkStatus(
  kv: UserKvSurface,
  linkId: string,
  nowMs: number,
): Promise<boolean> {
  const next = await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    linkRateKey(linkId),
    (current) => {
      const parsed = Rate.safeParse(current);
      return parsed.success && nowMs - parsed.data.start < 60_000
        ? { start: parsed.data.start, count: parsed.data.count + 1 }
        : { start: nowMs, count: 1 };
    },
    { idleTtlMs: 120_000 },
  );
  const parsed = Rate.safeParse(next);
  return !parsed.success || parsed.data.count <= LINK_STATUS_CALLS_PER_MINUTE;
}
