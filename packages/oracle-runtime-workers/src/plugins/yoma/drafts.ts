import { z } from 'zod';
import { UserKvLimitError } from '../../core/user-kv';
import type { RuntimeContext } from '../../plugin-api/types';
import type { Failure } from '../ixo-chain/http';
import type { FormKind } from './catalog';

/**
 * A person's applications and claims in progress, kept in their own database
 * (`ctx.kv`) so they survive between messages, days and object restarts.
 * Every answer is saved the moment it arrives.
 *
 * One key per draft (`draft:<form>:<collectionId>`) and a small index of
 * the OPEN ones, so a draft never shares the 256 KiB value cap with another
 * and one unreadable draft never takes the rest with it: each is parsed on
 * its own, and one that fails is reported and skipped, never overwritten
 * (it can be deleted on request). The index is advisory; a key it names
 * that holds nothing is simply not listed.
 *
 * Sent work leaves the index: a sent claim is moved to the `sent` record
 * (its claim id kept) and its draft deleted, so the next `next` starts a
 * new claim on the same job (a permission covers as many claims as its
 * quota); a sent application keeps its draft (the job says "applied") but
 * no longer counts towards {@link MAX_DRAFTS}.
 *
 * A single-value book under the key `drafts` existed only on unreleased
 * branches: it is ignored, never read or migrated.
 */
export const DRAFTS_NAMESPACE = 'yoma';
const INDEX_KEY = 'draft-index';
const SENT_KEY = 'sent';

/** Drafts a person can have open (not sent) at once. */
export const MAX_DRAFTS = 20;
/** Sent applications and claims remembered for `my_drafts`, newest last. */
export const MAX_SENT = 50;
/** Files kept per draft. */
export const MAX_EVIDENCE = 30;
/** Items per repeating section (each shop, each household). */
export const MAX_SECTION_ITEMS = 50;

const evidenceSchema = z.object({
  /** The question it answers (`photo`, or `shops[2].photo` inside a repeating section). */
  path: z.string().max(300),
  url: z.string().max(2000),
  filename: z.string().max(200),
  mimetype: z.string().max(100),
  size: z.number(),
  sha256: z.string().max(64),
  kind: z.enum(['image', 'video', 'document', 'audio']),
  receivedAt: z.string(),
});

const draftSchema = z.object({
  v: z.literal(1),
  form: z.enum(['application', 'claim']),
  collectionId: z.string(),
  entityDid: z.string(),
  protocolDid: z.string(),
  admin: z.string(),
  /** The job's name as the person saw it. */
  title: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  /** Answers in SurveyJS's data shape. File questions hold a placeholder until submit. */
  data: z.record(z.string(), z.unknown()),
  skipped: z.array(z.string()),
  closedSections: z.array(z.string()),
  evidence: z.array(evidenceSchema).max(MAX_EVIDENCE),
  /** Sends tried so far (cleared cards and failed sends): part of the next card's request key. */
  cardAttempt: z.number().int().min(0).default(0),
  /** The card waiting for the person: its Hub action id, when it expires (unix s), the answers it carried, the last outcome seen. */
  card: z
    .object({
      actionId: z.string(),
      requestKey: z.string(),
      sentAt: z.string(),
      answersAt: z.string(),
      expiresAt: z.number().optional(),
      status: z.enum(['authorized', 'submitted', 'unknown']).optional(),
    })
    .optional(),
  /**
   * The read-back the person was shown for these answers (`updatedAt`): in
   * which request, and which of its pages. `submit` sends only on a later
   * request (their reply) with the same answers and every page shown.
   */
  review: z
    .object({
      updatedAt: z.string(),
      requestId: z.string().max(200),
      pages: z.array(z.number().int().min(1).max(50)).max(50),
      total: z.number().int().min(1).max(50),
    })
    .optional(),
  /** Instant permission: the host's grant was started (at most once per draft), and when it failed if it did. */
  grant: z
    .object({ startedAt: z.string(), failedAt: z.string().optional() })
    .optional(),
  /** Set once the card's outcome came back as done. */
  submittedAt: z.string().optional(),
  /** A claim's id (its CID) from the claim card's receipt. */
  claimId: z.string().max(200).optional(),
  /** Why the last card stopped before it finished, from its receipt: the step and the Hub's words. */
  cardFailure: z
    .object({ step: z.string().max(40), message: z.string().max(200) })
    .optional(),
});

