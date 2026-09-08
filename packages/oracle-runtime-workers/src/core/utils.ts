import { z } from 'zod';
import type { Logger } from '../plugin-api/types';

// ── Logger defaults ─────────────────────────────────────────────────────────

/** A logger that discards everything. The default wherever none is supplied. */
export const NOOP_LOGGER: Logger = Object.freeze({
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
});

/**
 * A `console`-backed logger whose `child()` prefixes every record with the
 * bound context (`[plugin=weather]`). Suitable for Workers, where `console`
 * output is what `wrangler tail` and the dashboard show.
 */
export function createConsoleLogger(
  bindings: Record<string, unknown> = {},
): Logger {
  const prefix = Object.entries(bindings)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  const tag = prefix.length > 0 ? `[${prefix}]` : '';
  const emit =
    (fn: (...args: unknown[]) => void) =>
    (message: unknown, ...optional: unknown[]): void => {
      if (tag) fn(tag, message, ...optional);
      else fn(message, ...optional);
    };
  return {
    log: emit(console.log),
    warn: emit(console.warn),
    error: emit(console.error),
    debug: emit(console.debug),
    verbose: emit(console.debug),
    child: (more) => createConsoleLogger({ ...bindings, ...more }),
  };
}

// ── Tool lock ───────────────────────────────────────────────────────────────

/**
 * Locks live per isolate. Keys are `${sessionId}:${toolName}` by convention,
 * so users sharing an isolate never contend — a lock only ever guards the
 * same session re-entering the same stateful tool.
 */
const activeLocks = new Set<string>();

/**
 * Acquire an exclusive lock for the given key. Throws immediately if the key
 * is already locked (another invocation is in flight). Returns a release
 * function — always call it in a `finally` block.
 *
 * @example
 * const release = acquireToolLock(`${ctx.session.id}:my_tool`);
 * try {
 *   // ... tool body
 * } finally {
 *   release();
 * }
 */
export function acquireToolLock(key: string): () => void {
  if (activeLocks.has(key)) {
    throw new Error(
      `A call to this tool is already in progress for this session. Wait for it to complete before calling again.`,
    );
  }
  activeLocks.add(key);
  return () => activeLocks.delete(key);
}

// ── Bounded maps ────────────────────────────────────────────────────────────

/**
 * Insert into a Map used as an LRU: the key moves to the back of the
 * insertion order, and the oldest entries are evicted once `maxEntries` is
 * exceeded. For isolate-lifetime caches keyed by unbounded request-derived
 * ids (threads, rooms, events), the cap is what keeps them from growing for
 * as long as the isolate lives.
 */
export function lruInsert<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  maxEntries: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Drop expired entries from a TTL map. The runtime's small lookup caches
 * check expiry lazily on read, which leaves entries for keys that are never
 * read again resident forever; calling this on each write keeps such maps
 * bounded by their active key set without a background timer.
 */
export function sweepExpired<V extends { expiresAt: number }>(
  map: Map<string, V>,
  now: number = Date.now(),
): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

// ── Client-declared tool schemas ────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `#` and `#/$defs/*` / `#/definitions/*` are the only refs `z.fromJSONSchema`
 * knows how to resolve — everything else it rejects outright.
 */
function isResolvableByZod(ref: string): boolean {
  return ref === '#' || /^#\/(?:\$defs|definitions)\//.test(ref);
}

/** Decode the `~1` / `~0` escapes defined by RFC 6901. */
function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolvePointer(root: JsonRecord, ref: string): unknown {
  const segments = ref.slice(1).split('/').filter(Boolean).map(decodeSegment);
  let node: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      node = node[index];
    } else if (isRecord(node)) {
      node = node[segment];
    } else {
      return undefined;
    }
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Ceiling on how many pointers a single schema may expand. Inlining duplicates
 * subtrees, so a schema built from many cross-referencing pointers can grow
 * super-linearly; past this point the remaining refs are dropped rather than
 * expanded. Far above what a real tool schema needs.
 */
const MAX_EXPANSIONS = 1_000;

interface InlineState {
  /** Pointers currently being expanded — guards self-referential targets. */
  active: Set<string>;
  expansions: number;
}

function inline(node: unknown, root: JsonRecord, state: InlineState): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => inline(item, root, state));
  }
  if (!isRecord(node)) return node;

  const inlinedSiblings: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref') continue;
    inlinedSiblings[key] = inline(value, root, state);
  }

  const ref = node.$ref;
  if (typeof ref !== 'string') {
    if ('$ref' in node) inlinedSiblings.$ref = ref;
    return inlinedSiblings;
  }
  // Leave refs zod handles itself, and external refs (it raises its own,
  // clearer error for those).
  if (isResolvableByZod(ref) || !ref.startsWith('#')) {
    inlinedSiblings.$ref = ref;
    return inlinedSiblings;
  }
  // A pointer whose target contains the pointer would expand forever. Drop the
  // constraint — an unconstrained value still validates.
  if (state.active.has(ref)) return inlinedSiblings;
  if (state.expansions >= MAX_EXPANSIONS) return inlinedSiblings;

  const target = resolvePointer(root, ref);
  if (!isRecord(target)) return inlinedSiblings;

  state.expansions += 1;
  state.active.add(ref);
  const expanded = inline(target, root, state);
  state.active.delete(ref);

  return isRecord(expanded)
    ? { ...expanded, ...inlinedSiblings }
    : inlinedSiblings;
}

/**
 * Replace every local JSON-pointer `$ref` with the subschema it points at.
 *
 * `zod-to-json-schema` defaults to `$refStrategy: "root"`, so a subschema that
 * appears more than once in a tool's schema is emitted once and every later
 * occurrence becomes a pointer back into the document
 * (`#/properties/ops/items/anyOf/2/properties/questionId`). Those pointers are
 * valid JSON Schema but unresolvable by `z.fromJSONSchema`, so inline them
 * before conversion.
 */
export function inlineLocalJsonPointerRefs(schema: JsonRecord): JsonRecord {
  const inlined = inline(schema, schema, { active: new Set(), expansions: 0 });
  return isRecord(inlined) ? inlined : schema;
}

/**
 * Convert a client-declared JSON Schema (browser tool / AG-UI action) into a
 * Zod schema.
 *
 * Returns `null` when the schema cannot be converted. Callers must skip that
 * tool: these hooks run inside `collectRequest`, where one malformed client
 * schema must not be allowed to take the request down with it.
 */
export function clientSchemaToZod(
  schema: JsonRecord,
  toolName: string,
  logger: Logger = NOOP_LOGGER,
): z.ZodType | null {
  try {
    return z.fromJSONSchema(inlineLocalJsonPointerRefs(schema));
  } catch (error) {
    logger.error(
      `Skipping client-declared tool "${toolName}": its JSON Schema could not be converted to Zod — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
