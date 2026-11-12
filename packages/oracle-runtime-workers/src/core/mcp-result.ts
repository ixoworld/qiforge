import type { ToolHooks } from '@langchain/mcp-adapters';

/**
 * What the model reads from an MCP tool. `@langchain/mcp-adapters` hands a
 * plugin a result's content only: one text block becomes a plain string, and
 * `structuredContent` and `_meta` go to the tool's artifact, which a plugin's
 * call never receives. A server's text is normally the JSON of its structured
 * content (the MCP specification asks for that), so the text alone is the
 * whole result, once. {@link keepStructuredContent} keeps the structured
 * value when the text is not that copy, and gives every other block to the
 * model as text.
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

type AfterToolCall = NonNullable<ToolHooks['afterToolCall']>;
type ToolResult = Parameters<AfterToolCall>[0]['result'];
type ContentBlock = Exclude<ToolResult[0], string>[number];

/** The result's structured value as `{ value }`; `undefined` when it has none. */
function structuredValue(
  artifacts: ToolResult[1],
): { value: unknown } | undefined {
  const structured = artifacts.find(
    (artifact) => artifact.type === 'mcp_structured_content',
  );
  return structured !== undefined && 'data' in structured
    ? { value: structured.data }
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A content block as a text block. The Chat Completions API takes only text
 * parts in a tool message (`ChatCompletionToolMessageParam`), and the
 * adapters hand images, audio and resource links over as blocks
 * (`{type:'image', data, mimeType}`, `{type:'file', url}`) that
 * `@langchain/openai` sends on unconverted. A text block keeps only its text,
 * a resource link becomes its address, and anything else is named (kind and
 * mime type) instead of sent.
 */
function asTextBlock(block: ContentBlock): { type: 'text'; text: string } {
  const text = stringField(block, 'text');
  if (block.type === 'text' && text !== undefined)
    return { type: 'text', text };
  const mimeType = stringField(block, 'mimeType');
  const mime = mimeType === undefined ? '' : ` (${mimeType})`;
  const url = stringField(block, 'url');
  if (block.type === 'file' && url !== undefined) {
    const metadata = isRecord(block.metadata) ? block.metadata : {};
    const name =
      stringField(metadata, 'title') ?? stringField(metadata, 'name');
    const label = name === undefined ? '' : ` "${name}"`;
    return { type: 'text', text: `[Linked file${label}${mime}: ${url}]` };
  }
  return {
    type: 'text',
    text: `[Left out: the tool's ${block.type}${mime}. A tool result reaches the model as text only.]`,
  };
}

/**
 * The adapters' `afterToolCall` hook for every plugin's MCP server. A text
 * that is a copy of the structured value stays alone. A text that says
 * something else (a summary beside the data) gets the structured value as a
 * second text block, and a result with no content gets it as its text, so the
 * model never loses the data. A result of blocks becomes text blocks
 * ({@link asTextBlock}), one block a plain string, as the adapters give a
 * single text; the structured value is not added beside several blocks.
 */
export const keepStructuredContent: AfterToolCall = ({ result }) => {
  const [content, artifacts] = result;
  const structured = structuredValue(artifacts);
  if (typeof content === 'string') {
    if (structured === undefined || parsesTo(content, structured.value)) return;
    return {
      result: [
        [
          { type: 'text', text: content },
          { type: 'text', text: JSON.stringify(structured.value) },
        ],
        artifacts,
      ],
    };
  }
  if (content.length === 0) {
    if (structured === undefined) return;
    return { result: [JSON.stringify(structured.value), artifacts] };
  }
  const texts = content.map(asTextBlock);
  const [only] = texts;
  return {
    result: [texts.length === 1 && only ? only.text : texts, artifacts],
  };
};
