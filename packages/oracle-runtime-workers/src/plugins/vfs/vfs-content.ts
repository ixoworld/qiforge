import { HumanMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';
import { MAX_MODEL_LANE_BYTES, replyText } from '../../attachments/extract';
import type { RuntimeContext } from '../../plugin-api/types';
import { bytesToBase64 } from '../base64';
import type { VfsClient, VfsContentBytes, VfsFileStat } from './vfs-client';
import { VfsContentTooLargeError, VfsHttpError } from './vfs-errors';

/** Cap on the bytes we download and base64 into the vision model. */
export const MAX_VISION_BYTES = MAX_MODEL_LANE_BYTES;

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

function isRenderableMime(mime: string): boolean {
  return mime.startsWith('image/') || isDocMime(mime);
}

/**
 * What rendering a binary produced: the model's text (`truncated` when the
 * provider stopped it at its output limit), or a metadata stub.
 */
type BinaryRendering = { text: string; truncated: boolean } | { stub: string };

/** True when the provider cut the reply at its output-token limit. */
function stoppedAtLimit(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false;
  const reason =
    'finish_reason' in metadata
      ? metadata.finish_reason
      : 'stop_reason' in metadata
        ? metadata.stop_reason
        : undefined;
  return reason === 'length' || reason === 'max_tokens';
}

/**
 * Shared body of {@link renderBinary} and {@link renderBinaryForIngestion}.
 * Returns a metadata stub without downloading when the stored size or type
 * already rules rendering out; otherwise fetches at most
 * {@link MAX_VISION_BYTES} and routes the bytes through the vision model. A
 * vision failure is a stub too; the caller decides whether a stub is
 * acceptable (`vfs_read`) or an error (ingestion).
 */
async function renderBinaryOrStub(
  client: VfsClient,
  rtCtx: RuntimeContext,
  stat: VfsFileStat,
  preloaded?: VfsContentBytes,
): Promise<BinaryRendering> {
  const name = basename(stat.path) || stat.id;
  const publicSuffix = stat.publicUrl
    ? ` — public link: ${stat.publicUrl}`
    : '';
  const tooLarge = (mime: string, size: number | string): string =>
    `[binary file "${name}" — ${mime}, ${size} bytes — too large to render (limit ${MAX_VISION_BYTES} bytes)${publicSuffix}]`;
  const storedMime = stat.mimeType || 'application/octet-stream';

  if (stat.size > MAX_VISION_BYTES)
    return { stub: tooLarge(storedMime, stat.size) };
  if (stat.mimeType && !isRenderableMime(stat.mimeType)) {
    return {
      stub: `[binary file "${name}" — ${stat.mimeType}, ${stat.size} bytes — not rendered${publicSuffix}]`,
    };
  }

  let downloaded: VfsContentBytes;
  try {
    downloaded =
      preloaded ?? (await client.contentBytes(stat.id, MAX_VISION_BYTES));
  } catch (err) {
    if (err instanceof VfsContentTooLargeError) {
      return {
        stub: tooLarge(storedMime, `more than ${MAX_VISION_BYTES}`),
      };
    }
    throw err;
  }
  const { bytes, mimeType, size } = downloaded;
  const mime = mimeType || storedMime;

  const isImage = mime.startsWith('image/');
  const isDoc = isDocMime(mime);
  if (!isImage && !isDoc) {
    return {
      stub: `[binary file "${name}" — ${mime}, ${size} bytes — not rendered${publicSuffix}]`,
    };
  }

  const base64 = bytesToBase64(new Uint8Array(bytes));
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
    const text = replyText(result.content);
    if (text.trim().length > 0) {
      return { text, truncated: stoppedAtLimit(result.response_metadata) };
    }
    return {
      stub: `[${isImage ? 'image' : 'document'} "${name}" — ${mime}, ${size} bytes — no description returned${publicSuffix}]`,
    };
  } catch (err) {
    rtCtx.logger.warn(
      `[vfs] vision render failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      stub: `[${isImage ? 'image' : 'document'} "${name}" — ${mime}, ${size} bytes — could not be rendered${publicSuffix}]`,
    };
  }
}

/**
 * Read a non-text file for the agent: the vision model's description or
 * transcription, or a metadata stub when the file cannot be rendered.
 */
async function renderBinary(
  client: VfsClient,
  rtCtx: RuntimeContext,
  stat: VfsFileStat,
): Promise<string> {
  const rendered = await renderBinaryOrStub(client, rtCtx, stat);
  return 'text' in rendered ? rendered.text : rendered.stub;
}

/**
 * Like {@link renderBinary} for callers that need the file's real text (the
 * memory plugin's document ingestion): a file that is too large, not
 * renderable or that the vision model fails on throws instead of returning a
 * stub, so a stub is never mistaken for the document's content. Pass
 * `preloaded` when the bytes are already in hand (no second download);
 * `truncated` reports a reply the provider cut at its output limit.
 */
export async function renderBinaryForIngestion(
  client: VfsClient,
  rtCtx: RuntimeContext,
  stat: VfsFileStat,
  preloaded?: VfsContentBytes,
): Promise<{ text: string; truncated: boolean }> {
  const rendered = await renderBinaryOrStub(client, rtCtx, stat, preloaded);
  if ('text' in rendered) return rendered;
  throw new Error(rendered.stub);
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
