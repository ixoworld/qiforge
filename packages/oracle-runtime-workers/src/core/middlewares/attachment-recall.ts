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
 *  - an image already in the request (a message that still holds its
 *    bytes: the turn's own message, a `view_attachment` re-attachment) is
 *    not recalled again, and neither is the same file under another
 *    reference (a channel photo sent twice gets a new media event id but
 *    keeps its `channelRef`);
 *  - at most `ATTACHMENT_RECALL_MAX_IMAGES` per request, newest first,
 *    fetched one at a time; an image whose recorded size is over
 *    `ATTACHMENT_RECALL_MAX_IMAGE_BYTES` is skipped without a fetch, one of
 *    unknown size is fetched with that cap and skipped when cut off; the
 *    images of one request hold at most `ATTACHMENT_RECALL_MAX_TOTAL_BYTES`
 *    of base64 together;
 *  - a finished image (resized, base64) is kept in a small LRU
 *    (`RecalledImageCache`) that the host holds per user object, so the
 *    next turn's recall neither fetches nor transforms it again; each fetch
 *    has a deadline of `ATTACHMENT_RECALL_TIMEOUT_MS`; a failure leaves the
 *    placeholder in place and is logged once per reference per run;
 *  - when the provider refuses a request that carries recalled images with
 *    a client error (4xx, not a context overflow, not a credential, billing,
 *    timeout or rate-limit status), the call is made once more with the
 *    request as it came in (no recalled images), and those images are not
 *    recalled again for the rest of the run;
 *  - nothing happens when the turn's model does not read images.
 *
 * The placeholder of a message whose images came back lists only the
 * attachments that did not, or goes when none is left. The middleware sits
 * innermost, after the context guard: the guard's chars/4 estimate would
 * count an image's base64 as text, far above what the provider charges for
 * it. The guard therefore never sees the recalled images.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import { isContextOverflowError } from '../context-window';
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
 * Largest original image recalled (bytes). A larger recorded size is
 * skipped without a fetch; the loader cuts a download off at this size.
 */
export const ATTACHMENT_RECALL_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Base64 characters the recalled images of one request hold together (the
 * request carries them as they are, ~4/3 of the image bytes).
 */
export const ATTACHMENT_RECALL_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** Finished images a `RecalledImageCache` keeps by default. */
export const ATTACHMENT_RECALL_CACHE_ENTRIES = 8;

/** Base64 characters a `RecalledImageCache` keeps by default. */
export const ATTACHMENT_RECALL_CACHE_BYTES = 10 * 1024 * 1024;

/**
 * Fetches one image attachment of the session, ready for the model (the
 * host downloads, checks and resizes it). The download must stop once it
 * passes `maxBytes` (a rejection then). Resolves null when the file is not
 * available, or when the image may not go to the model natively (the
 * resize step reports it `dropped`); a rejection counts the same.
 */
export type RecallImageLoader = (
  meta: AttachmentMeta,
  opts: { signal: AbortSignal; maxBytes: number },
) => Promise<NativeAttachment | null>;

/**
 * The finished (resized, base64) images recalled lately, by reference,
 * least recently used evicted first, bounded by entry count and by base64
 * characters. The host keeps one per user object and hands it to every
 * turn's recall, so an image recalled on one turn is neither fetched nor
 * transformed (each transformation is billed) on the next.
 */
export class RecalledImageCache {
  private readonly entries = new Map<string, NativeAttachment>();
  private chars = 0;

  constructor(
    private readonly maxEntries = ATTACHMENT_RECALL_CACHE_ENTRIES,
    private readonly maxChars = ATTACHMENT_RECALL_CACHE_BYTES,
  ) {}

  get(ref: string): NativeAttachment | undefined {
    const hit = this.entries.get(ref);
    if (hit === undefined) return undefined;
    // Re-inserted: a Map iterates in insertion order, oldest first.
    this.entries.delete(ref);
    this.entries.set(ref, hit);
    return hit;
  }

  set(ref: string, native: NativeAttachment): void {
    const size = native.base64.length;
    this.delete(ref);
    if (size > this.maxChars) return;
    this.entries.set(ref, native);
    this.chars += size;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.chars <= this.maxChars)
        break;
      this.entries.delete(oldest);
      this.chars -= entry.base64.length;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private delete(ref: string): void {
    const entry = this.entries.get(ref);
    if (entry === undefined) return;
    this.entries.delete(ref);
    this.chars -= entry.base64.length;
  }
}

export interface AttachmentRecallMiddlewareOptions {
  loadImage: RecallImageLoader;
  /** Whether the turn's model reads images; nothing is recalled otherwise. */
  imageInput: boolean;
  /**
   * The finished-image cache shared across turns (one per user object).
   * Absent = a cache for this recaller only, i.e. for one run.
   */
  cache?: RecalledImageCache;
  /** The turn's abort signal: a cancelled turn stops its fetches. */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalBytes?: number;
  logger?: Logger;
}

/** What one `recall` put into the request. */
export interface RecallResult {
  /** The request's messages: the same array when nothing came back. */
  messages: BaseMessage[];
  /** The references of the images put back, newest first. */
  recalled: string[];
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
 * Every identifier of one attachment: the media event id, the channel
 * file's reference and the URI. A channel photo sent again gets a new
 * event id but keeps its `channelRef`, so either one names the same file.
 */
function attachmentKeys(meta: AttachmentMeta): string[] {
  const keys: string[] = [];
  for (const key of [meta.eventId, meta.channelRef, meta.mxcUri])
    if (key !== undefined && key.length > 0) keys.push(key);
  return keys;
}

/**
 * The human messages of the newest `ATTACHMENT_RECALL_TURNS` user turns
 * whose image bytes were left out of storage, newest first, with those
 * images: each file once across the request, none that a message of the
 * request still holds inline, none in `excluded` (by reference).
 */
function recallCandidates(
  messages: readonly BaseMessage[],
  excluded: ReadonlySet<string>,
): RecallCandidate[] {
  const candidates: RecallCandidate[] = [];
  // The files the request already carries as bytes come first, wherever
  // they sit: the turn's own message, a re-attachment message.
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'human' || !hasInlinePayload(message)) continue;
    for (const meta of attachmentMetas(message))
      for (const key of attachmentKeys(meta)) seen.add(key);
  }
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
      if (meta.category !== 'image' || ref === undefined) return false;
      const keys = attachmentKeys(meta);
      if (keys.some((key) => seen.has(key))) return false;
      // An excluded file still claims its keys: an older copy of it under
      // another reference is not recalled in its place.
      for (const key of keys) seen.add(key);
      return !excluded.has(ref);
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

/** How far an error's `cause` chain is walked (one wrap per middleware layer). */
const MAX_CAUSE_DEPTH = 32;

/**
 * 4xx statuses that say nothing about the request's content: credentials,
 * billing, a timeout, a rate limit. Dropping the images cannot help them.
 */
const NOT_CONTENT_STATUSES = new Set([401, 402, 403, 408, 429]);

/** The HTTP status of a provider error or of one it wraps. */
function providerStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const status: unknown = Reflect.get(current, 'status');
    if (typeof status === 'number') return status;
    const response: unknown = Reflect.get(current, 'response');
    if (typeof response === 'object' && response !== null) {
      const responseStatus: unknown = Reflect.get(response, 'status');
      if (typeof responseStatus === 'number') return responseStatus;
    }
    current = Reflect.get(current, 'cause');
  }
  return undefined;
}

