import type {
  ChatCapabilities,
  IMessage,
  MessageFeedback,
  MessageFeedbackResponse,
} from './types.js';

type AuthedRequest = <T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  options?: RequestInit,
  oracleDid?: string,
) => Promise<T>;

export async function persistMessageFeedback({
  apiUrl,
  sessionId,
  messageId,
  feedback,
  oracleDid,
  authedRequest,
}: {
  apiUrl: string;
  sessionId: string;
  messageId: string;
  feedback: MessageFeedback | null;
  oracleDid: string;
  authedRequest: AuthedRequest;
}): Promise<MessageFeedbackResponse> {
  const url = `${apiUrl}/messages/${sessionId}/${messageId}/feedback`;
  if (feedback === null) {
    return authedRequest<MessageFeedbackResponse>(url, 'DELETE', {}, oracleDid);
  }

  return authedRequest<MessageFeedbackResponse>(
    url,
    'PUT',
    { body: JSON.stringify({ feedback }) },
    oracleDid,
  );
}

export function isMessageFeedbackCapabilitySupported(
  capabilities?: ChatCapabilities,
): boolean {
  return capabilities?.messageFeedback === true;
}

export async function applyMessageFeedbackOptimistically({
  messages,
  messageId,
  feedback,
  updateMessage,
  persist,
  refetch,
}: {
  messages: IMessage[];
  messageId: string;
  feedback: MessageFeedback | null;
  updateMessage: (
    messageId: string,
    updater: (message: IMessage) => IMessage,
  ) => Promise<void>;
  persist: () => Promise<MessageFeedbackResponse>;
  refetch: () => Promise<unknown>;
}): Promise<void> {
  const target = messages.find((message) => message.id === messageId);
  if (!target || target.type !== 'ai') {
    throw new Error('Agent message not found');
  }

  const previousFeedback = target.feedback;
  await updateMessage(messageId, (message) => ({
    ...message,
    feedback: feedback ?? undefined,
  }));

  try {
    await persist();
  } catch (error) {
    await updateMessage(messageId, (message) => ({
      ...message,
      feedback: previousFeedback,
    }));
    throw error;
  } finally {
    await refetch();
  }
}
