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
import { extractText, type ExtractionProvider } from './extract';
import { categorizeFile, isPlainTextType, verifyMagicBytes } from './magic';
import { attachmentRef } from './retention';
import { routeAttachment } from './route';
import { sanitizeAttachmentFilename } from './sanitize';
import { LOCAL_TEXT_EXTRACTION, type AttachmentTextCache } from './view-cache';
import type { AttachmentInput } from './types';
import type { ModelInputCapabilities } from '../core/llm';
import type { AttachmentMeta } from '../sqlite/serialization';
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
