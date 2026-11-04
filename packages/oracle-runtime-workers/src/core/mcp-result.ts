/**
 * `@langchain/mcp-adapters` answers a tool that returns `structuredContent`
 * with one block holding the text and the structured value side by side, and
 * a tool's non-string result is stringified for the model. A server's text
 * block is normally the JSON of its structured content (the MCP specification
 * asks for that), so the model reads the whole result twice, the first copy
 * with every quote escaped.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two JSON values are equal, whatever the order of their keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a))
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && sameJson(a[key], b[key]))
    );
  }
  return a === b;
}

function parsesTo(text: string, value: unknown): boolean {
  try {
    return sameJson(JSON.parse(text), value);
  } catch {
    return false;
  }
}

/**
 * A tool's output without a structured copy of its text. Only an exact copy
 * goes: a server whose text says something else (a summary beside the data)
 * keeps both, and a block with `meta` keeps it. Anything else passes through.
 */
export function withoutStructuredCopy(output: unknown): unknown {
  if (
    !isRecord(output) ||
    output.type !== 'text' ||
    typeof output.text !== 'string' ||
    !parsesTo(output.text, output.structuredContent)
  )
    return output;
  const { structuredContent: _copy, ...block } = output;
  return 'meta' in block ? block : block.text;
}
