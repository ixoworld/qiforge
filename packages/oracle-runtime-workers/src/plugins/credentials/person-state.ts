import { z } from 'zod';
import type { UserKvSurface } from '../../plugin-api/types';
import { CREDENTIALS_KV_NAMESPACE } from './check-store';
import {
  GrantSchema,
  StatusAnswer,
  type PermissionGrant,
  type PermissionState,
} from './hub-client';
import { LINK_STATUSES, type LinkState } from './self-client';

/**
 * What the plugin remembers about one person in their own kv (namespace
 * `credentials`, next to the check rows of `check-store.ts`):
 *
 * - `permissions`: the permission cards THIS person was asked, each once
 *   with the kinds of its items and its link (`credentials_permission_status`
 *   reads no other id, except one the Hub lists for this person).
 *
 * All of it is a cache: the Hub is the source of truth, and what is missing
 * here is read back from the Hub's list of the person's live cards.
 * - `grants:<action>`: the grants of an allowed action card, kept until the
 *   earliest of them ends, so a repeat call does not ask the Hub again.
 * - `link:<linkId>`: the last status read for a link, and `linkrate:<linkId>`
 *   how often the status tool was called for it this minute.
 */

const PERMISSIONS_KEY = 'permissions';
const MAX_PERMISSIONS = 32;
const PERMISSION_IDLE_TTL_MS = 32 * 24 * 3600 * 1000;

const ItemKinds = z.array(z.enum(['credential-check', 'service-action']));
/** One card: its id once, with the kinds of its items (older rows: the id alone). */
const Entry = z.union([
  z.string().transform((id) => ({
    id,
    kinds: [] as string[],
    url: undefined as string | undefined,
  })),
  z.object({
    id: z.string(),
    kinds: ItemKinds,
    /** The card's link, kept so a card still waiting can be sent again. */
    url: z.string().url().optional().catch(undefined),
  }),
]);
const Entries = z.array(Entry);

/**
 * Remember a permission card's id as this person's, once, with the kinds of
 * its items (oldest dropped first).
 */
export async function recordPermission(
  kv: UserKvSurface,
  id: string,
  kinds: readonly ('credential-check' | 'service-action')[] = [],
  url?: string,
): Promise<void> {
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    PERMISSIONS_KEY,
    (current) => {
      const parsed = Entries.safeParse(current);
      const all = parsed.success ? parsed.data : [];
      // A link recorded before stays when the card is recorded again without one.
      const link = url ?? all.find((x) => x.id === id)?.url;
      const entries = all.filter((x) => x.id !== id);
      entries.push({ id, kinds: [...kinds], ...(link ? { url: link } : {}) });
      return entries.slice(-MAX_PERMISSIONS);
    },
    { idleTtlMs: PERMISSION_IDLE_TTL_MS },
  );
}

/** Whether this person's kv records `id` as one of their permission cards. */
export async function knowsPermission(
  kv: UserKvSurface,
  id: string,
): Promise<boolean> {
  const parsed = Entries.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, PERMISSIONS_KEY),
  );
  return parsed.success && parsed.data.some((x) => x.id === id);
}

/** The link this person's kv kept for card `id`, when it kept one. */
export async function permissionUrl(
  kv: UserKvSurface,
  id: string,
): Promise<string | null> {
  const parsed = Entries.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, PERMISSIONS_KEY),
  );
  if (!parsed.success) return null;
  return parsed.data.find((x) => x.id === id)?.url ?? null;
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

/** Drop the cached grants of `action` when they came from card `permissionId`. */
export async function clearGrantsCacheOf(
  kv: UserKvSurface,
  action: string,
  permissionId: string,
): Promise<void> {
  const parsed = GrantsCache.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, grantsKey(action)),
  );
  if (parsed.success && parsed.data.permissionId === permissionId)
    await clearGrantsCache(kv, action);
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

// ---------------------------------------------------------------------------
// Card status.

