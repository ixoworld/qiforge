/**
 * Per-(user, session) record of what the DAO DAO tools showed the user and
 * sent to their wallet, in the user's own database (`ctx.kv`), with the
 * POD Creator's create-session rules (`pod-creator/create-session-store.ts`):
 *
 * - Cross-turn confirmation. A preview (a call without `riskConfirmation`)
 *   records the digest of the step's arguments and the request (turn) that
 *   showed it. The signing call must carry the same digest and come from a
 *   later request: the user has to answer in a new message after seeing the
 *   summary, so one model turn — steered, say, by injected text in a
 *   proposal's title — cannot run preview → sign on its own. A claim spends
 *   the preview: every wallet request needs a preview of its own.
 * - One creation per group. `create_dao_group` records each group sent to the
 *   wallet by the digest of its arguments: `sending` while the wallet is
 *   asked, then `created`, or `unknown` when its answer was lost (a timeout).
 *   A repeat of the same group is refused while it is sending, after it was
 *   created, and after an unknown outcome until that is resolved by reading
 *   its transaction back; a failed or declined signing releases it. A
 *   `sending` or `unknown` attempt holds for {@link GROUP_ATTEMPT_HOLD_MS}
 *   from when it was sent, so a lost answer never blocks the group for good.
 *   `link_dao_group` records each link (entity and group) the same way, by
 *   the digest of its own arguments: `created` is then a link confirmed on
 *   chain.
 *
 * Each transition is one atomic read-modify-write of the session's row. A
 * row that no longer parses is read as empty: the user previews again, the
 * safe direction for a confirmation gate.
 */
import { z } from 'zod';
import type { UserKvSurface } from '../../plugin-api/types';

/** `ctx.kv` namespace holding one record per (user, session). */
export const DAO_CONFIRMATIONS_NAMESPACE = 'ixo-transaction/dao-confirmations';

/** Idle lifetime of a session's record: the POD Creator's create sessions'. */
const TTL_MS = 60 * 60 * 1000;
/** Sessions kept per user: the POD Creator's create sessions'. */
const MAX_SESSIONS = 1000;
/** Previews kept per session (the newest; a new preview of a digest replaces its old one). */
export const MAX_PREVIEWS = 16;
/** Group attempts kept per session (the newest). */
export const MAX_GROUP_ATTEMPTS = 16;
/**
 * How long a group sent to the wallet whose answer is not known blocks the
 * same group, from when it was sent: far past the longest wallet wait
 * (`MAX_SIGN_TIMEOUT_MS`, 5 minutes) and the chain's indexing, so a group
 * the user did sign is in chain_lookup daos well before it ends.
 */
export const GROUP_ATTEMPT_HOLD_MS = 60 * 60 * 1000;

const previewSchema = z.object({ digest: z.string(), requestId: z.string() });

const attemptSchema = z.object({
  digest: z.string(),
  state: z.enum(['sending', 'created', 'unknown']),
  /** Epoch ms the wallet was asked. */
  at: z.number(),
  txHash: z.string().optional(),
  coreAddress: z.string().optional(),
});

const recordSchema = z.object({
  previews: z.array(previewSchema).default([]),
  groups: z.array(attemptSchema).default([]),
});

type ConfirmationRecord = z.infer<typeof recordSchema>;

/** A group sent to the wallet in this session, by its arguments' digest. */
export type GroupAttempt = z.infer<typeof attemptSchema>;

export type ConfirmationClaim = 'ok' | 'not-previewed' | 'same-request';

export type GroupClaim =
  | { status: 'ok' }
  | { status: 'not-previewed' | 'same-request' }
  | { status: 'attempted'; attempt: GroupAttempt };

/** How a claimed group creation ended. */
export type GroupSettlement =
  | { state: 'released' }
  | { state: 'unknown' }
  | { state: 'created'; txHash?: string; coreAddress?: string };

/** A JSON pair cannot collide the way a joined string could. */
const key = (userDid: string, sessionId: string): string =>
  JSON.stringify([userDid, sessionId]);

function parseRecord(value: unknown): ConfirmationRecord {
  const parsed = recordSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : { previews: [], groups: [] };
}

export class KvDaoConfirmationStore {
  private readonly writeOptions = {
    idleTtlMs: TTL_MS,
    maxEntries: MAX_SESSIONS,
  };

