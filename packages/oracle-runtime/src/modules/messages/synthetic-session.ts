/**
 * Synthetic sessions are short-lived background-agent sessions (the tasks
 * plugin's previews and fire-and-forget runs) whose id is minted locally
 * instead of being a real Matrix event id. They are real rows in the sessions
 * table — `RequestPreparer` resolves them like any session — but the id is
 * not an event in the room, so:
 *
 *  - Matrix replays must NOT use it as a thread-relation target (`M_UNKNOWN:
 *    Can't send relation to unknown event`); they post top-level instead.
 *  - The post-message session sync must skip them: it would LLM-generate a
 *    title and `editMessage` a nonexistent root event, and these threads are
 *    deleted right after the run anyway.
 *
 * Persistent task-run sessions (the conversational `before-action` runs) are
 * NOT synthetic: they're rooted at a real run-marker event the worker posts,
 * and behave like any normal session.
 */
export const SYNTHETIC_SESSION_PREFIX = '$task-';

export function isSyntheticSessionId(sessionId: string): boolean {
  return sessionId.startsWith(SYNTHETIC_SESSION_PREFIX);
}
