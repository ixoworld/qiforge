/**
 * Re-fetch one attachment of a session on demand — the `view_attachment`
 * lane behind payload retention (`retention.ts`). The same routing as the
 * turn pipeline applies: when the current model reads the modality the bytes
 * come back as a native content block, otherwise the helper (`vision` role)
 * model turns them into text; plain text is decoded locally. Text results
 * are cached per session (`deps.cache`); native views are not (they are the
 * bytes themselves).
 */
import { classifyAttachment } from './classify';
import type { NativeAttachment } from './content-blocks';
import { loadAttachmentBytes, type MatrixMediaSource } from './download';
import {
  capText,
  extractText,
  MAX_MODEL_LANE_BYTES,
  type ExtractionProvider,
} from './extract';
import { categorizeFile, isPlainTextType, verifyMagicBytes } from './magic';
import { extractPdfText } from './pdf-text';
import { attachmentMetas, attachmentRef } from './retention';
import { routeAttachment } from './route';
import { sanitizeAttachmentFilename } from './sanitize';
import {
  LOCAL_TEXT_EXTRACTION,
  type AttachmentTextCache,
  type IngestTextScope,
} from './view-cache';
import type { AttachmentInput } from './types';
import type { ModelInputCapabilities } from '../core/llm';
import type { AttachmentMeta } from '../sqlite/serialization';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '../plugin-api/types';
import { bytesToBase64 } from '../plugins/base64';

export type AttachmentView =
  | { kind: 'native'; native: NativeAttachment }
  | { kind: 'text'; text: string };

export interface ViewAttachmentDeps {
  source: MatrixMediaSource;
  extraction: ExtractionProvider | null;
  /** Capabilities of the model that will read the result. */
  caps: ModelInputCapabilities;
  roomId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  logger: Logger;
  /**
   * The session's cache of extracted text (`AttachmentTextCacheStore`):
   * a hit costs no download and no helper-model call.
   */
  cache?: AttachmentTextCache;
  /**
   * The session's in-memory cache of ingestion text (`IngestTextLru`): holds
   * texts far over the SQLite cache's per-entry limit for a few minutes.
   */
  ingestCache?: IngestTextScope;
}

/** What the `view_attachment` tool sees on the host: session-scoped access. */
export interface AttachmentViewSurface {
  /** Whether any message of the session has had its inline payload offloaded. */
  readonly offloaded: boolean;
  /**
   * Fetch one of the session's attachments again by the reference the
   * placeholder lists (media event id or mxc URI). Rejects references that do
   * not belong to an attachment of this session.
   */
  view(ref: string): Promise<{ meta: AttachmentMeta; view: AttachmentView }>;
  /**
   * The text of one of the session's attachments for ingestion into
   * knowledge (never a native block): decoded locally for plain text, parsed
   * locally for PDFs with a text layer, otherwise extracted by the helper
   * model. Unwrapped and capped at `maxChars`. Resolves `null` when the
   * reference does not belong to an attachment of this session; rejects when
   * the file cannot be downloaded or read.
   */
  extractText(
    ref: string,
    opts: { maxChars: number },
  ): Promise<AttachmentTextExtraction | null>;
}

/** What {@link AttachmentViewSurface.extractText} returns. */
export interface AttachmentTextExtraction {
  text: string;
  filename: string;
  mimetype: string;
  /** Size of the original file when known, else of the extracted text. */
  bytes: number;
  /** True when `text` was cut at the caller's `maxChars`. */
  truncated: boolean;
  method: 'text' | 'pdf' | 'model';
  /** Page count, set when the text came from a PDF's text layer. */
  pages?: number;
}

function toInput(meta: AttachmentMeta): AttachmentInput {
  return {
    filename: meta.filename,
    mimetype: meta.mimetype,
    ...(meta.size !== undefined ? { size: meta.size } : {}),
    ...(meta.mxcUri ? { mxcUri: meta.mxcUri } : {}),
    ...(meta.eventId ? { eventId: meta.eventId } : {}),
  };
}

