/**
 * Thread root of an inbound message — the port of the Node listener bridge's
 * `getThreadRoot`, and with it Node's rule for room conversations: EVERY
 * message has a thread root, and that root is the session.
 *
 *  - a message inside a thread (`m.thread`) → the thread's root;
 *  - a bare message (no relation) → the message itself: the reply opens a
 *    thread on it, and later replies in that thread continue the session;
 *  - a quote-reply (`m.in_reply_to` without `m.thread`, from a client that
 *    does not thread natively) → walk the reply chain upward until an event
 *    that carries `m.thread` (→ its root) or a bare event (→ that event).
 *
 * The walk ends where Node's does: on a cycle, on an event that cannot be
 * fetched, or past the hop bound, the last event reached is the root.
 * Results are memoised per event id with a bounded cache.
 */

export interface MatrixRelatesTo {
  rel_type?: string;
  event_id?: string;
  'm.in_reply_to'?: { event_id?: string };
}

export function readRelatesTo(content: unknown): MatrixRelatesTo | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const rel = (content as Record<string, unknown>)['m.relates_to'];
  return typeof rel === 'object' && rel !== null ? rel : undefined;
}

export function threadRootOf(rel: MatrixRelatesTo | undefined): string | null {
  return rel?.rel_type === 'm.thread' && typeof rel.event_id === 'string'
    ? rel.event_id
    : null;
}

export function inReplyToOf(rel: MatrixRelatesTo | undefined): string | null {
  const id = rel?.['m.in_reply_to']?.event_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Bounded event-id → thread-root memo. */
export class ThreadRootCache {
  private readonly map = new Map<string, string>();

  constructor(private readonly capacity = 500) {}

  get(eventId: string): string | undefined {
    return this.map.get(eventId);
  }

  set(eventId: string, root: string): void {
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(eventId, root);
  }
}

export interface ResolveReplyChainInput {
  eventId: string;
  /** The event's own relation (from the clear or wire content); undefined for a bare message. */
  relatesTo: MatrixRelatesTo | undefined;
  /** Fetches a room event's `m.relates_to` (null when the event is unavailable). */
  fetchRelatesTo: (eventId: string) => Promise<MatrixRelatesTo | null>;
  cache: ThreadRootCache;
  /** Upper bound on the walk (Node has none beyond the visited set). */
  maxHops?: number;
}

/**
 * The thread root of the event (see the module comment). Never throws: a
 * fetch failure ends the walk at the event that could not be fetched.
 */
export async function resolveReplyChainRoot(
  input: ResolveReplyChainInput,
): Promise<string> {
  const { eventId, relatesTo, fetchRelatesTo, cache } = input;
  const maxHops = input.maxHops ?? 25;
  const remember = (ids: string[], root: string): string => {
    for (const id of ids) cache.set(id, root);
    return root;
  };

  const own = threadRootOf(relatesTo);
  if (own) return remember([eventId], own);
  const firstParent = inReplyToOf(relatesTo);
  // A bare message roots its own thread.
  if (!firstParent) return remember([eventId], eventId);

  const path = [eventId];
  const visited = new Set<string>([eventId]);
  let cursor: string = firstParent;
  let hops = 0;
  for (;;) {
    visited.add(cursor);
    path.push(cursor);
    const known = cache.get(cursor);
    if (known !== undefined) return remember(path, known);
    let parentRel: MatrixRelatesTo | null;
    try {
      parentRel = await fetchRelatesTo(cursor);
    } catch {
      parentRel = null;
    }
    // Unavailable: the quoted event is the best root there is (Node's
    // fallback is the last cursor as well).
    if (parentRel === null) return remember(path, cursor);
    const parentRoot = threadRootOf(parentRel);
    if (parentRoot) return remember(path, parentRoot);
    const next = inReplyToOf(parentRel);
    // A bare ancestor is the root of the chain.
    if (!next) return remember(path, cursor);
    hops += 1;
    if (visited.has(next) || hops >= maxHops) return remember(path, cursor);
    cursor = next;
  }
}
