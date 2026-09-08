/**
 * Attachment payload retention.
 *
 * A human turn whose attachments the model reads natively stores the bytes
 * inline, as base64 content blocks, in the persisted message. On Workers that
 * payload is replayed to the model on every later turn of the session and
 * sits in the per-user SQLite (and its VFS copy) for good, so once a turn is
 * older than the newest `ATTACHMENT_PAYLOAD_TURNS` user turns its inline
 * blocks are replaced by one compact text placeholder. The placeholder lists
 * the message's attachments with the reference `view_attachment` takes, and
 * the metadata the Portal renders from (`additional_kwargs.attachment(s)`)
 * is left untouched, so transcripts do not change.
 *
 * The rewrite is a pure function of the thread's messages and idempotent: a
 * rewritten message has no inline block left, so it is never selected again.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AttachmentMeta } from '../sqlite/serialization';

/** Newest user turns whose inline attachment payloads stay in the messages. */
export const ATTACHMENT_PAYLOAD_TURNS = 2;

/**
 * `additional_kwargs.lc_source` of the human message `view_attachment` adds
 * to re-attach a payload — hidden from transcripts and not a user turn.
 */
export const ATTACHMENT_VIEW_SOURCE = 'attachment_view';

/** Every placeholder text block starts with this (transcripts drop it). */
export const ATTACHMENT_PLACEHOLDER_PREFIX = '[attachment offloaded]';

/**
 * Substring every inline payload block serialises to (`message_content`
 * holds the JSON of an array content), for a SQL `LIKE` pre-filter that
 * finds candidate rows without inflating message blobs.
 */
export const INLINE_PAYLOAD_NEEDLE = '"source_type":"base64"';

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

/** The reference `view_attachment` takes: the media event id, else the URI. */
export function attachmentRef(meta: AttachmentMeta): string | undefined {
  return meta.eventId ?? meta.mxcUri;
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
    return `${i + 1}. "${meta.filename}" (${meta.mimetype}${formatSize(meta.size)})${
      ref ? ` — ref: ${ref}` : ' — no reference; it cannot be fetched again'
    }`;
  });
  const listing =
    lines.length > 0
      ? `Attachments of this message:\n${lines.join('\n')}\n`
      : 'This message had an attachment whose metadata was not recorded; it cannot be fetched again.\n';
  return (
    `${ATTACHMENT_PLACEHOLDER_PREFIX} The attachment bytes of this message are no longer inline ` +
    `(only the newest ${ATTACHMENT_PAYLOAD_TURNS} user turns keep them). ${listing}` +
    `To look at one again, call ${VIEW_ATTACHMENT_TOOL_NAME} with its ref.`
  );
}

/**
 * A copy of `message` with every inline payload block replaced by one
 * placeholder text block (id, kwargs and response metadata preserved), or
 * null when the message carries no inline payload.
 */
export function offloadInlinePayloads(
  message: BaseMessage,
): BaseMessage | null {
  if (!Array.isArray(message.content)) return null;
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
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

export interface AttachmentRetentionResult {
  /** Ids of the messages whose inline payload stays (inside the window). */
  retainedIds: Set<string>;
  /** Rewritten copies of the messages that fell out of the window. */
  rewrites: BaseMessage[];
}

/**
 * Decide, for the thread's current messages (oldest first), which inline
 * payloads stay and which get a placeholder. A payload belongs to the user
 * turn it was posted in — a re-attachment message belongs to the turn of the
 * user message before it — and stays while that turn is one of the newest
 * `keepTurns` user turns. Messages without an id cannot be rewritten in
 * place and are left alone.
 */
export function applyAttachmentRetention(
  messages: readonly BaseMessage[],
  keepTurns: number = ATTACHMENT_PAYLOAD_TURNS,
): AttachmentRetentionResult {
  const retainedIds = new Set<string>();
  const rewrites: BaseMessage[] = [];
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.type !== 'human') continue;
    const userTurn = !isAttachmentViewMessage(message);
    if (userTurn) turnsSeen += 1;
    if (!hasInlinePayload(message) || !message.id) continue;
    const turnIndex = userTurn ? turnsSeen : turnsSeen + 1;
    if (turnIndex <= keepTurns) {
      retainedIds.add(message.id);
      continue;
    }
    const rewritten = offloadInlinePayloads(message);
    if (rewritten) rewrites.push(rewritten);
  }
  return { retainedIds, rewrites };
}
