/**
 * Where the memory plugin's document tools get a document's text from: a chat
 * attachment of the session (through the host's `AttachmentViewSurface`) or a
 * file in the user's VFS. Both lanes return the document's own words — plain
 * text decoded locally, a PDF's text layer parsed locally, anything else (a
 * scan, an image, an Office file) transcribed by the helper model — never a
 * stub or a `[Content of …]` wrapper.
 *
 * Every error thrown here carries a message meant for the person (the tools
 * relay it as is).
 */
import { capText } from '../../attachments/extract';
import { extractPdfText } from '../../attachments/pdf-text';
import type { RuntimeContext } from '../../plugin-api/types';
import type { VfsClient, VfsContentBytes } from '../vfs/vfs-client';
import { mapVfsError, VfsAuthError, VfsHttpError } from '../vfs/vfs-errors';
import {
  isTextMime,
  MAX_VISION_BYTES,
  renderBinaryForIngestion,
} from '../vfs/vfs-content';
import { buildClient } from '../vfs/vfs-tools';
import { resolveVfsConfig, type VfsConfig } from '../vfs/vfs.plugin';

export type DocumentSource = { attachment_ref: string } | { vfs_path: string };

export interface LoadedDocument {
  text: string;
  filename: string;
  mimetype: string;
  /** Size of the original file in bytes (of the text when the host did not report it). */
  bytes: number;
  method: 'text' | 'pdf' | 'model';
  /** Page count, set when the text came from a PDF's text layer. */
  pages?: number;
  /** True when the text was cut at `maxChars`. */
  truncated: boolean;
}

export interface DocumentSourceDeps {
  /** Longest text returned (characters); more is cut and reported as `truncated`. */
  maxChars: number;
  /** Injected transport for the VFS client (tests). */
  fetchImpl?: typeof fetch;
  /** Retry backoff forwarded to the VFS client (tests pass `0`). */
  retryDelayMs?: number;
}

const PDF_MIME = 'application/pdf';

const LIBRARY_DISABLED = 'Library files are not enabled on this oracle.';

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireText(loaded: LoadedDocument): LoadedDocument {
  if (loaded.text.trim().length === 0) {
    throw new Error(
      `No text could be extracted from "${loaded.filename}" (${loaded.mimetype}).`,
    );
  }
  return loaded;
}

export async function loadDocumentText(
  ctx: RuntimeContext,
  source: DocumentSource,
  deps: DocumentSourceDeps,
): Promise<LoadedDocument> {
  return requireText(
    'attachment_ref' in source
      ? await loadAttachment(ctx, source.attachment_ref, deps)
      : await loadVfsFile(ctx, source.vfs_path, deps),
  );
}

async function loadAttachment(
  ctx: RuntimeContext,
  ref: string,
  deps: DocumentSourceDeps,
): Promise<LoadedDocument> {
  if (!ctx.attachments) {
    throw new Error(
      'Chat attachments cannot be read from this session; use a file from the Library (vfs_path) instead.',
    );
  }
  let extracted: Awaited<ReturnType<typeof ctx.attachments.extractText>>;
  try {
    extracted = await ctx.attachments.extractText(ref, {
      maxChars: deps.maxChars,
    });
  } catch (error) {
    throw new Error(`Could not read attachment ${ref}: ${describe(error)}`);
  }
  if (!extracted) {
    throw new Error(
      `No attachment ${ref} in this conversation; ask the person to attach the file again.`,
    );
  }
  return extracted;
}

async function loadVfsFile(
  ctx: RuntimeContext,
  path: string,
  deps: DocumentSourceDeps,
): Promise<LoadedDocument> {
  // Library files are the Files plugin's: an oracle that does not run it
  // does not expose them through the memory tools either.
  if (!ctx.availablePlugins.has('vfs')) throw new Error(LIBRARY_DISABLED);
  if (!ctx.ucan.hasSigningKey()) {
    throw new Error(
      'The Library (files) is not available: this oracle has no UCAN signing key.',
    );
  }
  let cfg: VfsConfig;
  try {
    cfg = resolveVfsConfig(ctx.config);
  } catch {
    throw new Error(LIBRARY_DISABLED);
  }
  const client = buildClient(ctx, {
    cfg,
    fetchImpl: deps.fetchImpl,
    retryDelayMs: deps.retryDelayMs,
  });
  const oracleDid = oracleDidOf(ctx);
  try {
    return await readVfsFile(ctx, client, path, deps);
  } catch (error) {
    // Errors of the VFS family become the same sentences `vfs_read` gives;
    // anything else already carries its own message.
    if (error instanceof VfsAuthError || error instanceof VfsHttpError) {
      throw new Error(mapVfsError(error, { path, oracleDid }));
    }
    throw error;
  }
}

function oracleDidOf(ctx: RuntimeContext): string | undefined {
  const did = (ctx.config as { ORACLE_DID?: unknown } | undefined)?.ORACLE_DID;
  return typeof did === 'string' && did.length > 0 ? did : undefined;
}

async function readVfsFile(
  ctx: RuntimeContext,
  client: VfsClient,
  path: string,
  deps: DocumentSourceDeps,
): Promise<LoadedDocument> {
  const stat = await client.statByPath(path);
  if (!stat) throw new Error(`No file at ${path} in your files.`);
  const mimetype = stat.mimeType || 'application/octet-stream';
  const filename = stat.name || basename(stat.path) || stat.id;
  if (stat.size > MAX_VISION_BYTES) {
    throw new Error(
      `"${filename}" is ${stat.size} bytes, over the ${MAX_VISION_BYTES} byte limit for documents.`,
    );
  }

  if (isTextMime(mimetype)) {
    const { bytes } = await client.contentBytes(stat.id, MAX_VISION_BYTES);
    // At most 3 UTF-8 bytes per UTF-16 unit: decoding past this adds nothing.
    const head = new Uint8Array(bytes).subarray(0, deps.maxChars * 3 + 4);
    const capped = capText(new TextDecoder().decode(head), deps.maxChars);
    return {
      ...capped,
      filename,
      mimetype,
      bytes: bytes.byteLength,
      method: 'text',
    };
  }

  // Only a PDF is downloaded here (to try its text layer); any other type
  // is downloaded by the render step itself, after its own type/size checks.
  let downloaded: VfsContentBytes | undefined;
  if (mimetype === PDF_MIME) {
    downloaded = await client.contentBytes(stat.id, MAX_VISION_BYTES);
    try {
      const pdf = await extractPdfText(new Uint8Array(downloaded.bytes), {
        maxChars: deps.maxChars,
        signal: ctx.abortSignal,
      });
      if (pdf.kind === 'text') {
        return {
          text: pdf.text,
          truncated: pdf.truncated,
          filename,
          mimetype,
          bytes: downloaded.bytes.byteLength,
          method: 'pdf',
          pages: pdf.pages,
        };
      }
      ctx.logger.log(
        `[memory] document "${filename}": no text layer (${pdf.pages} page(s)), using the helper model`,
      );
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      ctx.logger.warn(
        `[memory] document "${filename}": local PDF parse failed (${describe(error)}), using the helper model`,
      );
    }
  }

  // The bytes are already in hand: the render step does not download again.
  const rendered = await renderBinaryForIngestion(
    client,
    ctx,
    stat,
    downloaded,
  );
  const capped = capText(rendered.text, deps.maxChars);
  return {
    text: capped.text,
    truncated: capped.truncated || rendered.truncated,
    filename,
    mimetype,
    bytes: stat.size,
    method: 'model',
  };
}
