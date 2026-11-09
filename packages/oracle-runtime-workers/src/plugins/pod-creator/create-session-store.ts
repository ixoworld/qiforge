import {
  DAODAO_DEFAULT_ALLOW_REVOTING,
  DAODAO_VOTING_PERIOD_SECONDS,
  ITrxMsgSchema,
} from '@ixo/ixo-transaction';
import { z } from 'zod';
import type { RuntimeContext, UserKvSurface } from '../../plugin-api/types';
import type { PodGroupSpec, SentPodBatch } from './chain-gateway';

/**
 * Per-(user, thread) state machine for the create path's propose → approve →
 * commit handoff. Exactly one batch can be pending per key: `prepared`
 * supersedes anything before it, `approve` binds the user's go-ahead to that
 * exact blobId, and `consume` spends the approval — so every wallet sign
 * dispatch requires a fresh, explicit approval and a sign request can never be
 * replayed from a stale one. Keyed by user DID as well as thread so a batch
 * prepared in another thread (or by another user in a shared thread) can never
 * be approved here.
 *
 * The session also records the request (turn) that prepared the batch, and
 * approval is refused within that same request: the user has to send a new
 * message after seeing the batch before it can be approved, so a single model
 * turn — steered, say, by injected text in the brief or a section — cannot run
 * prepare → approve → sign on its own.
 *
 * After the commit it keeps what was sent for signing (confirmation checks
 * the transaction against it), the POD confirmed from it, and the steps
 * that may follow, each once per POD: its domain card, and its governance
 * group (shown to the user, created, then linked to the POD).
 */
export interface CreateSessionStore {
  /** Record a freshly prepared batch; anything before it in the thread is superseded. */
  prepared(
    userDid: string,
    threadId: string,
    blobId: string,
    requestId: string,
  ): Promise<void>;
  /**
   * Approve the pending batch from request `requestId`. `not-prepared` when
   * `blobId` is not the batch prepared for this user+thread; `same-request`
   * when the approval comes from the request that prepared it.
   */
  approve(
    userDid: string,
    threadId: string,
    blobId: string,
    requestId: string,
  ): Promise<ApproveOutcome>;
  /**
   * Spend the approval for a sign dispatch of `sent`. Returns true only when
   * `blobId` is the approved pending batch; the approval is cleared when it
   * matches (a second dispatch needs a fresh approve) and `sent` is recorded
   * as what the wallet was asked to sign.
   */
  consume(
    userDid: string,
    threadId: string,
    blobId: string,
    sent?: SentPodBatch,
  ): Promise<boolean>;
  /** The thread's approval, what its last sign request carried, and the POD confirmed from it. */
  read(
    userDid: string,
    threadId: string,
  ): Promise<CreateSessionView | undefined>;
  /** Record the POD confirmed from the sent batch (no-op when nothing was sent). */
  confirmed(
    userDid: string,
    threadId: string,
    pod: { podDid: string; txHash: string },
  ): Promise<void>;
  /**
   * Claim the confirmed POD's one domain card step. `no-pod` when no POD
   * was confirmed in the thread, `claimed` when the card is being added or
   * was added already.
   */
  claimCard(userDid: string, threadId: string): Promise<CardClaim>;
  /** End a claimed card step: `added` keeps it closed, `released` lets it run again. */
  settleCard(
    userDid: string,
    threadId: string,
    outcome: 'added' | 'released',
  ): Promise<void>;
  /**
   * Record the governance group shown to the user for confirmation (its
   * digest) from request `requestId`; a later preview replaces it.
   * `no-pod` when no POD was confirmed in the thread, `claimed` when its
   * group is being created or was created already.
   */
  previewGroup(
    userDid: string,
    threadId: string,
    preview: { digest: string; requestId: string },
  ): Promise<GroupPreviewOutcome>;
  /**
   * Claim the confirmed POD's one group creation for `group`, whose digest
   * must be the one previewed, from a later request than the preview's. The
   * preview is spent; the group is recorded as being created.
   */
  claimGroup(
    userDid: string,
    threadId: string,
    claim: { digest: string; requestId: string; group: PodGroupSpec },
  ): Promise<GroupClaim>;
  /**
   * End a claimed group creation: `released` lets it be previewed again;
   * `{ txHash? }` records it signed (with its transaction when known).
   */
  settleGroup(
    userDid: string,
    threadId: string,
    outcome: 'released' | { txHash?: string },
  ): Promise<void>;
  /** Record the group's core contract, read from its transaction `txHash`. */
  recordGroupCore(
    userDid: string,
    threadId: string,
    found: { txHash: string; coreAddress: string },
  ): Promise<void>;
  /**
   * Claim the link of the created group to the POD. `no-pod`, `no-group`
   * (none created), `no-core` (its address not read yet) or `claimed` (being
   * linked, or linked) refuse.
   */
  claimGroupLink(userDid: string, threadId: string): Promise<GroupLinkClaim>;
  /** End a claimed link: `linked` keeps it closed, `released` lets it run again. */
  settleGroupLink(
    userDid: string,
    threadId: string,
    outcome: 'linked' | 'released',
  ): Promise<void>;
  /** Drop the session (the design was restarted). */
  clear(userDid: string, threadId: string): Promise<void>;
}

