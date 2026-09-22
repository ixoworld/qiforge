/** Only the authenticated socket supplies result routing coordinates. */
export function authenticatedFrontendResult(
  sessionId: unknown,
  userDid: unknown,
  data: {
    toolCallId: string;
    sessionId?: string;
    result?: unknown;
    error?: string;
  },
) {
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    typeof userDid !== 'string' ||
    !userDid
  )
    return null;
  if (data.sessionId !== undefined && data.sessionId !== sessionId) return null;
  if (typeof data.toolCallId !== 'string' || !data.toolCallId) return null;
  return {
    sessionId,
    toolCallId: data.toolCallId,
    result: data.result,
    error: data.error,
    timestamp: new Date().toISOString(),
  };
}