export async function viewAttachment(
  meta: AttachmentMeta,
  deps: ViewAttachmentDeps,
): Promise<AttachmentView> {
  const attachment = toInput(meta);
  const kind = classifyAttachment(attachment);
  const strategy = routeAttachment(kind, deps.caps);
  if (strategy === 'send-native') {
    const { bytes, mimetype, sniffed } = await loadAttachmentBytes(
      attachment,
      deps.roomId,
      deps.source,
      { fetchImpl: deps.fetchImpl, signal: deps.signal },
    );
    deps.logger.log(
      `[attachments] view "${attachment.filename}" (${mimetype}) kind=${kind} → ${strategy} (${bytes.length} bytes)`,
    );
    const loaded = classifyAttachment({
      mimetype,
      filename: sniffed ? '' : attachment.filename,
    });
    // Bytes that are not what the file claims never go back as a block.
    if (loaded !== kind)
      throw new Error(
        `File content mismatch: claimed ${attachment.mimetype} but detected ${mimetype}`,
      );
    return {
      kind: 'native',
      native: {
        kind: loaded === 'image' ? 'image' : 'file',
        mimeType: mimetype,
        base64: bytesToBase64(bytes),
        filename: attachment.filename,
      },
    };
  }

  const category = categorizeFile(attachment.mimetype);
  if (category === 'unsupported') {
    return {
      kind: 'text',
      text: `[File "${sanitizeAttachmentFilename(attachment.filename)}" (${attachment.mimetype}) is not a supported file type and could not be processed]`,
    };
  }
  // Text extracted earlier in this session by the same model is final.
  const ref = attachmentRef(meta);
  const model =
    category === 'document' && isPlainTextType(attachment.mimetype)
      ? LOCAL_TEXT_EXTRACTION
      : deps.extraction?.model;
  const cacheKey = deps.cache && ref && model ? { ref, model } : undefined;
  if (cacheKey) {
    const cached = await deps.cache?.get(cacheKey.ref, cacheKey.model);
    if (cached !== undefined) {
      deps.logger.log(
        `[attachments] view "${attachment.filename}" → cached text (${cacheKey.model})`,
      );
      return { kind: 'text', text: cached };
    }
  }
  const { bytes, mimetype } = await loadAttachmentBytes(
    attachment,
    deps.roomId,
    deps.source,
    { fetchImpl: deps.fetchImpl, signal: deps.signal },
  );
  deps.logger.log(
    `[attachments] view "${attachment.filename}" (${mimetype}) kind=${kind} → ${strategy} (${bytes.length} bytes)`,
  );
  verifyMagicBytes(bytes, category, attachment, (m) =>
    deps.logger.warn(`[attachments] ${m}`),
  );
  const { text } = await extractText(
    bytes,
    attachment,
    category,
    deps.extraction,
    { fetchImpl: deps.fetchImpl, signal: deps.signal },
  );
  if (cacheKey) await deps.cache?.put(cacheKey.ref, cacheKey.model, text);
  return { kind: 'text', text };
}

const PDF_MIME = 'application/pdf';

/** Text-cache keys of ingestion: distinct from the `view_attachment` ones. */
const INGEST_TEXT_KEY = 'ingest:local-text';
const INGEST_PDF_KEY = 'ingest:local-pdf';

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** The refusal for a scanned or binary file over the helper-model limit. */
function modelLaneTooLarge(filename: string, bytes: number): Error {
  return new Error(
    `"${sanitizeAttachmentFilename(filename)}" cannot be read: scanned or binary files up to ${megabytes(MAX_MODEL_LANE_BYTES)} MB can be processed; this one is ${megabytes(bytes)} MB. PDFs with a text layer and text files can be larger.`,
  );
}

/**
 * The ingestion counterpart of {@link viewAttachment}: always text, raw (no
 * `[Content of …]` header) and capped at `maxChars`. Results are kept in the
 * in-memory ingestion cache (any size up to its limit, cut or not) and, when
 * small and not cut, in the session's SQLite cache under `ingest:` keys; a
 * cached text is re-capped to the caller's limit. The helper-model lane
 * (scans, images, Office files) refuses files over `MAX_MODEL_LANE_BYTES`.
 */