/** The session as the create tools read it. */
export interface CreateSessionView {
  /** The prepared batch while it holds an approval not spent yet. */
  approvedBlobId?: string;
  sent?: SentPodBatch;
  confirmed?: { podDid: string; txHash: string };
  /** The confirmed POD's governance group, once its creation was claimed. */
  group?: PodGroupView;
}

/** A POD's governance group as the session keeps it. */
export interface PodGroupView {
  group: PodGroupSpec;
  /** `sending`: the wallet was asked and its answer is not known; `created`: signed. */
  state: 'sending' | 'created';
  txHash?: string;
  coreAddress?: string;
  link?: 'sending' | 'linked';
}

export type CardClaim =
  | { status: 'ok'; podDid: string; sent: SentPodBatch }
  | { status: 'no-pod' }
  | { status: 'claimed'; state: 'sending' | 'added' };

export type GroupPreviewOutcome = 'ok' | 'no-pod' | 'claimed';

export type GroupClaim =
  | { status: 'ok'; podDid: string }
  | { status: 'no-pod' | 'not-previewed' | 'same-request' }
  | { status: 'claimed'; state: PodGroupView['state'] };

export type GroupLinkClaim =
  | {
      status: 'ok';
      podDid: string;
      group: PodGroupSpec;
      coreAddress: string;
    }
  | { status: 'no-pod' | 'no-group' | 'no-core' }
  | { status: 'claimed'; state: 'sending' | 'linked' };

/** Resolves the create-session store for one request (it lives in the user's database). */
export type CreateSessionStoreFor = (ctx: RuntimeContext) => CreateSessionStore;

export type ApproveOutcome = 'approved' | 'not-prepared' | 'same-request';

/** `ctx.kv` namespace holding one create session per (user, thread). */
export const CREATE_SESSION_NAMESPACE = 'pod-creator/create-sessions';

const sentSchema = z.object({
  messages: z.array(ITrxMsgSchema),
  profile: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
});

const createSessionSchema = z.object({
  preparedBlobId: z.string(),
  /** The request (turn) that prepared the batch. */
  preparedRequestId: z.string(),
  approved: z.boolean(),
  /** What the last sign request of the prepared batch carried. */
  sent: sentSchema.optional(),
  /** The POD confirmed from `sent`. */
  confirmed: z.object({ podDid: z.string(), txHash: z.string() }).optional(),
  /** The confirmed POD's domain card: being added (claimed), or added. */
  card: z.enum(['sending', 'added']).optional(),
  /** The confirmed POD's governance group, from its preview to its link. */
  group: z
    .object({
      /** The group shown to the user, and the request that showed it. */
      preview: z
        .object({ digest: z.string(), requestId: z.string() })
        .optional(),
      /** Set once its creation is claimed. */
      created: z
        .object({
          group: z.object({
            name: z.string(),
            members: z.array(z.string()),
            threshold: z.number(),
            // A group claimed before these were chosen had the Portal's rules.
            votingPeriodSeconds: z
              .number()
              .default(DAODAO_VOTING_PERIOD_SECONDS.default),
            allowRevoting: z.boolean().default(DAODAO_DEFAULT_ALLOW_REVOTING),
          }),
          state: z.enum(['sending', 'created']),
          txHash: z.string().optional(),
          coreAddress: z.string().optional(),
          link: z.enum(['sending', 'linked']).optional(),
        })
        .optional(),
    })
    .optional(),
});

type CreateSession = z.infer<typeof createSessionSchema>;

/** Mirrors the blob store's default TTL — the approval is useless without the blob. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

export interface KvCreateSessionStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

/** A JSON pair cannot collide the way a joined string could. */
const key = (userDid: string, threadId: string): string =>
  JSON.stringify([userDid, threadId]);

/**
 * A stored session that no longer parses is treated as no session: the only
 * consequence is that the user has to prepare the batch again, which is the
 * safe direction for an approval gate.
 */
