/**
 * Recalls the images of recent user turns into each model request.
 *
 * Attachment bytes are never stored with the conversation: the checkpointer
 * keeps a placeholder text block in their place (`src/sqlite/
 * inline-payloads.ts`), so a message loaded from the checkpoint — every
 * earlier turn, and the turn itself after a durable run restarted — reaches
 * the model without the image the person sent. Right before each model call
 * this middleware puts the images of the newest `ATTACHMENT_RECALL_TURNS`
 * user turns back, in the request only (graph state, the checkpoint and the
 * transcript never see them):
 *
 *  - a human message qualifies when it holds the placeholder (its bytes
 *    were left out of storage), no inline block, and image attachments in
 *    its metadata; a `view_attachment` re-attachment message belongs to the
 *    user turn before it;
 *  - images only: a document is never recalled, the model calls
 *    `view_attachment` for it;
 *  - at most `ATTACHMENT_RECALL_MAX_IMAGES` per request, newest first;
 *  - each image is fetched once per run (the cache is per middleware
 *    instance, which is per turn), with a deadline of
 *    `ATTACHMENT_RECALL_TIMEOUT_MS`; a failure leaves the placeholder in
 *    place and is logged once per reference;
 *  - nothing happens when the turn's model does not read images.
 *
 * The placeholder of a message whose images came back lists only the
 * attachments that did not, or goes when none is left. The middleware sits
 * innermost, after the context guard: the guard's chars/4 estimate would
 * count an image's base64 as text, far above what the provider charges for
 * it.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import {
  attachmentMetas,
  attachmentRef,
  buildPlaceholderText,
  hasInlinePayload,
  isAttachmentPlaceholderText,
  isAttachmentViewMessage,
} from '../../attachments/retention';
import {
  nativeContentBlock,
  type NativeAttachment,
} from '../../attachments/content-blocks';
import type { Logger } from '../../plugin-api/types';
import type { AttachmentMeta } from '../../sqlite/serialization';
import { NOOP_LOGGER } from '../utils';

/** Newest user turns whose images are recalled into a request. */
export const ATTACHMENT_RECALL_TURNS = 2;

/** Images recalled into one request at most. */
export const ATTACHMENT_RECALL_MAX_IMAGES = 4;

/** Deadline of one image fetch, from the request to the resized bytes. */
export const ATTACHMENT_RECALL_TIMEOUT_MS = 15_000;

/**
 * Fetches one image attachment of the session, ready for the model (the
 * host downloads, checks and resizes it). Resolves null when the file is
 * not available; a rejection counts the same.
 */
export type RecallImageLoader = (
  meta: AttachmentMeta,
  signal: AbortSignal,
) => Promise<NativeAttachment | null>;

export interface AttachmentRecallMiddlewareOptions {
  loadImage: RecallImageLoader;
  /** Whether the turn's model reads images; nothing is recalled otherwise. */
  imageInput: boolean;
  /** The turn's abort signal: a cancelled turn stops its fetches. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxImages?: number;
  logger?: Logger;
}

interface RecallCandidate {
  index: number;
  message: BaseMessage;
  images: AttachmentMeta[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlaceholderBlock(block: unknown): boolean {
  return (
    isRecord(block) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    isAttachmentPlaceholderText(block.text)
  );
}

function hasPlaceholder(message: BaseMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => isPlaceholderBlock(block))
  );
}

/**
 * The human messages of the newest `ATTACHMENT_RECALL_TURNS` user turns
 * whose image bytes were left out of storage, newest first, with those
 * images (each reference once across the request).
 */
function recallCandidates(messages: readonly BaseMessage[]): RecallCandidate[] {
  const candidates: RecallCandidate[] = [];
  const seen = new Set<string>();
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.type !== 'human') continue;
    const userTurn = !isAttachmentViewMessage(message);
    if (userTurn) turnsSeen += 1;
    // A re-attachment belongs to the user turn before it (not counted yet).
    const turnIndex = userTurn ? turnsSeen : turnsSeen + 1;
    if (turnIndex > ATTACHMENT_RECALL_TURNS) {
      if (userTurn) break;
      continue;
    }
    if (hasInlinePayload(message) || !hasPlaceholder(message)) continue;
    const images = attachmentMetas(message).filter((meta) => {
      const ref = attachmentRef(meta);
      if (meta.category !== 'image' || ref === undefined || seen.has(ref))
        return false;
      seen.add(ref);
      return true;
    });
    if (images.length > 0) candidates.push({ index: i, message, images });
  }
  return candidates;
}