export async function extractAttachmentText(
  meta: AttachmentMeta,
  deps: ViewAttachmentDeps,
  opts: { maxChars: number },
): Promise<AttachmentTextExtraction> {
  const attachment = toInput(meta);
  const category = categorizeFile(attachment.mimetype);
  if (category === 'unsupported') {
    throw new Error(
      `"${sanitizeAttachmentFilename(attachment.filename)}" (${attachment.mimetype}) is not a supported file type`,
    );
  }
  const plain = category === 'document' && isPlainTextType(attachment.mimetype);
  const ref = attachmentRef(meta);
  const modelKey = deps.extraction ? `ingest:${deps.extraction.model}` : '';
  const result = (
    text: string,
    method: AttachmentTextExtraction['method'],
    mimetype: string,
    bytes: number,
    truncated: boolean,
    pages?: number,
  ): AttachmentTextExtraction => ({
    text,
    filename: attachment.filename,
    mimetype,
    bytes,
    truncated,
    method,
    ...(pages !== undefined ? { pages } : {}),
  });

  const lookups: Array<[string, AttachmentTextExtraction['method']]> = plain
    ? [[INGEST_TEXT_KEY, 'text']]
    : [
        ...(attachment.mimetype === PDF_MIME
          ? [[INGEST_PDF_KEY, 'pdf'] as [string, 'pdf']]
          : []),
        ...(modelKey ? [[modelKey, 'model'] as [string, 'model']] : []),
      ];
  if (ref) {
    for (const [key, method] of lookups) {
      const hit = deps.ingestCache?.get(ref, key);
      if (!hit) continue;
      deps.logger.log(
        `[attachments] ingest "${attachment.filename}" → cached text (${key}, memory)`,
      );
      const capped = capText(hit.text, opts.maxChars);
      return result(
        capped.text,
        method,
        hit.mimetype,
        hit.bytes,
        capped.truncated || hit.truncated,
        hit.pages,
      );
    }
  }
  const cache = deps.cache;
  if (cache && ref) {
    for (const [key, method] of lookups) {
      const cached = await cache.get(ref, key);
      if (cached === undefined) continue;
      deps.logger.log(
        `[attachments] ingest "${attachment.filename}" → cached text (${key})`,
      );
      const capped = capText(cached, opts.maxChars);
      return result(
        capped.text,
        method,
        attachment.mimetype,
        meta.size ?? new TextEncoder().encode(cached).length,
        capped.truncated,
      );
    }
  }

  // The helper model takes the bytes inline: refuse a big scan or binary
  // before downloading it. (A PDF may still have a text layer, so it is
  // checked once its bytes are in hand.)
  if (
    !plain &&
    attachment.mimetype !== PDF_MIME &&
    (meta.size ?? 0) > MAX_MODEL_LANE_BYTES
  ) {
    throw modelLaneTooLarge(attachment.filename, meta.size ?? 0);
  }

  const { bytes, mimetype } = await loadAttachmentBytes(
    attachment,
    deps.roomId,
    deps.source,
    { fetchImpl: deps.fetchImpl, signal: deps.signal },
  );
  verifyMagicBytes(bytes, category, attachment, (m) =>
    deps.logger.warn(`[attachments] ${m}`),
  );
  deps.logger.log(
    `[attachments] ingest "${attachment.filename}" (${mimetype}) (${bytes.length} bytes)`,
  );
  const store = async (
    key: string,
    value: { text: string; truncated: boolean; pages?: number },
  ) => {
    if (!ref || !key) return;
    deps.ingestCache?.put(ref, key, {
      ...value,
      bytes: bytes.length,
      mimetype,
    });
    if (cache && !value.truncated) await cache.put(ref, key, value.text);
  };

  if (plain) {
    const { text, truncated } = await extractText(
      bytes,
      attachment,
      category,
      null,
      { raw: opts },
    );
    await store(INGEST_TEXT_KEY, { text, truncated: truncated ?? false });
    return result(text, 'text', mimetype, bytes.length, truncated ?? false);
  }

  if (mimetype === PDF_MIME) {
    try {
      const pdf = await extractPdfText(bytes, {
        maxChars: opts.maxChars,
        signal: deps.signal,
      });
      if (pdf.kind === 'text') {
        await store(INGEST_PDF_KEY, {
          text: pdf.text,
          truncated: pdf.truncated,
          pages: pdf.pages,
        });
        return result(
          pdf.text,
          'pdf',
          mimetype,
          bytes.length,
          pdf.truncated,
          pdf.pages,
        );
      }
      deps.logger.log(
        `[attachments] ingest "${attachment.filename}": no text layer (${pdf.pages} page(s)), using the helper model`,
      );
    } catch (error) {
      // A cancelled turn stops here; it must not start a model call.
      if (deps.signal?.aborted) throw error;
      deps.logger.warn(
        `[attachments] ingest "${attachment.filename}": local PDF parse failed (${error instanceof Error ? error.message : String(error)}), using the helper model`,
      );
    }
  }

  if (bytes.length > MAX_MODEL_LANE_BYTES) {
    throw modelLaneTooLarge(attachment.filename, bytes.length);
  }
  const { text, truncated } = await extractText(
    bytes,
    attachment,
    category,
    deps.extraction,
    { fetchImpl: deps.fetchImpl, signal: deps.signal, raw: opts },
  );
  await store(modelKey, { text, truncated: truncated ?? false });
  return result(text, 'model', mimetype, bytes.length, truncated ?? false);
}

