import { HumanMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';
import type { RuntimeContext } from '../../plugin-api/types.js';
import type { VfsClient, VfsFileStat } from './vfs-client.js';
import { VfsHttpError } from './vfs-errors.js';

/** Cap on the bytes we base64 into the vision model. */
const MAX_VISION_BYTES = 10 * 1024 * 1024;

/** MIME types that are text even though they don't start with `text/`. */
const TEXT_MIME_EXACT = new Set<string>([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/csv',
  'application/x-ndjson',
  'application/x-sh',
  'image/svg+xml',
]);

export function isTextMime(mime: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith('text/')) return true;
  if (m.endsWith('+json') || m.endsWith('+xml')) return true;
  return TEXT_MIME_EXACT.has(m);
}

function isDocMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return (
    m === 'application/pdf' ||
    m.startsWith('application/vnd.openxmlformats') ||
    m.startsWith('application/vnd.oasis') ||
    m === 'application/msword'
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Render a text window for the agent. The VFS already returns display-ready
 * numbered text (cat -n style), so we pass it through and only append a
 * continuation footer when there are more lines to page.
 */
function renderTextWindow(
  text: string,
  offset: number,
  count: number,
  hasMore: boolean,
  totalLines: number,
): string {
  if (text.trim().length === 0) return '(empty file)';
  if (!hasMore) return text;

  const nextOffset = offset + count;
  return `${text}\n… more lines below (${totalLines} total). Call vfs_read again with offset=${nextOffset} to continue.`;
}

/**
 * Read a non-text file for the agent. Fetches the bytes, then either returns a
 * size stub (too large / unsupported binary) or routes the bytes through the
 * vision model and returns its description/transcription. Never throws — a
 * vision failure degrades to a metadata stub.
 */
async function renderBinary(
  client: VfsClient,
  rtCtx: RuntimeContext,
  stat: VfsFileStat,
): Promise<string> {
  const { bytes, mimeType, size } = await client.contentBytes(stat.id);
  const name = basename(stat.path) || stat.id;
  const mime = mimeType || stat.mimeType || 'application/octet-stream';
  const publicSuffix = stat.publicUrl
    ? ` — public link: ${stat.publicUrl}`
    : '';

  if (size > MAX_VISION_BYTES) {
    return `[binary file "${name}" — ${mime}, ${size} bytes — too large to render${publicSuffix}]`;
  }

  const isImage = mime.startsWith('image/');
  const isDoc = isDocMime(mime);
  if (!isImage && !isDoc) {
    return `[binary file "${name}" — ${mime}, ${size} bytes — not rendered${publicSuffix}]`;
  }

  const base64 = Buffer.from(bytes).toString('base64');
  const prompt = isImage
    ? 'Describe this image in detail and transcribe any text visible in it. Be factual and thorough.'
    : 'Extract and transcribe the full text content of this document, preserving structure and headings where possible.';
  // langchain 1.x standard "data content blocks". The @langchain/openai
  // completions converter (the OpenRouter path) only recognises these when they
  // carry `source_type: 'base64'` + snake_case `mime_type` — it emits
  // `image_url: data:<mime_type>;base64,<data>` (and `file_data` for files).
  // Omitting source_type / using camelCase makes the block unrecognised and the
  // image never reaches the model.
  const mediaBlock = isImage
    ? { type: 'image', source_type: 'base64', mime_type: mime, data: base64 }
    : {
        type: 'file',
        source_type: 'base64',
        mime_type: mime,
        data: base64,
        filename: name,
      };
  const content: MessageContent = [{ type: 'text', text: prompt }, mediaBlock];

  try {
    const model = rtCtx.llm.get('vision');
    const result = await model.invoke([new HumanMessage({ content })], {
      signal: rtCtx.abortSignal,
    });
    const text =
      typeof result.content === 'string'
        ? result.content
        : String(result.content);
    if (text.trim().length > 0) return text;
    return `[${isImage ? 'image' : 'document'} "${name}" — ${mime}, ${size} bytes — no description returned${publicSuffix}]`;
  } catch (err) {
    rtCtx.logger.warn(
      `[vfs] vision render failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return `[${isImage ? 'image' : 'document'} "${name}" — ${mime}, ${size} bytes — could not be rendered${publicSuffix}]`;
  }
}

/**
 * Resolve a path to a file and return content the agent can read: numbered
 * lines for text, a vision transcription for images/PDFs, or a metadata stub
 * for other binaries. Throws a `404` {@link VfsHttpError} when the path
 * doesn't resolve to a file.
 */
export async function readForAgent(
  client: VfsClient,
  rtCtx: RuntimeContext,
  path: string,
  offset: number,
  limit: number,
): Promise<string> {
  const stat = await client.statByPath(path);
  if (!stat) {
    throw new VfsHttpError({
      status: 404,
      message: `No such file at ${path}`,
      raw: '',
    });
  }

  const mime = stat.mimeType || '';
  // Clearly-binary MIME → skip the line read entirely.
  if (mime && !isTextMime(mime)) {
    return renderBinary(client, rtCtx, stat);
  }

  // Textual or unknown → attempt a windowed line read; fall back to the binary
  // path if the VFS rejects it as not-text (415).
  try {
    const win = await client.readLines(stat.id, offset, limit);
    return renderTextWindow(
      win.text,
      win.offset,
      win.count,
      win.hasMore,
      win.totalLines,
    );
  } catch (err) {
    if (err instanceof VfsHttpError && err.status === 415) {
      return renderBinary(client, rtCtx, stat);
    }
    throw err;
  }
}
