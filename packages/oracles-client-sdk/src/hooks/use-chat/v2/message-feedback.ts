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
  return authedRequest<AnonymousMessageFeedbackResponse>(
    `${apiUrl}/messages/${sessionId}/${messageId}/feedback`,
    'POST',
    { body: JSON.stringify(submission) },
    oracleDid,
  );
}

export function isAnonymousMessageFeedbackCapabilitySupported(
  capabilities?: ChatCapabilities,
): boolean {
  return capabilities?.anonymousMessageFeedback === true;
}