/** The message sources {@link findPersistedAttachmentMeta} reads. */
export interface AttachmentMessageStore {
  /** Messages whose stored text contains `contentContains`, oldest first. */
  listThreadMessagesMatching(
    threadId: string,
    filter: { contentContains: string },
  ): Promise<BaseMessage[]>;
  listThreadMessages(threadId: string): Promise<BaseMessage[]>;
}

/**
 * The attachment of a session with the given reference, from earlier turns.
 * The reference is quoted in the text of the person's message (placeholder),
 * of the hidden extraction text and of the hidden note of a natively sent
 * file, and all of those carry the attachment metadata, so a SQL pre-filter
 * on the reference usually inflates one or two small rows; only when none of
 * them holds it (an inline attachment of an old message) is the whole session
 * loaded.
 */
export async function findPersistedAttachmentMeta(
  store: AttachmentMessageStore,
  sessionId: string,
  ref: string,
): Promise<AttachmentMeta | undefined> {
  const find = (messages: BaseMessage[]) =>
    messages
      .filter((m) => m.type === 'human' || m.type === 'ai')
      .flatMap((m) => attachmentMetas(m))
      .find((meta) => attachmentRef(meta) === ref);
  const candidates = await store.listThreadMessagesMatching(sessionId, {
    contentContains: ref,
  });
  return find(candidates) ?? find(await store.listThreadMessages(sessionId));
}

/**
 * The session's attachment surface. A reference resolves first against the
 * attachments of the turn now running (`turnMetas`: their message may not be
 * persisted yet when a tool runs), then against the persisted session via
 * `findPersisted`.
 */
export function createAttachmentViewSurface(input: {
  offloaded: boolean;
  turnMetas: readonly AttachmentMeta[];
  findPersisted: (ref: string) => Promise<AttachmentMeta | undefined>;
  deps: () => ViewAttachmentDeps;
}): AttachmentViewSurface {
  const findMeta = async (ref: string) =>
    input.turnMetas.find((meta) => attachmentRef(meta) === ref) ??
    (await input.findPersisted(ref));
  return {
    offloaded: input.offloaded,
    view: async (ref) => {
      const meta = await findMeta(ref);
      if (!meta) {
        throw new Error(`no attachment with ref "${ref}" in this conversation`);
      }
      return { meta, view: await viewAttachment(meta, input.deps()) };
    },
    extractText: async (ref, opts) => {
      const meta = await findMeta(ref);
      return meta ? extractAttachmentText(meta, input.deps(), opts) : null;
    },
  };
}
