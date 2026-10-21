import { ZodError } from 'zod';
import { ActionProposalConflict } from './store';

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

/** The failures `boundedBytes` (`core/domain-context/transport`) reports. */
const TRANSPORT_FAILURES = new Set([
  'document-unavailable',
  'document-too-large',
]);

/**
 * Every failure leaving an authority read, typed. The readers throw their
 * own conclusions typed already; what is left is the transport (a fetch
 * that failed or timed out, a body too large or not JSON) and content an
 * authority answered with that this contract does not accept (a Zod
 * refusal of room state, a DID document or a chain query). The first is
 * unavailable, the second a conflict reported without the schema's issue
 * dump. Anything else is a bug and is rethrown as it was.
 */
export function typedTopicError(
  error: unknown,
): ActionProposalConflict | TopicReadUnavailable {
  if (
    error instanceof ActionProposalConflict ||
    error instanceof TopicReadUnavailable
  )
    return error;
  if (error instanceof ZodError) {
    console.warn(
      `[topic-actions] authority content rejected: ${error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
    return new ActionProposalConflict('Topic authority content is malformed');
  }
  if (error instanceof SyntaxError)
    return new TopicReadUnavailable('Topic authority answer is not JSON');
  if (
    error instanceof TypeError ||
    error instanceof DOMException ||
    (error instanceof Error && TRANSPORT_FAILURES.has(error.message))
  )
    return new TopicReadUnavailable(error.message);
  throw error;
}