/** How long a pending or allowed card's status is kept before the Hub is asked again. */
export const PERMISSION_STATUS_KEEP_MS = 5_000;
/** The most status reads for one card per minute. */
export const PERMISSION_STATUS_CALLS_PER_MINUTE = 6;
// `stopping` (stopped elsewhere, revocation not yet confirmed) and `unknown`
// are deliberately not final: like `pending` they are kept 5 s, so a card
// flips to `stopped` on the next read.
const ENDED_CARD: ReadonlySet<string> = new Set([
  'declined',
  'expired',
  'stopped',
]);

const permStatusKey = (id: string) => `permstatus:${id}`;
const permRateKey = (id: string) => `permrate:${id}`;

const CachedCard = z.object({ at: z.number(), state: StatusAnswer });

/**
 * The card status read last, when it is still good: under 5 s old, or
 * final (a declined, expired or stopped card never changes again).
 */
export async function readPermissionCache(
  kv: UserKvSurface,
  id: string,
  nowMs: number,
): Promise<PermissionState | null> {
  const parsed = CachedCard.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, permStatusKey(id)),
  );
  if (!parsed.success) return null;
  const { at, state } = parsed.data;
  return ENDED_CARD.has(state.status) || nowMs - at < PERMISSION_STATUS_KEEP_MS
    ? state
    : null;
}

export async function writePermissionCache(
  kv: UserKvSurface,
  state: PermissionState,
  nowMs: number,
): Promise<void> {
  await kv.set(
    CREDENTIALS_KV_NAMESPACE,
    permStatusKey(state.id),
    { at: nowMs, state },
    { idleTtlMs: 3600 * 1000 },
  );
}

/**
 * Count one read of the person's card list at the Hub; false when it is past
 * the minute's cap (the same as one card's status reads). The key can never
 * be a card's: an id holds no `*`.
 */
export function chargePermissionList(
  kv: UserKvSurface,
  nowMs: number,
): Promise<boolean> {
  return chargePermissionStatus(kv, '*list', nowMs);
}

/** Count one status call for card `id`; false when it is past the minute's cap. */
export async function chargePermissionStatus(
  kv: UserKvSurface,
  id: string,
  nowMs: number,
): Promise<boolean> {
  const next = await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    permRateKey(id),
    (current) => {
      const parsed = Rate.safeParse(current);
      return parsed.success && nowMs - parsed.data.start < 60_000
        ? { start: parsed.data.start, count: parsed.data.count + 1 }
        : { start: nowMs, count: 1 };
    },
    { idleTtlMs: 120_000 },
  );
  const parsed = Rate.safeParse(next);
  return (
    !parsed.success || parsed.data.count <= PERMISSION_STATUS_CALLS_PER_MINUTE
  );
}

// ---------------------------------------------------------------------------
// The card waiting for an answer, per action.

const pendingKey = (action: string) => `pending:${action}`;
const Pending = z.object({ permissionId: z.string() });

/**
 * The newest card asked for `action`, kept apart from the one in use
 * (`action:<id>`) until it is allowed: a declined second card must not
 * remove grants that still work.
 */
export async function writePendingAction(
  kv: UserKvSurface,
  action: string,
  permissionId: string,
  ttlMs: number,
): Promise<void> {
  await kv.set(
    CREDENTIALS_KV_NAMESPACE,
    pendingKey(action),
    { permissionId },
    { idleTtlMs: ttlMs },
  );
}

export async function readPendingAction(
  kv: UserKvSurface,
  action: string,
): Promise<string | null> {
  const parsed = Pending.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, pendingKey(action)),
  );
  return parsed.success ? parsed.data.permissionId : null;
}

export async function clearPendingAction(
  kv: UserKvSurface,
  action: string,
): Promise<void> {
  await kv.delete(CREDENTIALS_KV_NAMESPACE, pendingKey(action));
}