/**
 * A copy of the candidate's message with its recalled images in place of
 * its placeholder: the image blocks, then a placeholder for the attachments
 * still left out.
 */
function withRecalledImages(
  { message, images }: RecallCandidate,
  recalled: ReadonlyMap<string, NativeAttachment>,
): BaseMessage {
  if (!Array.isArray(message.content)) return message;
  const own = new Set(images.map((meta) => attachmentRef(meta)));
  const restored: NativeAttachment[] = [];
  const left: AttachmentMeta[] = [];
  for (const meta of attachmentMetas(message)) {
    const ref = attachmentRef(meta);
    const native =
      ref !== undefined && own.has(ref) ? recalled.get(ref) : undefined;
    if (native) restored.push(native);
    else left.push(meta);
  }
  if (restored.length === 0) return message;
  const content: typeof message.content = [];
  for (const block of message.content) {
    if (!isPlaceholderBlock(block)) {
      content.push(block);
      continue;
    }
    content.push(...restored.map(nativeContentBlock));
    if (left.length > 0)
      content.push({ type: 'text', text: buildPlaceholderText(left) });
  }
  return new HumanMessage({
    id: message.id,
    content,
    ...(message.name !== undefined ? { name: message.name } : {}),
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The recall step on its own: `recall(messages)` returns the request's
 * messages with recent images put back, or the same array when there is
 * nothing to recall. Holds the per-run fetch cache.
 */
export function createAttachmentRecaller(
  options: AttachmentRecallMiddlewareOptions,
): { recall(messages: BaseMessage[]): Promise<BaseMessage[]> } {
  const logger = options.logger ?? NOOP_LOGGER;
  const timeoutMs = options.timeoutMs ?? ATTACHMENT_RECALL_TIMEOUT_MS;
  const maxImages = options.maxImages ?? ATTACHMENT_RECALL_MAX_IMAGES;
  // One fetch per reference for the whole run; a failure is kept as null so
  // it is neither retried nor logged again.
  const cache = new Map<string, Promise<NativeAttachment | null>>();

  const fetchImage = (
    ref: string,
    meta: AttachmentMeta,
  ): Promise<NativeAttachment | null> => {
    const cached = cache.get(ref);
    if (cached) return cached;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;
    const started = Date.now();
    const pending = options.loadImage(meta, signal).then(
      (native) => {
        if (native) {
          logger.log(
            `[attachments] recall: ${ref} re-attached (${native.mimeType}, ${native.base64.length} base64 chars, ${Date.now() - started} ms)`,
          );
        } else {
          logger.warn(
            `[attachments] recall: ${ref} is not available; the placeholder stays`,
          );
        }
        return native;
      },
      (error: unknown) => {
        logger.warn(
          `[attachments] recall: ${ref} failed (${errorText(error)}); the placeholder stays`,
        );
        return null;
      },
    );
    cache.set(ref, pending);
    return pending;
  };

  return {
    async recall(messages) {
      if (!options.imageInput) return messages;
      const candidates = recallCandidates(messages);
      if (candidates.length === 0) return messages;

      // Newest first, at most `maxImages` across the request.
      const wanted: Array<{ ref: string; meta: AttachmentMeta }> = [];
      for (const candidate of candidates) {
        for (const meta of candidate.images) {
          const ref = attachmentRef(meta);
          if (ref === undefined || wanted.length >= maxImages) continue;
          wanted.push({ ref, meta });
        }
      }
      const recalled = new Map<string, NativeAttachment>();
      await Promise.all(
        wanted.map(async ({ ref, meta }) => {
          const native = await fetchImage(ref, meta);
          if (native) recalled.set(ref, native);
        }),
      );
      if (recalled.size === 0) return messages;

      const out = messages.slice();
      for (const candidate of candidates)
        out[candidate.index] = withRecalledImages(candidate, recalled);
      return out;
    },
  };
}

export function createAttachmentRecallMiddleware(
  options: AttachmentRecallMiddlewareOptions,
): AgentMiddleware {
  const recaller = createAttachmentRecaller(options);
  return createMiddleware({
    name: 'AttachmentRecallMiddleware',
    wrapModelCall: async (request, handler) => {
      const messages = await recaller.recall(request.messages);
      return messages === request.messages
        ? handler(request)
        : handler({ ...request, messages });
    },
  });
}
