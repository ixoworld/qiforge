import { z } from 'zod';
import type { UserKvSurface } from '../../plugin-api/types';
import { CREDENTIALS_KV_NAMESPACE } from './check-store';
import {
  GrantSchema,
  StatusAnswer,
  type PermissionGrant,
  type PermissionRequest,
  type PermissionState,
} from './hub-client';
import { LINK_STATUSES, type LinkState } from './self-client';

/**
 * What the plugin remembers about one person in their own kv (namespace
 * `credentials`, next to the check rows of `check-store.ts`):
 *
 * - `permissions`: the permission cards THIS person was asked, each once
 *   with the kinds of its items, its link, what it asked (action ids and
 *   credential types, plus another plugin's fixed next step) and the final
 *   answer a tool or a permission event already gave
 *   (`credentials_permission_status` reads no other id, except one the Hub
 *   lists for this person; a permission event for any other id is ignored).
 *
 * All of it is a cache: the Hub is the source of truth, and what is missing
 * here is read back from the Hub's list of the person's live cards.
 * - `grants:<action>`: the grants of an allowed action card, kept until the
 *   earliest of them ends: used only when the Hub's list cannot be read (the
 *   Hub's answer is otherwise read before any grant is used).
 * - `link:<linkId>`: the last status read for a link, and `linkrate:<linkId>`
 *   how often the status tool was called for it this minute.
 */

const PERMISSIONS_KEY = 'permissions';
const MAX_PERMISSIONS = 32;
const PERMISSION_IDLE_TTL_MS = 32 * 24 * 3600 * 1000;

const ItemKinds = z.array(z.enum(['credential-check', 'service-action']));
/** A card's final answer as the Hub names it. */
const ANSWERS = ['allowed', 'declined', 'expired'] as const;
export type PermissionAnswer = (typeof ANSWERS)[number];
/** The most characters of a plugin's fixed "what next" text for an allowed card. */
export const MAX_NEXT_STEP_CHARS = 600;
const EntryObject = z.object({
  id: z.string(),
  kinds: ItemKinds,
  /** The card's link, kept so a card still waiting can be sent again. */
  url: z.string().url().optional().catch(undefined),
  /** What the card asked: its catalogue action ids and credential types. */
  actions: z.array(z.string().max(128)).max(5).optional().catch(undefined),
  vcts: z.array(z.string().max(512)).max(5).optional().catch(undefined),
  /** Another plugin's fixed words for the agent once the card is allowed. */
  next: z.string().max(MAX_NEXT_STEP_CHARS).optional().catch(undefined),
  /** Another plugin's fixed words once an identity check from this card passed. */
  verifiedNext: z.string().max(MAX_NEXT_STEP_CHARS).optional().catch(undefined),
  /** The final answer a tool already read in the chat (the person knows it). */
  seen: z.enum(ANSWERS).optional().catch(undefined),
  /** The answer a permission event already told, and the event's request id. */
  told: z
    .object({ status: z.enum(ANSWERS), requestId: z.string().max(180) })
    .optional()
    .catch(undefined),
});
export type PermissionRecord = z.infer<typeof EntryObject>;
/** One card: its id once, with the kinds of its items (older rows: the id alone). */
const Entry = z.union([
  z.string().transform((id): PermissionRecord => ({ id, kinds: [] })),
  EntryObject,
]);
const Entries = z.array(Entry);

function isAnswer(status: string): status is PermissionAnswer {
  return (ANSWERS as readonly string[]).includes(status);
}

/** What a card asked for, kept with its id (see {@link recordPermission}). */
export interface PermissionAsked {
  actions?: readonly string[];
  vcts?: readonly string[];
  /** Fixed words for the agent once the card is allowed (another plugin's). */
  next?: string;
  /** Fixed words for the agent once an identity check from this card passed. */
  verifiedNext?: string;
}

/**
 * Remember a permission card's id as this person's, once, with the kinds of
 * its items and what it asked (oldest dropped first). What a card recorded
 * before (its link, what it asked, its answers) stays when it is recorded
 * again without it.
 */
