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
 * those keys, so a draft never shares the 256 KiB value cap with another and
 * one unreadable draft never takes the rest with it: each is parsed on its
 * own, and one that fails is reported and skipped, never deleted. The index
 * is advisory; a key it names that holds nothing is simply not listed.
 *
 * A single-value book under the key `drafts` existed only on unreleased
 * branches: it is ignored, never read or migrated.
 */
export const DRAFTS_NAMESPACE = 'yoma';
const INDEX_KEY = 'draft-index';

/** Drafts a person can have open at once. */
export const MAX_DRAFTS = 20;
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
  /** Cards sent and cleared so far: part of the next card's request key, so a declined or expired card can be sent again. */
  cardAttempt: z.number().int().min(0).default(0),
  /** The card waiting for the person: its Hub action id, when it expires (unix s), the answers it carried. */
  card: z
    .object({
      actionId: z.string(),
      requestKey: z.string(),
      sentAt: z.string(),
      answersAt: z.string(),
      expiresAt: z.number().optional(),
    })
    .optional(),
  /** Set once the card's outcome came back as done. */
  submittedAt: z.string().optional(),
});

const indexSchema = z.object({
  v: z.literal(1),
  keys: z.array(z.string()).max(MAX_DRAFTS * 2),
});

/** A file the person sent for a question, held by the gateway until the claim is filed. */
export type Evidence = z.infer<typeof evidenceSchema>;
export type Draft = z.infer<typeof draftSchema>;

export type Kv = NonNullable<RuntimeContext['kv']>;

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
    : {
        ok: false,
        failure: {
          reason: 'unavailable',
          detail:
            'This saved form could not be read; it can be deleted and started again.',
          retryable: false,
        },
      };
}

export type DraftWrite =
  | { ok: true; draft: Draft | undefined }
  | { ok: false; failure: Failure };

/**
 * Changes one draft atomically. `change` gets the current draft (or
 * undefined) and returns the new one, or undefined to delete it. A new
 * draft is refused past {@link MAX_DRAFTS}; a write past the storage caps
 * answers `too_large` and leaves the draft as it was.
 */
export async function updateDraft(
  kv: Kv,
  form: FormKind,
  collectionId: string,
  change: (current: Draft | undefined) => Draft | undefined,
): Promise<DraftWrite> {
  const key = draftKey(form, collectionId);
  try {
    let created = false;
    const written: unknown = await kv.update(DRAFTS_NAMESPACE, key, (raw) => {
      const current = draftSchema.safeParse(raw);
      const next = change(current.success ? current.data : undefined);
      created = raw === undefined && next !== undefined;
      return next;
    });
    if (written === undefined) {
      await kv.update(DRAFTS_NAMESPACE, INDEX_KEY, (raw) => {
        const parsed = indexSchema.safeParse(raw);
        const keys = (parsed.success ? parsed.data.keys : []).filter(
          (k) => k !== key,
        );
        return { v: 1, keys };
      });
      return { ok: true, draft: undefined };
    }
    if (created) {
      let full = false;
      await kv.update(DRAFTS_NAMESPACE, INDEX_KEY, (raw) => {
        const parsed = indexSchema.safeParse(raw);
        const keys = parsed.success ? parsed.data.keys : [];
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
    const parsed = draftSchema.safeParse(written);
    return { ok: true, draft: parsed.success ? parsed.data : undefined };
  } catch (error) {
    return { ok: false, failure: storageFailure(error) };
  }
}
