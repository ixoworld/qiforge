/**
 * Quote-reply → thread resolution — the port of the Node listener bridge's
 * `getThreadRoot`. A client that quote-replies (`m.in_reply_to`) to a
 * message that lives in a thread, without adding the `m.thread` relation
 * itself, still means "continue that thread": walk the reply chain upward
 * until an event that carries `m.thread` (→ its root) or a bare event.
 *
 * Unlike Node — where every bare room message opens its own thread-session —
 * this runtime keeps the main timeline as ONE session (`matrix:<roomId>`), so
 * a chain that ends on a bare event resolves to "no thread" (main timeline)
 * rather than to that event. Results are memoised per event id with a
 * bounded cache; cycles and missing events terminate the walk.
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

/** Bounded event-id → thread-root ('' = main timeline) memo. */
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
  /** The event's own relation (from the clear or wire content). */
  relatesTo: MatrixRelatesTo | undefined;
  /** Fetches a room event's `m.relates_to` (null when the event is unavailable). */
  fetchRelatesTo: (eventId: string) => Promise<MatrixRelatesTo | null>;
  cache: ThreadRootCache;
  /** Upper bound on the walk (Node has none beyond the visited set). */
  maxHops?: number;
}

/**
 * Thread root for the event, or `null` for the main timeline. Never throws:
 * a fetch failure ends the walk at the last known event (→ main timeline).
 */
export async function resolveReplyChainRoot(
  input: ResolveReplyChainInput,
): Promise<string | null> {
  const { eventId, relatesTo, fetchRelatesTo, cache } = input;
  const maxHops = input.maxHops ?? 25;
  const remember = (ids: string[], root: string | null): string | null => {
    for (const id of ids) cache.set(id, root ?? '');
    return root;
  };

  const own = threadRootOf(relatesTo);
  if (own) return remember([eventId], own);
  const firstParent = inReplyToOf(relatesTo);
  if (!firstParent) return remember([eventId], null);

  const path = [eventId];
  const visited = new Set<string>([eventId]);
  let cursor: string | null = firstParent;
  let hops = 0;
  while (cursor && !visited.has(cursor) && hops < maxHops) {
    hops += 1;
    visited.add(cursor);
    path.push(cursor);
    const known = cache.get(cursor);
    if (known !== undefined) return remember(path, known === '' ? null : known);
    let parentRel: MatrixRelatesTo | null;
    try {
      parentRel = await fetchRelatesTo(cursor);
    } catch {
      parentRel = null;
    }
    if (parentRel === null) return remember(path, null);
    const parentRoot = threadRootOf(parentRel);
    if (parentRoot) return remember(path, parentRoot);
    cursor = inReplyToOf(parentRel);
  }
  return remember(path, null);
}
