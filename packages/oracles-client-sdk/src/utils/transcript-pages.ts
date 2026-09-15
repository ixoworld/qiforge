/**
 * Paged transcript loading against the Workers runtime's
 * `GET /sessions/:id/messages` (docs/plans/transcript-paging.md), with the
 * legacy whole-transcript `GET /messages/:id` as the fallback for runtimes
 * that do not page (the Node runtime, older Workers builds).
 *
 * Pages are turn-aligned: a user message with everything the agent did until
 * the next one. The newest page comes first; `before=` walks back to the
 * first message; `after=` returns what a client missed, re-sending the turn
 * the cursor split so tool results fold into their reply again — a client
 * folds such a page in by message id.
 */
import { RequestError } from './request.js';

export const DEFAULT_HISTORY_PAGE_SIZE = 20;

export interface TranscriptPage<M extends { id: string }> {
  messages: M[];
  /** Continue older from here; null once the first message is loaded. */
  prevCursor: string | null;
  /** Continue newer from here; null while the session has no messages. */
  nextCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface HistoryPage<
  M extends { id: string },
> extends TranscriptPage<M> {
  /** Came from the legacy route: the whole transcript, nothing to page. */
  legacy?: true;
}

/** `GET` a JSON document as the oracle's authenticated client. */
export type HistoryRequest = <T>(url: string) => Promise<T>;

export interface HistoryPageQuery {
  limit: number;
  before?: string;
  after?: string;
}

const EMPTY = {
  prevCursor: null,
  nextCursor: null,
  hasOlder: false,
  hasNewer: false,
} as const;

/** A runtime without the paged route answers 404 (or 405) for it. */
function isRouteMissing(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    (error.status === 404 || error.status === 405)
  );
}

export async function fetchHistoryPage<M extends { id: string }>(
  request: HistoryRequest,
  apiUrl: string,
  sessionId: string,
  query: HistoryPageQuery,
): Promise<HistoryPage<M>> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.before) params.set('before', query.before);
  if (query.after) params.set('after', query.after);
  try {
    return await request<TranscriptPage<M>>(
      `${apiUrl}/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
    );
  } catch (error) {
    if (!isRouteMissing(error)) throw error;
    // Older or newer than "everything" is nothing.
    if (query.before || query.after)
      return { messages: [], ...EMPTY, legacy: true };
    const { messages } = await request<{ messages: M[] }>(
      `${apiUrl}/messages/${sessionId}`,
    );
    return { messages, ...EMPTY, legacy: true };
  }
}

/** The loaded pages — newest page first — as one transcript, oldest message first. */
export function flattenPages<M extends { id: string }>(
  pages: ReadonlyArray<TranscriptPage<M>>,
): M[] {
  const out: M[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1)
    out.push(...pages[i]!.messages);
  return out;
}

/**
 * What the store should show given the loaded history and what it shows now.
 * Idle, the history is the truth (the runtime's copy of the turn replaces
 * the streamed one, ids and tool results included). While a reply streams,
 * the messages the history does not know — the turn in flight — stay on top
 * of it, so an older page arriving mid-stream never drops the live reply.
 */
export function mergeHistory<M extends { id: string }>(
  history: M[],
  current: ReadonlyArray<M>,
  streaming: boolean,
): M[] {
  if (!streaming) return history;
  const known = new Set(history.map((m) => m.id));
  const inFlight = current.filter((m) => !known.has(m.id));
  return inFlight.length ? [...history, ...inFlight] : history;
}

/**
 * Fold an `after=` page into the loaded pages (newest page first): messages
 * it re-sends replace the loaded copies (same ids), the rest is appended to
 * the newest page, whose cursor moves on. Returns new page objects; the
 * input is untouched.
 */
export function appendTail<M extends { id: string }>(
  pages: ReadonlyArray<HistoryPage<M>>,
  tail: TranscriptPage<M>,
): HistoryPage<M>[] {
  if (pages.length === 0) return [{ ...tail }];
  const resent = new Set(tail.messages.map((m) => m.id));
  const kept = pages.map((page) => {
    const messages = page.messages.filter((m) => !resent.has(m.id));
    return messages.length === page.messages.length
      ? page
      : { ...page, messages };
  });
  const newest = kept[0]!;
  kept[0] = {
    ...newest,
    messages: [...newest.messages, ...tail.messages],
    nextCursor: tail.nextCursor ?? newest.nextCursor,
    hasNewer: tail.hasNewer,
  };
  return kept;
}
