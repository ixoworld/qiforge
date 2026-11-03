/**
 * Attachment payloads and their placeholder.
 *
 * A human turn whose attachments the model reads natively carries the bytes
 * inline, as base64 content blocks, for the turn that posted them. Those
 * bytes are never stored with the conversation: the checkpointer writes
 * every such message with its inline blocks replaced by one compact text
 * placeholder (`offloadInlinePayloads`, applied in `src/sqlite/
 * inline-payloads.ts`), so every later turn, and a run restarted mid-turn,
 * loads the placeholder. The placeholder lists the message's attachments
 * with the reference `view_attachment` takes; the metadata the Portal
 * renders from (`additional_kwargs.attachment(s)`) is left untouched, so
 * transcripts do not change. Recent images are put back into each model
 * request by the attachment recall middleware
 * (`src/core/middlewares/attachment-recall.ts`), never into the stored
 * messages.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AttachmentMeta } from '../sqlite/serialization';
import {
  NOTE_FILENAME_MAX,
  NOTE_MIMETYPE_MAX,
  sanitizeNoteField,
} from './sanitize';

/**
 * `additional_kwargs.lc_source` of the human message `view_attachment` adds
 * to re-attach a payload — hidden from transcripts and not a user turn (it
 * belongs to the user turn before it).
 */
export const ATTACHMENT_VIEW_SOURCE = 'attachment_view';

/** Every placeholder text block starts with this (transcripts drop it). */
export const ATTACHMENT_PLACEHOLDER_PREFIX = '[attachment offloaded]';

export const VIEW_ATTACHMENT_TOOL_NAME = 'view_attachment';

interface InlinePayloadBlock {
  type: string;
  source_type: 'base64';
  data: string;
  mime_type?: string;
  filename?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAttachmentMeta(value: unknown): value is AttachmentMeta {
  return (
    isRecord(value) &&
    typeof value.filename === 'string' &&
    typeof value.mimetype === 'string' &&
    typeof value.category === 'string'
  );
}

/** A LangChain data content block carrying base64 bytes (`image` / `file`). */
export function isInlinePayloadBlock(
  block: unknown,
): block is InlinePayloadBlock {
  return (
    isRecord(block) &&
    typeof block.type === 'string' &&
    block.source_type === 'base64' &&
    typeof block.data === 'string'
  );
}

export function hasInlinePayload(message: BaseMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => isInlinePayloadBlock(block))
  );
}

export function isAttachmentPlaceholderText(text: string): boolean {
  return text.startsWith(ATTACHMENT_PLACEHOLDER_PREFIX);
}

/** The re-attachment message `view_attachment` injects (not a user turn). */
export function isAttachmentViewMessage(message: BaseMessage): boolean {
  return (
    message.type === 'human' &&
    message.additional_kwargs?.lc_source === ATTACHMENT_VIEW_SOURCE
  );
}

/**
 * The reference `view_attachment` takes: the media event id, else a channel
 * file's opaque reference, else the URI.
 */
export function attachmentRef(meta: AttachmentMeta): string | undefined {
  return meta.eventId ?? meta.channelRef ?? meta.mxcUri;
}

/** The attachment metadata a message carries (`attachments`, else `attachment`). */
export function attachmentMetas(message: BaseMessage): AttachmentMeta[] {
  const kw = message.additional_kwargs ?? {};
  if (Array.isArray(kw.attachments)) {
    return kw.attachments.filter(isAttachmentMeta);
  }
  return isAttachmentMeta(kw.attachment) ? [kw.attachment] : [];
}

function formatSize(size: number | undefined): string {
  if (size === undefined) return '';
  if (size < 1024) return `, ${size} B`;
  if (size < 1024 * 1024) return `, ${Math.round(size / 1024)} KB`;
  return `, ${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** The text block that replaces a message's inline payload blocks. */
export function buildPlaceholderText(metas: AttachmentMeta[]): string {
  const lines = metas.map((meta, i) => {
    const ref = attachmentRef(meta);
    return `${i + 1}. "${sanitizeNoteField(meta.filename, NOTE_FILENAME_MAX)}" (${sanitizeNoteField(meta.mimetype, NOTE_MIMETYPE_MAX)}${formatSize(meta.size)})${
      ref ? ` — ref: ${ref}` : ' — no reference; it cannot be fetched again'
    }`;
  });
  const listing =
    lines.length > 0
      ? `Attachments of this message:\n${lines.join('\n')}\n`
      : 'This message had an attachment whose metadata was not recorded; it cannot be fetched again.\n';
  return (
    `${ATTACHMENT_PLACEHOLDER_PREFIX} The attachment bytes of this message are not stored ` +
    `with the conversation. ${listing}` +
    `To look at one again, call ${VIEW_ATTACHMENT_TOOL_NAME} with its ref.`
  );
}

/**
 * A copy of a human `message` with every inline payload block replaced by
 * one placeholder text block (id, name, kwargs and response metadata
 * preserved, the original untouched), or null when it is not a human
 * message or carries no inline payload. The copy shares every other block
 * with the original; only the payload strings are left behind.
 */
export function offloadInlinePayloads(
  message: BaseMessage,
): HumanMessage | null {
  if (message.type !== 'human' || !Array.isArray(message.content)) return null;
  if (!message.content.some((block) => isInlinePayloadBlock(block)))
    return null;
  const placeholder = {
    type: 'text',
    text: buildPlaceholderText(attachmentMetas(message)),
  };
  let placed = false;
  const content: typeof message.content = [];
  for (const block of message.content) {
    if (!isInlinePayloadBlock(block)) {
      content.push(block);
      continue;
    }
    if (!placed) {
      content.push(placeholder);
      placed = true;
    }
  }
  return new HumanMessage({
    id: message.id,
    content,
    ...(message.name !== undefined ? { name: message.name } : {}),
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}