  constructor(
    private readonly kv: UserKvSurface,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * One atomic read-modify-write of the session's record, answering what
   * the step decided (`fallback` only if the store never ran it).
   */
  private async change<T>(
    userDid: string,
    sessionId: string,
    fallback: T,
    step: (record: ConfirmationRecord) => {
      outcome: T;
      record?: ConfirmationRecord;
    },
  ): Promise<T> {
    let outcome = fallback;
    await this.kv.update(
      DAO_CONFIRMATIONS_NAMESPACE,
      key(userDid, sessionId),
      (current) => {
        const record = parseRecord(current);
        const result = step(record);
        outcome = result.outcome;
        const next = result.record ?? record;
        return next.previews.length === 0 && next.groups.length === 0
          ? undefined
          : next;
      },
      this.writeOptions,
    );
    return outcome;
  }

  /** The attempt of `digest` that still blocks it: created, or sending / unknown within the hold. */
  private active(
    record: ConfirmationRecord,
    digest: string,
  ): GroupAttempt | undefined {
    const attempt = record.groups.find((entry) => entry.digest === digest);
    if (!attempt) return undefined;
    if (attempt.state === 'created') return attempt;
    return this.now() - attempt.at < GROUP_ATTEMPT_HOLD_MS
      ? attempt
      : undefined;
  }

  /** Record what request `preview.requestId` showed the user; a new preview of a digest replaces its old one. */
  async preview(
    userDid: string,
    sessionId: string,
    preview: { digest: string; requestId: string },
  ): Promise<void> {
    await this.change(userDid, sessionId, undefined, (record) => ({
      outcome: undefined,
      record: {
        ...record,
        previews: [
          ...record.previews.filter((entry) => entry.digest !== preview.digest),
          preview,
        ].slice(-MAX_PREVIEWS),
      },
    }));
  }

  /**
   * Spend the preview of `claim.digest` for one wallet request:
   * `not-previewed` when none was shown, `same-request` when the request
   * that signs is the one that showed it (the preview stays then).
   */
  claim(
    userDid: string,
    sessionId: string,
    claim: { digest: string; requestId: string },
  ): Promise<ConfirmationClaim> {
    return this.change<ConfirmationClaim>(
      userDid,
      sessionId,
      'not-previewed',
      (record) => {
        const outcome = previewOutcome(record, claim);
        if (outcome !== 'ok') return { outcome };
        return {
          outcome,
          record: {
            ...record,
            previews: record.previews.filter(
              (entry) => entry.digest !== claim.digest,
            ),
          },
        };
      },
    );
  }

  /** The attempt that blocks the group of `digest`, if any. */
  async groupAttempt(
    userDid: string,
    sessionId: string,
    digest: string,
  ): Promise<GroupAttempt | undefined> {
    const record = parseRecord(
      await this.kv.get(DAO_CONFIRMATIONS_NAMESPACE, key(userDid, sessionId)),
    );
    return this.active(record, digest);
  }

  /**
   * Claim the creation of the group of `claim.digest`: refused while an
   * attempt of it blocks it (`attempted`), or without a preview of it from
   * an earlier request. On `ok` the preview is spent and the group is
   * recorded as `sending`.
   */
  claimGroup(
    userDid: string,
    sessionId: string,
    claim: { digest: string; requestId: string },
  ): Promise<GroupClaim> {
    return this.change<GroupClaim>(
      userDid,
      sessionId,
      { status: 'not-previewed' },
      (record) => {
        const attempt = this.active(record, claim.digest);
        if (attempt) return { outcome: { status: 'attempted', attempt } };
        const outcome = previewOutcome(record, claim);
        if (outcome !== 'ok') return { outcome: { status: outcome } };
        return {
          outcome: { status: 'ok' },
          record: {
            previews: record.previews.filter(
              (entry) => entry.digest !== claim.digest,
            ),
            groups: [
              ...record.groups.filter((entry) => entry.digest !== claim.digest),
              {
                digest: claim.digest,
                state: 'sending' as const,
                at: this.now(),
              },
            ].slice(-MAX_GROUP_ATTEMPTS),
          },
        };
      },
    );
  }

  /**
   * End the attempt of `digest`: `released` drops it (the group can be
   * previewed and sent again), `unknown` keeps it blocking, `created` keeps
   * it for good, with its transaction and address when known.
   */
  async settleGroup(
    userDid: string,
    sessionId: string,
    digest: string,
    settlement: GroupSettlement,
  ): Promise<void> {
    await this.change(userDid, sessionId, undefined, (record) => {
      const attempt = record.groups.find((entry) => entry.digest === digest);
      if (!attempt) return { outcome: undefined };
      const others = record.groups.filter((entry) => entry.digest !== digest);
      if (settlement.state === 'released')
        return { outcome: undefined, record: { ...record, groups: others } };
      const { state, ...known } = settlement;
      return {
        outcome: undefined,
        record: {
          ...record,
          groups: [...others, { ...attempt, ...known, state }],
        },
      };
    });
  }
}

/** Whether `claim` has a preview from an earlier request. */
function previewOutcome(
  record: ConfirmationRecord,
  claim: { digest: string; requestId: string },
): ConfirmationClaim {
  const preview = record.previews.find(
    (entry) => entry.digest === claim.digest,
  );
  if (!preview) return 'not-previewed';
  return preview.requestId === claim.requestId ? 'same-request' : 'ok';
}
