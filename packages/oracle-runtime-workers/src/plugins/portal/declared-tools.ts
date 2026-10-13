/**
 * Validation for the tools a browser declares in a turn body (the Portal's
 * `tools[]` and AG-UI's `agActions[]`). The declarations come from the
 * client on every request, so each request is checked on its own: the boot
 * time collision check never sees them.
 *
 * An entry is dropped (never repaired) when its name is not a valid tool
 * name, repeats an earlier entry's name, or is reserved (`reservedNames`,
 * e.g. the server's own tool names), or when its description or schema is
 * over the size cap. At most {@link MAX_DECLARED_TOOLS} entries are kept.
 */

/** Tool names the model providers accept, and nothing else. */
export const DECLARED_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Declared tools kept per request; further entries are dropped. */
export const MAX_DECLARED_TOOLS = 64;
/** Characters of one declared tool's description. */
export const MAX_DECLARED_DESCRIPTION_CHARS = 2_048;
/** Characters of one declared tool's JSON schema, serialised. */
export const MAX_DECLARED_SCHEMA_CHARS = 16_384;

export interface DeclaredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface DroppedDeclaration {
  name: string;
  reason: string;
}

function schemaLength(schema: Record<string, unknown>): number {
  try {
    return JSON.stringify(schema).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The entries that may become tools this turn, plus why the others did not. */
export function sanitizeDeclaredTools<T extends DeclaredTool>(
  entries: readonly T[],
  reservedNames: ReadonlySet<string> = new Set(),
): { kept: T[]; dropped: DroppedDeclaration[] } {
  const kept: T[] = [];
  const dropped: DroppedDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const { name } = entry;
    let reason: string | undefined;
    if (!DECLARED_TOOL_NAME_PATTERN.test(name)) reason = 'invalid name';
    else if (seen.has(name)) reason = 'duplicate name';
    else if (reservedNames.has(name)) reason = 'name taken by a server tool';
    else if (entry.description.length > MAX_DECLARED_DESCRIPTION_CHARS)
      reason = `description over ${MAX_DECLARED_DESCRIPTION_CHARS} characters`;
    else if (schemaLength(entry.schema) > MAX_DECLARED_SCHEMA_CHARS)
      reason = `schema over ${MAX_DECLARED_SCHEMA_CHARS} characters`;
    else if (kept.length >= MAX_DECLARED_TOOLS)
      reason = `more than ${MAX_DECLARED_TOOLS} tools declared`;
    if (DECLARED_TOOL_NAME_PATTERN.test(name)) seen.add(name);
    if (reason) dropped.push({ name: name.slice(0, 64), reason });
    else kept.push(entry);
  }
  return { kept, dropped };
}

/** Dropped entries named in {@link describeDropped}; the rest are counted. */
const MAX_DROPPED_NAMED = 5;

/**
 * One log line for a request's dropped declarations (`undefined` when none
 * were dropped): the count plus the first few names and reasons, so a client
 * declaring thousands of bad entries still costs one bounded line.
 */
export function describeDropped(
  kind: string,
  dropped: readonly DroppedDeclaration[],
): string | undefined {
  if (dropped.length === 0) return undefined;
  const named = dropped
    .slice(0, MAX_DROPPED_NAMED)
    .map(({ name, reason }) => `"${name}" (${reason})`)
    .join(', ');
  const more =
    dropped.length > MAX_DROPPED_NAMED
      ? ` and ${dropped.length - MAX_DROPPED_NAMED} more`
      : '';
  return `Ignoring ${dropped.length} declared ${kind}: ${named}${more}`;
}