function parseSession(value: unknown): CreateSession | undefined {
  const parsed = createSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * {@link CreateSessionStore} over the host's `ctx.kv` rows in the user's own
 * database, so a prepared or approved batch survives the user object being
 * evicted between the user's "yes" and the sign request. Each transition is
 * one atomic read-modify-write.
 */
export class KvCreateSessionStore implements CreateSessionStore {
  private readonly writeOptions: { idleTtlMs: number; maxEntries: number };

  constructor(
    private readonly kv: UserKvSurface,
    options: KvCreateSessionStoreOptions = {},
  ) {
    this.writeOptions = {
      idleTtlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    };
  }

  async prepared(
    userDid: string,
    threadId: string,
    blobId: string,
    requestId: string,
  ): Promise<void> {
    const session: CreateSession = {
      preparedBlobId: blobId,
      preparedRequestId: requestId,
      approved: false,
    };
    await this.kv.set(
      CREATE_SESSION_NAMESPACE,
      key(userDid, threadId),
      session,
      this.writeOptions,
    );
  }

  async approve(
    userDid: string,
    threadId: string,
    blobId: string,
    requestId: string,
  ): Promise<ApproveOutcome> {
    let outcome: ApproveOutcome = 'not-prepared';
    await this.kv.update(
      CREATE_SESSION_NAMESPACE,
      key(userDid, threadId),
      (current) => {
        const session = parseSession(current);
        if (!session || session.preparedBlobId !== blobId) {
          outcome = 'not-prepared';
          return session;
        }
        if (session.preparedRequestId === requestId) {
          outcome = 'same-request';
          return session;
        }
        outcome = 'approved';
        return { ...session, approved: true };
      },
      this.writeOptions,
    );
    return outcome;
  }

  async consume(
    userDid: string,
    threadId: string,
    blobId: string,
    sent?: SentPodBatch,
  ): Promise<boolean> {
    let spent = false;
    await this.kv.update(
      CREATE_SESSION_NAMESPACE,
      key(userDid, threadId),
      (current) => {
        const session = parseSession(current);
        spent =
          session !== undefined &&
          session.preparedBlobId === blobId &&
          session.approved;
        if (!session || !spent) return session;
        return {
          ...session,
          approved: false,
          ...(sent !== undefined ? { sent } : {}),
        };
      },
      this.writeOptions,
    );
    return spent;
  }

  async read(
    userDid: string,
    threadId: string,
  ): Promise<CreateSessionView | undefined> {
    const session = parseSession(
      await this.kv.get(CREATE_SESSION_NAMESPACE, key(userDid, threadId)),
    );
    if (!session) return undefined;
    return {
      ...(session.approved ? { approvedBlobId: session.preparedBlobId } : {}),
      ...(session.sent ? { sent: session.sent } : {}),
      ...(session.confirmed ? { confirmed: session.confirmed } : {}),
      ...(session.group?.created ? { group: session.group.created } : {}),
    };
  }

  async confirmed(
    userDid: string,
    threadId: string,
    pod: { podDid: string; txHash: string },
  ): Promise<void> {
    await this.kv.update(
      CREATE_SESSION_NAMESPACE,
      key(userDid, threadId),
      (current) => {
        const session = parseSession(current);
        if (!session?.sent) return session;
        // The card and the group belong to the POD: another confirmed POD
        // starts afresh.
        const samePod = session.confirmed?.podDid === pod.podDid;
        const { card: _card, group: _group, ...rest } = session;
        return {
          ...(samePod ? session : rest),
          confirmed: { podDid: pod.podDid, txHash: pod.txHash },
        };
      },
      this.writeOptions,
    );
  }

  async claimCard(userDid: string, threadId: string): Promise<CardClaim> {
    let claim: CardClaim = { status: 'no-pod' };
    await this.kv.update(
      CREATE_SESSION_NAMESPACE,
      key(userDid, threadId),
      (current) => {
        const session = parseSession(current);
        if (!session?.confirmed || !session.sent) {
          claim = { status: 'no-pod' };
          return session;
        }
        if (session.card) {
          claim = { status: 'claimed', state: session.card };
          return session;
        }
        claim = {
          status: 'ok',
          podDid: session.confirmed.podDid,
          sent: session.sent,
        };
        return { ...session, card: 'sending' };
      },
      this.writeOptions,
    );
    return claim;
  }

  async settleCard(
    userDid: string,
    threadId: string,
    outcome: 'added' | 'released',
  ): Promise<void> {
    await this.kv.update(
      CREATE_SESSION_NAMESPACE,
      key(userDid, threadId),
      (current) => {
        const session = parseSession(current);
        if (!session || session.card !== 'sending') return session;
        if (outcome === 'added') return { ...session, card: 'added' };
        const { card: _card, ...rest } = session;
        return rest;
      },
      this.writeOptions,
    );
  }

  /** One atomic read-modify-write of the session's group, with what the step decided. */
  private async updateGroup<T>(
    userDid: string,
    threadId: string,
    fallback: T,
    step: (
      session: CreateSession,
    ) => { outcome: T; group?: CreateSession['group'] } | undefined,
  ): Promise<T> {
    let outcome = fallback;
    await this.kv.update(
      CREATE_SESSION_NAMESPACE,
      key(userDid, threadId),
      (current) => {
        const session = parseSession(current);
        if (!session) return session;
        const decided = step(session);
        if (!decided) return session;
        outcome = decided.outcome;
        if (!('group' in decided)) return session;
        const { group: _group, ...rest } = session;
        return decided.group ? { ...rest, group: decided.group } : rest;
      },
      this.writeOptions,
    );
    return outcome;
  }

  previewGroup(
    userDid: string,
    threadId: string,
    preview: { digest: string; requestId: string },
  ): Promise<GroupPreviewOutcome> {
    return this.updateGroup<GroupPreviewOutcome>(
      userDid,
      threadId,
      'no-pod',
      (session) => {
        if (!session.confirmed) return undefined;
        if (session.group?.created) return { outcome: 'claimed' };
        return { outcome: 'ok', group: { preview } };
      },
    );
  }

  claimGroup(
    userDid: string,
    threadId: string,
    claim: { digest: string; requestId: string; group: PodGroupSpec },
  ): Promise<GroupClaim> {
    return this.updateGroup<GroupClaim>(
      userDid,
      threadId,
      { status: 'no-pod' },
      (session) => {
        const { confirmed, group } = session;
        if (!confirmed) return undefined;
        if (group?.created)
          return {
            outcome: { status: 'claimed', state: group.created.state },
          };
        if (group?.preview?.digest !== claim.digest)
          return { outcome: { status: 'not-previewed' } };
        if (group.preview.requestId === claim.requestId)
          return { outcome: { status: 'same-request' } };
        return {
          outcome: { status: 'ok', podDid: confirmed.podDid },
          group: { created: { group: claim.group, state: 'sending' } },
        };
      },
    );
  }

  async settleGroup(
    userDid: string,
    threadId: string,
    outcome: 'released' | { txHash?: string },
  ): Promise<void> {
    await this.updateGroup(userDid, threadId, undefined, (session) => {
      const created = session.group?.created;
      if (created?.state !== 'sending') return undefined;
      if (outcome === 'released')
        return { outcome: undefined, group: undefined };
      return {
        outcome: undefined,
        group: {
          created: {
            ...created,
            state: 'created',
            ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
          },
        },
      };
    });
  }

  async recordGroupCore(
    userDid: string,
    threadId: string,
    found: { txHash: string; coreAddress: string },
  ): Promise<void> {
    await this.updateGroup(userDid, threadId, undefined, (session) => {
      const created = session.group?.created;
      if (!created || created.coreAddress !== undefined) return undefined;
      return {
        outcome: undefined,
        group: {
          created: {
            ...created,
            state: 'created',
            txHash: found.txHash,
            coreAddress: found.coreAddress,
          },
        },
      };
    });
  }

  claimGroupLink(userDid: string, threadId: string): Promise<GroupLinkClaim> {
    return this.updateGroup<GroupLinkClaim>(
      userDid,
      threadId,
      { status: 'no-pod' },
      (session) => {
        const created = session.group?.created;
        if (!session.confirmed) return undefined;
        if (!created) return { outcome: { status: 'no-group' } };
        if (created.link)
          return { outcome: { status: 'claimed', state: created.link } };
        if (created.coreAddress === undefined)
          return { outcome: { status: 'no-core' } };
        return {
          outcome: {
            status: 'ok',
            podDid: session.confirmed.podDid,
            group: created.group,
            coreAddress: created.coreAddress,
          },
          group: { created: { ...created, link: 'sending' } },
        };
      },
    );
  }

  async settleGroupLink(
    userDid: string,
    threadId: string,
    outcome: 'linked' | 'released',
  ): Promise<void> {
    await this.updateGroup(userDid, threadId, undefined, (session) => {
      const created = session.group?.created;
      if (created?.link !== 'sending') return undefined;
      const { link: _link, ...rest } = created;
      return {
        outcome: undefined,
        group: {
          created: outcome === 'linked' ? { ...created, link: 'linked' } : rest,
        },
      };
    });
  }

  async clear(userDid: string, threadId: string): Promise<void> {
    await this.kv.delete(CREATE_SESSION_NAMESPACE, key(userDid, threadId));
  }
}
