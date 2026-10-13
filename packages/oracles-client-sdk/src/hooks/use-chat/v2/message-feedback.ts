import type {
  AnonymousMessageFeedbackResponse,
  AnonymousMessageFeedbackSubmission,
  ChatCapabilities,
} from './types.js';

type AuthedRequest = <T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  options?: RequestInit,
  oracleDid?: string,
) => Promise<T>;

/**
 * `POST /messages/:sessionId/:messageId/feedback` — one anonymous feedback
 * submission. Sends exactly the submission and nothing else; the message
 * list is neither changed nor refetched.
 */
export async function submitAnonymousMessageFeedback({
  apiUrl,
  sessionId,
  messageId,
  submission,
  oracleDid,
  authedRequest,
}: {
  apiUrl: string;
  sessionId: string;
  messageId: string;
  submission: AnonymousMessageFeedbackSubmission;
  oracleDid: string;
  authedRequest: AuthedRequest;
}): Promise<AnonymousMessageFeedbackResponse> {
  const body: AnonymousMessageFeedbackSubmission = {
    submissionId: submission.submissionId,
    feedback: submission.feedback,
    context: submission.context,
  };
  return authedRequest<AnonymousMessageFeedbackResponse>(
    `${apiUrl}/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/feedback`,
    'POST',
    { body: JSON.stringify(body) },
    oracleDid,
  );
}

/** Runtimes that predate the feature (or have it off) omit the flag. */
export function isAnonymousMessageFeedbackCapabilitySupported(
  capabilities?: ChatCapabilities,
): boolean {
  return capabilities?.anonymousMessageFeedback === true;
}
