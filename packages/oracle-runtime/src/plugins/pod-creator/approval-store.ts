/**
 * Tracks which prepared batch a user has explicitly approved for signing, per
 * design thread. `request_pod_signature` consults this so the wallet sign action
 * is never emitted for a batch the user has not approved. One pending approval
 * per thread — preparing a fresh batch supersedes any earlier approval.
 *
 * Injected (like the blueprint store) so a durable backend can replace the
 * in-memory default without touching the create tools.
 */
export interface ApprovalStore {
  /** Record the user's approval of a specific prepared batch for a thread. */
  approve(threadId: string, blobId: string): Promise<void>;
  /** True only when `blobId` is the thread's currently approved batch. */
  isApproved(threadId: string, blobId: string): Promise<boolean>;
  /** Drop any pending approval (a fresh prepare supersedes the old one). */
  clear(threadId: string): Promise<void>;
}

/** Process-local {@link ApprovalStore}; held on the plugin instance. */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly approved = new Map<string, string>();

  async approve(threadId: string, blobId: string): Promise<void> {
    this.approved.set(threadId, blobId);
  }

  async isApproved(threadId: string, blobId: string): Promise<boolean> {
    return this.approved.get(threadId) === blobId;
  }

  async clear(threadId: string): Promise<void> {
    this.approved.delete(threadId);
  }
}
