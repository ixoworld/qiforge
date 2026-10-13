import { z } from 'zod';
import type { RuntimeContext, UserKvSurface } from '../../plugin-api/types';

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
 */
export interface CreateSessionStore {
  /** Record a freshly prepared batch; any prior approval is superseded. */
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
   * Spend the approval for a sign dispatch. Returns true only when `blobId`
   * is the approved pending batch; the approval is cleared when it matches, so
   * a second dispatch needs a fresh approve.
   */
  consume(userDid: string, threadId: string, blobId: string): Promise<boolean>;
  /** Drop the session (after on-chain confirmation). */
  clear(userDid: string, threadId: string): Promise<void>;
}

/** Resolves the create-session store for one request (it lives in the user's database). */
export type CreateSessionStoreFor = (ctx: RuntimeContext) => CreateSessionStore;

export type ApproveOutcome = 'approved' | 'not-prepared' | 'same-request';

/** `ctx.kv` namespace holding one create session per (user, thread). */
export const CREATE_SESSION_NAMESPACE = 'pod-creator/create-sessions';

const createSessionSchema = z.object({
  preparedBlobId: z.string(),
  /** The request (turn) that prepared the batch. */
  preparedRequestId: z.string(),
  approved: z.boolean(),
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
        return session && spent ? { ...session, approved: false } : session;
      },
      this.writeOptions,
    );
    return spent;
  }

  async clear(userDid: string, threadId: string): Promise<void> {
    await this.kv.delete(CREATE_SESSION_NAMESPACE, key(userDid, threadId));
  }
}