/** Whether the error, or one it wraps, is a context overflow. */
function isOverflow(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === undefined || current === null) return false;
    if (isContextOverflowError(current)) return true;
    if (typeof current !== 'object') return false;
    current = Reflect.get(current, 'cause');
  }
  return false;
}

/**
 * The status of a provider refusal the recalled images may have caused: a
 * client error (4xx) that is not a context overflow (the context guard's
 * business) and not one of `NOT_CONTENT_STATUSES`. Undefined otherwise.
 */
function imageRefusalStatus(error: unknown): number | undefined {
  const status = providerStatus(error);
  if (status === undefined || status < 400 || status >= 500) return undefined;
  if (NOT_CONTENT_STATUSES.has(status) || isOverflow(error)) return undefined;
  return status;
}

/**
 * The recall step on its own: `recall(messages)` returns the request's
 * messages with recent images put back (the same array when nothing came
 * back) and the references put back. Holds the run's failures; finished
 * images live in the `RecalledImageCache`.
 */
export function createAttachmentRecaller(
  options: AttachmentRecallMiddlewareOptions,
): {
  recall(messages: BaseMessage[]): Promise<RecallResult>;
  /** Never recall these references again in this run. */
  exclude(refs: readonly string[]): void;
} {
  const logger = options.logger ?? NOOP_LOGGER;
  const timeoutMs = options.timeoutMs ?? ATTACHMENT_RECALL_TIMEOUT_MS;
  const maxImages = options.maxImages ?? ATTACHMENT_RECALL_MAX_IMAGES;
  const maxImageBytes =
    options.maxImageBytes ?? ATTACHMENT_RECALL_MAX_IMAGE_BYTES;
  const maxTotal = options.maxTotalBytes ?? ATTACHMENT_RECALL_MAX_TOTAL_BYTES;
  const cache = options.cache ?? new RecalledImageCache();
  // References not recalled again this run: a failed or skipped fetch (so
  // it is neither retried nor logged again) and an image the provider
  // refused.
  const excluded = new Set<string>();

  const fetchImage = async (
    ref: string,
    meta: AttachmentMeta,
  ): Promise<NativeAttachment | null> => {
    const cached = cache.get(ref);
    if (cached) return cached;
    if (meta.size !== undefined && meta.size > maxImageBytes) {
      excluded.add(ref);
      logger.warn(
        `[attachments] recall: ${ref} is ${meta.size} bytes, over the ${maxImageBytes}-byte recall limit; the placeholder stays`,
      );
      return null;
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;
    const started = Date.now();
    try {
      const native = await options.loadImage(meta, {
        signal,
        maxBytes: maxImageBytes,
      });
      if (!native) {
        excluded.add(ref);
        logger.warn(
          `[attachments] recall: ${ref} is not available; the placeholder stays`,
        );
        return null;
      }
      logger.log(
        `[attachments] recall: ${ref} re-attached (${native.mimeType}, ${native.base64.length} base64 chars, ${Date.now() - started} ms)`,
      );
      cache.set(ref, native);
      return native;
    } catch (error) {
      excluded.add(ref);
      logger.warn(
        `[attachments] recall: ${ref} failed (${errorText(error)}); the placeholder stays`,
      );
      return null;
    }
  };

  return {
    exclude(refs) {
      for (const ref of refs) excluded.add(ref);
    },
    async recall(messages) {
      const nothing: RecallResult = { messages, recalled: [] };
      if (!options.imageInput) return nothing;
      const candidates = recallCandidates(messages, excluded);
      if (candidates.length === 0) return nothing;

      // Newest first, at most `maxImages` across the request.
      const wanted: Array<{ ref: string; meta: AttachmentMeta }> = [];
      for (const candidate of candidates) {
        for (const meta of candidate.images) {
          const ref = attachmentRef(meta);
          if (ref === undefined || wanted.length >= maxImages) continue;
          wanted.push({ ref, meta });
        }
      }
      // One at a time: only one download and its base64 are in flight.
      const recalled = new Map<string, NativeAttachment>();
      let total = 0;
      for (const { ref, meta } of wanted) {
        if (options.signal?.aborted) break;
        const native = await fetchImage(ref, meta);
        if (!native) continue;
        if (total + native.base64.length > maxTotal) {
          logger.warn(
            `[attachments] recall: ${ref} left out (${native.base64.length} base64 chars; the request already holds ${total} of ${maxTotal})`,
          );
          continue;
        }
        total += native.base64.length;
        recalled.set(ref, native);
      }
      if (recalled.size === 0) return nothing;

      const out = messages.slice();
      for (const candidate of candidates)
        out[candidate.index] = withRecalledImages(candidate, recalled);
      return { messages: out, recalled: [...recalled.keys()] };
    },
  };
}

export function createAttachmentRecallMiddleware(
  options: AttachmentRecallMiddlewareOptions,
): AgentMiddleware {
  const logger = options.logger ?? NOOP_LOGGER;
  const recaller = createAttachmentRecaller(options);
  return createMiddleware({
    name: 'AttachmentRecallMiddleware',
    wrapModelCall: async (request, handler) => {
      const { messages, recalled } = await recaller.recall(request.messages);
      if (recalled.length === 0) return handler(request);
      try {
        return await handler({ ...request, messages });
      } catch (error) {
        const status = imageRefusalStatus(error);
        if (status === undefined || options.signal?.aborted) throw error;
        // The images may be what the provider refused (a type, size or
        // dimension it does not take): once more without them, and not
        // again this run, so the turn and its next calls go through.
        recaller.exclude(recalled);
        logger.warn(
          `[attachments] recall: the provider refused a request with ${recalled.length} recalled image(s) (${status}: ${errorText(error).slice(0, 200)}); retrying once without them, not recalled again this run: ${recalled.join(', ')}`,
        );
        return handler(request);
      }
    },
  });
}
