/**
 * Re-fetch one attachment of a session on demand — the `view_attachment`
 * lane behind payload retention (`retention.ts`). The same routing as the
 * turn pipeline applies: when the current model reads the modality the bytes
 * come back as a native content block, otherwise the helper (`vision` role)
 * model turns them into text; plain text is decoded locally.
 */
import { classifyAttachment } from './classify';
import type { NativeAttachment } from './content-blocks';
import { loadAttachmentBytes, type MatrixMediaSource } from './download';
import { extractText, type ExtractionProvider } from './extract';
import { categorizeFile, verifyMagicBytes } from './magic';
import { routeAttachment } from './route';
import { sanitizeAttachmentFilename } from './sanitize';
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
  const { bytes, mimetype } = await loadAttachmentBytes(
    attachment,
    deps.roomId,
    deps.source,
    { fetchImpl: deps.fetchImpl, signal: deps.signal },
  );
  deps.logger.log(
    `[attachments] view "${attachment.filename}" (${mimetype}) kind=${kind} → ${strategy} (${bytes.length} bytes)`,
  );
  if (strategy === 'send-native') {
    const loaded = classifyAttachment({
      mimetype,
      filename: attachment.filename,
    });
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
  return { kind: 'text', text };
}
