import { BoundedMap, type BoundedMapOptions } from './bounded-map.js';

/**
 * Per-(user, thread) state machine for the create path's propose → approve →
 * commit handoff. Exactly one batch can be pending per key: `prepared`
 * supersedes anything before it, `approve` binds the user's go-ahead to that
 * exact blobId, and `consume` spends the approval — so every wallet sign
 * dispatch requires a fresh, explicit approval and a sign request can never be
 * replayed from a stale one. Keyed by user DID as well as thread so a batch
 * prepared in another thread (or by another user in a shared thread) can never
 * be approved here.
 */
export interface CreateSessionStore {
  /** Record a freshly prepared batch; any prior approval is superseded. */
  prepared(userDid: string, threadId: string, blobId: string): Promise<void>;
  /**
   * Approve the pending batch. Returns false when `blobId` is not the batch
   * prepared for this user+thread.
   */
  approve(userDid: string, threadId: string, blobId: string): Promise<boolean>;
  /**
   * Spend the approval for a sign dispatch. Returns true only when `blobId`
   * is the approved pending batch; the approval is cleared either way it
   * matches, so a second dispatch needs a fresh approve.
   */
  consume(userDid: string, threadId: string, blobId: string): Promise<boolean>;
  /** Drop the session (after on-chain confirmation). */
  clear(userDid: string, threadId: string): Promise<void>;
}

interface CreateSession {
  preparedBlobId: string;
  approved: boolean;
}

/** Mirrors the blob store's default TTL — the approval is useless without the blob. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

/** NUL can appear in neither a DID nor a Matrix event id. */
const key = (userDid: string, threadId: string): string =>
  `${userDid}\u0000${threadId}`;

/** Process-local {@link CreateSessionStore}; held on the plugin instance. */
export class InMemoryCreateSessionStore implements CreateSessionStore {
  private readonly sessions: BoundedMap<CreateSession>;

  constructor(options: Partial<BoundedMapOptions> = {}) {
    this.sessions = new BoundedMap({
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async prepared(
    userDid: string,
    threadId: string,
    blobId: string,
  ): Promise<void> {
    this.sessions.set(key(userDid, threadId), {
      preparedBlobId: blobId,
      approved: false,
    });
  }

  async approve(
    userDid: string,
    threadId: string,
    blobId: string,
  ): Promise<boolean> {
    const session = this.sessions.get(key(userDid, threadId));
    if (!session || session.preparedBlobId !== blobId) {
      return false;
    }
    session.approved = true;
    this.sessions.set(key(userDid, threadId), session);
    return true;
  }

  async consume(
    userDid: string,
    threadId: string,
    blobId: string,
  ): Promise<boolean> {
    const session = this.sessions.get(key(userDid, threadId));
    if (!session || session.preparedBlobId !== blobId || !session.approved) {
      return false;
    }
    session.approved = false;
    this.sessions.set(key(userDid, threadId), session);
    return true;
  }

  async clear(userDid: string, threadId: string): Promise<void> {
    this.sessions.delete(key(userDid, threadId));
  }
}