const indexSchema = z.object({
  v: z.literal(1),
  keys: z.array(z.string()).max(MAX_DRAFTS * 2),
});

const sentItemSchema = z.object({
  form: z.enum(['application', 'claim']),
  collectionId: z.string(),
  title: z.string(),
  submittedAt: z.string(),
  claimId: z.string().max(200).optional(),
  /** The card's Hub action, so a sent card is recorded once. */
  actionId: z.string().optional(),
});
const sentSchema = z.object({
  v: z.literal(1),
  items: z.array(sentItemSchema).max(MAX_SENT),
});
export type SentItem = z.infer<typeof sentItemSchema>;

/** A file the person sent for a question, held by the gateway until the claim is filed. */
export type Evidence = z.infer<typeof evidenceSchema>;
export type Draft = z.infer<typeof draftSchema>;

export type Kv = NonNullable<RuntimeContext['kv']>;

/** Open: not sent yet. Only open drafts are in the index and count towards {@link MAX_DRAFTS}. */
export const isOpen = (draft: Draft) => !draft.submittedAt;

export function draftKey(form: FormKind, collectionId: string): string {
  return `draft:${form}:${collectionId}`;
}

const tooLargeFailure: Failure = {
  reason: 'too_large',
  detail:
    'This is more than can be saved for one form; leave some files or items out.',
  retryable: false,
};

/** A full storage, as a failure; anything else is rethrown. */
export function storageFailure(error: unknown): Failure {
  if (error instanceof UserKvLimitError) return tooLargeFailure;
  throw error;
}

async function readIndex(kv: Kv): Promise<string[]> {
  const parsed = indexSchema.safeParse(
    await kv.get(DRAFTS_NAMESPACE, INDEX_KEY),
  );
  return parsed.success ? parsed.data.keys : [];
}

export type DraftRead = { ok: true; draft: Draft } | { ok: false; key: string };

/** Every draft the index names, each parsed on its own; an unreadable one is reported, not dropped. */
export async function allDrafts(kv: Kv): Promise<DraftRead[]> {
  const keys = await readIndex(kv);
  const reads = await Promise.all(
    keys.map(async (key): Promise<DraftRead | undefined> => {
      const raw: unknown = await kv.get(DRAFTS_NAMESPACE, key);
      if (raw === undefined) return undefined;
      const parsed = draftSchema.safeParse(raw);
      return parsed.success
        ? { ok: true, draft: parsed.data }
        : { ok: false, key };
    }),
  );
  return reads.filter((r): r is DraftRead => r !== undefined);
}

export type DraftLookup =
  | { ok: true; draft: Draft | undefined }
  | { ok: false; failure: Failure };

const UNREADABLE: Failure = {
  reason: 'unavailable',
  detail:
    'This saved form could not be read; it can be deleted and started again.',
  retryable: false,
};

/** A change that would not make a valid draft: refused, the draft left as it was. */
const INVALID_WRITE: Failure = {
  reason: 'unavailable',
  detail: 'That could not be saved; everything saved before is kept.',
  retryable: false,
};

export async function getDraft(
  kv: Kv,
  form: FormKind,
  collectionId: string,
): Promise<DraftLookup> {
  const raw: unknown = await kv.get(
    DRAFTS_NAMESPACE,
    draftKey(form, collectionId),
  );
  if (raw === undefined) return { ok: true, draft: undefined };
  const parsed = draftSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, draft: parsed.data }
    : { ok: false, failure: UNREADABLE };
}

export type DraftWrite =
  | { ok: true; draft: Draft | undefined }
  | { ok: false; failure: Failure };

/** What a change answers: the next draft, undefined to delete it, or a refusal that leaves it as it is. */
export type DraftChange = Draft | undefined | { refuse: Failure };

const isRefusal = (change: DraftChange): change is { refuse: Failure } =>
  change !== undefined && 'refuse' in change;