export async function recordPermission(
  kv: UserKvSurface,
  id: string,
  kinds: readonly ('credential-check' | 'service-action')[] = [],
  url?: string,
  asked: PermissionAsked = {},
): Promise<void> {
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    PERMISSIONS_KEY,
    (current) => {
      const parsed = Entries.safeParse(current);
      const all = parsed.success ? parsed.data : [];
      const kept = all.find((x) => x.id === id);
      const link = url ?? kept?.url;
      const actions = asked.actions ? [...asked.actions] : kept?.actions;
      const vcts = asked.vcts ? [...asked.vcts] : kept?.vcts;
      const next = asked.next ?? kept?.next;
      const verifiedNext = asked.verifiedNext ?? kept?.verifiedNext;
      const entries = all.filter((x) => x.id !== id);
      entries.push({
        id,
        kinds: [...kinds],
        ...(link ? { url: link } : {}),
        ...(actions ? { actions } : {}),
        ...(vcts ? { vcts } : {}),
        ...(next ? { next } : {}),
        ...(verifiedNext ? { verifiedNext } : {}),
        ...(kept?.seen ? { seen: kept.seen } : {}),
        ...(kept?.told ? { told: kept.told } : {}),
      });
      return entries.slice(-MAX_PERMISSIONS);
    },
    { idleTtlMs: PERMISSION_IDLE_TTL_MS },
  );
}

/**
 * For another plugin that asks the Hub for a card itself (with
 * `HubPermissionsClient.request`): record the card in this person's
 * credentials kv, with what it asked and, optionally, `next`: fixed words
 * for the agent once the person allows it (what to do next, for example
 * "call rewards_claim, then send its message"; at most 600 characters,
 * never model or Hub text) and `verifiedNext`: the same once an identity
 * check made with this card's grants passed. The credentials plugin then
 * answers the card's permission events: it reads the card at the Hub, and
 * says "Thanks, you allowed it." and lets the agent go on with `next`, or
 * the fixed sentence for "Don't allow" or a card that ran out; and the
 * identity-check events of a link made from the card ("Your identity check
 * is done. You are verified." and `verifiedNext`). Call it right after the
 * Hub answered the request, in the turn's own `ctx.kv`.
 */
export async function rememberPermissionCard(
  kv: UserKvSurface,
  card: {
    permissionId: string;
    items: readonly PermissionRequest[];
    url?: string;
    next?: string;
    verifiedNext?: string;
  },
): Promise<void> {
  const next = card.next?.trim();
  const verifiedNext = card.verifiedNext?.trim();
  for (const [name, value] of [
    ['next', next],
    ['verifiedNext', verifiedNext],
  ] as const)
    if (value && value.length > MAX_NEXT_STEP_CHARS)
      throw new RangeError(
        `${name} is longer than ${MAX_NEXT_STEP_CHARS} characters`,
      );
  const actions = card.items.flatMap((p) =>
    p.kind === 'service-action' ? [p.action] : [],
  );
  const vcts = card.items.flatMap((p) =>
    p.kind === 'credential-check' ? [p.vct] : [],
  );
  await recordPermission(
    kv,
    card.permissionId,
    card.items.map((p) => p.kind),
    card.url,
    {
      actions,
      vcts,
      ...(next ? { next } : {}),
      ...(verifiedNext ? { verifiedNext } : {}),
    },
  );
}

/** Card `id` as this person's kv recorded it, or null. */
export async function readPermissionRecord(
  kv: UserKvSurface,
  id: string,
): Promise<PermissionRecord | null> {
  const parsed = Entries.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, PERMISSIONS_KEY),
  );
  if (!parsed.success) return null;
  return parsed.data.find((x) => x.id === id) ?? null;
}

/** Change the record of card `id` (nothing when the kv does not hold it). */
async function updateRecord(
  kv: UserKvSurface,
  id: string,
  change: (record: PermissionRecord) => PermissionRecord,
): Promise<void> {
  const record = await readPermissionRecord(kv, id);
  if (!record) return;
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    PERMISSIONS_KEY,
    (current) => {
      const parsed = Entries.safeParse(current);
      if (!parsed.success) return current;
      return parsed.data.map((x) => (x.id === id ? change(x) : x));
    },
    { idleTtlMs: PERMISSION_IDLE_TTL_MS },
  );
}

/**
 * Note that the person already learned card `id`'s final answer in the chat
 * (a tool read it), so a permission event for that answer stays silent.
 * Anything but `allowed`, `declined` or `expired` is ignored.
 */
export async function notePermissionAnswerSeen(
  kv: UserKvSurface,
  id: string,
  status: string,
): Promise<void> {
  if (!isAnswer(status)) return;
  const record = await readPermissionRecord(kv, id);
  if (!record || record.seen === status) return;
  await updateRecord(kv, id, (x) => ({ ...x, seen: status }));
}

