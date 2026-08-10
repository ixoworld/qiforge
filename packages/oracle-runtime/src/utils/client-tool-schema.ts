import { Logger } from '@nestjs/common';
import { z } from 'zod';

const logger = new Logger('ClientToolSchema');

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
 * tool: these hooks run inside `collectRequest`, where a rejection fails the
 * whole collection and kills the turn, so one malformed client schema must not
 * be allowed to take the request down with it.
 */
export function clientSchemaToZod(
  schema: JsonRecord,
  toolName: string,
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