/**
 * Changes one draft atomically: `change` runs inside the store's
 * read-modify-write (synchronous, no side effects: the store may run it
 * again), on the draft as it is stored at that moment, and returns the new
 * one, undefined to delete it, or `{ refuse }` to leave it as it is. An
 * unreadable stored draft is never overwritten (only deleted), and a change
 * that is not a valid draft is refused. A new open draft is refused past
 * {@link MAX_DRAFTS}; a write past the storage caps answers `too_large` and
 * leaves the draft as it was. The index follows: open drafts in, the rest out.
 */
export async function updateDraft(
  kv: Kv,
  form: FormKind,
  collectionId: string,
  change: (current: Draft | undefined) => DraftChange,
): Promise<DraftWrite> {
  const key = draftKey(form, collectionId);
  try {
    let refused: Failure | undefined;
    let wasOpen = false;
    const written: unknown = await kv.update(DRAFTS_NAMESPACE, key, (raw) => {
      refused = undefined;
      wasOpen = false;
      const current =
        raw === undefined ? undefined : draftSchema.safeParse(raw);
      if (current?.success) wasOpen = isOpen(current.data);
      const next = change(current?.success ? current.data : undefined);
      if (next === undefined) return undefined;
      if (isRefusal(next)) {
        refused = next.refuse;
        return raw;
      }
      if (current && !current.success) {
        refused = UNREADABLE;
        return raw;
      }
      const valid = draftSchema.safeParse(next);
      if (!valid.success) {
        refused = INVALID_WRITE;
        return raw;
      }
      return valid.data;
    });
    if (refused) return { ok: false, failure: refused };
    const parsed =
      written === undefined ? undefined : draftSchema.safeParse(written);
    const draft = parsed?.success ? parsed.data : undefined;
    if (!draft || !isOpen(draft)) {
      await kv.update(DRAFTS_NAMESPACE, INDEX_KEY, (raw) => {
        const index = indexSchema.safeParse(raw);
        const keys = index.success ? index.data.keys : [];
        return keys.includes(key)
          ? { v: 1, keys: keys.filter((k) => k !== key) }
          : raw;
      });
      return { ok: true, draft };
    }
    if (!wasOpen) {
      let full = false;
      await kv.update(DRAFTS_NAMESPACE, INDEX_KEY, (raw) => {
        const index = indexSchema.safeParse(raw);
        const keys = index.success ? index.data.keys : [];
        full = false;
        if (keys.includes(key)) return { v: 1, keys };
        full = keys.length >= MAX_DRAFTS;
        return full ? { v: 1, keys } : { v: 1, keys: [...keys, key] };
      });
      if (full) {
        await kv.delete(DRAFTS_NAMESPACE, key);
        return {
          ok: false,
          failure: {
            reason: 'too_large',
            detail: `They already have ${MAX_DRAFTS} forms in progress; finish or delete one first.`,
            retryable: false,
          },
        };
      }
    }
    return { ok: true, draft };
  } catch (error) {
    return { ok: false, failure: storageFailure(error) };
  }
}

/** Sent applications and claims, oldest first; an unreadable record reads as none. */
export async function sentItems(kv: Kv): Promise<SentItem[]> {
  const parsed = sentSchema.safeParse(await kv.get(DRAFTS_NAMESPACE, SENT_KEY));
  return parsed.success ? parsed.data.items : [];
}

/**
 * Records a sent draft (once per card: by its action id), keeping the
 * newest {@link MAX_SENT}. A full storage is a failure; anything else is
 * rethrown.
 */
export async function recordSent(
  kv: Kv,
  item: SentItem,
): Promise<{ ok: true } | { ok: false; failure: Failure }> {
  try {
    await kv.update(DRAFTS_NAMESPACE, SENT_KEY, (raw) => {
      const parsed = sentSchema.safeParse(raw);
      const items = parsed.success ? parsed.data.items : [];
      if (
        item.actionId &&
        items.some((existing) => existing.actionId === item.actionId)
      )
        return { v: 1, items };
      return { v: 1, items: [...items, item].slice(-MAX_SENT) };
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, failure: storageFailure(error) };
  }
}
