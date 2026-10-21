/**
 * A room, DID or chain read that failed, timed out or came back oversized.
 * Nothing about the card or its authority is known to have changed; the
 * caller retries later. The shell answers it with 503 and a generic message,
 * the reason stays in the log. Everything the reads DID establish about a
 * card having changed is an `ActionProposalConflict` (409) instead, and any
 * other error is a bug that surfaces as one.
 */
export class TopicReadUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TopicReadUnavailable';
  }
}