/** Note that a permission event (request `requestId`) told card `id`'s answer. */
export async function notePermissionAnswerTold(
  kv: UserKvSurface,
  id: string,
  status: PermissionAnswer,
  requestId: string,
): Promise<void> {
  await updateRecord(kv, id, (x) => ({ ...x, told: { status, requestId } }));
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
    /** Self's "in review" beside `in_progress`; rows kept before it have none. */
    review: z.literal(true).optional().catch(undefined),
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

/**
 * The status read last for a link, however old: only for choosing words
 * (a check in review leaves review only for a final status), never as an
 * answer about progress.
 */
export async function lastLinkState(
  kv: UserKvSurface,
  linkId: string,
): Promise<LinkState | null> {
  const parsed = CachedLink.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, linkKey(linkId)),
  );
  return parsed.success ? parsed.data.state : null;
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
  // A tool read the check's state: the person learns it in the chat.
  const told = identityOutcomeOf(state);
  if (told) await noteLinkSeen(kv, state.linkId, told);
}

// ---------------------------------------------------------------------------
// Identity-check links this oracle made for the person.

/** What an identity-check event or a tool can tell about a check. */
export const IDENTITY_OUTCOMES = ['in_review', 'passed', 'failed'] as const;
export type IdentityOutcome = (typeof IDENTITY_OUTCOMES)[number];

/** A link state as an outcome the person is told, or null (still going, ended unused). */
export function identityOutcomeOf(
  state: Pick<LinkState, 'status' | 'review'>,
): IdentityOutcome | null {
  if (state.status === 'in_progress') return state.review ? 'in_review' : null;
  return state.status === 'passed' || state.status === 'failed'
    ? state.status
    : null;
}

const LINKS_KEY = 'links';
const MAX_LINKS = 32;

const LinkRecordSchema = z.object({
  linkId: z.string(),
  /** The card whose grants made the link, when known. */
  permissionId: z.string().optional().catch(undefined),
  /** The outcome a tool already read in the chat. */
  seen: z.enum(IDENTITY_OUTCOMES).optional().catch(undefined),
  /** The outcome an identity-check event already told, and its request id. */
  told: z
    .object({
      status: z.enum(IDENTITY_OUTCOMES),
      requestId: z.string().max(180),
    })
    .optional()
    .catch(undefined),
});
export type LinkRecord = z.infer<typeof LinkRecordSchema>;
const LinkRecords = z.array(LinkRecordSchema);

async function updateLinks(
  kv: UserKvSurface,
  change: (links: LinkRecord[]) => LinkRecord[],
): Promise<void> {
  await kv.update(
    CREDENTIALS_KV_NAMESPACE,
    LINKS_KEY,
    (current) => {
      const parsed = LinkRecords.safeParse(current);
      return change(parsed.success ? parsed.data : []).slice(-MAX_LINKS);
    },
    { idleTtlMs: PERMISSION_IDLE_TTL_MS },
  );
}

/** Remember an identity-check link made for this person (and the card it came from). */
export async function recordLink(
  kv: UserKvSurface,
  linkId: string,
  permissionId?: string,
): Promise<void> {
  await updateLinks(kv, (links) => [
    ...links.filter((x) => x.linkId !== linkId),
    { linkId, ...(permissionId ? { permissionId } : {}) },
  ]);
}

/** The link as this person's kv recorded it, or null (not made here for them). */
export async function readLinkRecord(
  kv: UserKvSurface,
  linkId: string,
): Promise<LinkRecord | null> {
  const parsed = LinkRecords.safeParse(
    await kv.get(CREDENTIALS_KV_NAMESPACE, LINKS_KEY),
  );
  if (!parsed.success) return null;
  return parsed.data.find((x) => x.linkId === linkId) ?? null;
}

/** Note that the person learned this outcome of link `linkId` in the chat. */
export async function noteLinkSeen(
  kv: UserKvSurface,
  linkId: string,
  status: IdentityOutcome,
): Promise<void> {
  const record = await readLinkRecord(kv, linkId);
  if (!record || record.seen === status) return;
  await updateLinks(kv, (links) =>
    links.map((x) => (x.linkId === linkId ? { ...x, seen: status } : x)),
  );
}

/** Note that an identity-check event (request `requestId`) told this outcome. */
export async function noteLinkTold(
  kv: UserKvSurface,
  linkId: string,
  status: IdentityOutcome,
  requestId: string,
): Promise<void> {
  await updateLinks(kv, (links) =>
    links.map((x) =>
      x.linkId === linkId ? { ...x, told: { status, requestId } } : x,
    ),
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
  // A tool read the card's final answer: the person learns it in the chat.
  await notePermissionAnswerSeen(kv, state.id, state.status);
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
