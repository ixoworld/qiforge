/**
 * The "model-extract" lane — turn an attachment into text with the helper
 * (vision) model through the provider's OpenAI-compatible chat endpoint, the
 * way the Node `FileProcessingService` does: images are described, audio is
 * transcribed (`input_audio`), video described (`video_url`), documents
 * extracted verbatim (`file` part — the provider parses PDFs server-side).
 * Plain text is read locally and never costs a model call.
 *
 * Reduced vs Node: there is no local PDF/office parser on workerd
 * (`loadFileFromBuffer` is Node-only), so every non-plain-text document goes
 * straight to the helper model's `file` lane instead of "local parse, then
 * model on failure". (Document ingestion parses PDFs locally first:
 * `pdf-text.ts`.)
 */
import { bytesToBase64 } from '../plugins/base64';
import { validateUrlTarget } from './download';
import type { FileCategory } from './magic';
import { isPlainTextType } from './magic';
import { sanitizeAttachmentFilename } from './sanitize';
import type { AttachmentInput } from './types';

/** Provider wiring for the helper model — the platform key, never a BYO one. */
export interface ExtractionProvider {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
  /** The `vision` role's model id. */
  model: string;
}

export interface ExtractionUsage {
  cost?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ExtractionResult {
  content: string;
  usage?: ExtractionUsage;
  /** True when the provider stopped the reply at its output-token limit. */
  truncated?: boolean;
}

export interface ExtractOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Raw mode (document ingestion): `extractText` returns the text itself —
   * no `[Content of …]` header, no `[...truncated]` marker — cut at
   * `maxChars` with `truncated` reporting whether anything was cut. Unset
   * keeps the chat-attachment behaviour.
   */
  raw?: { maxChars: number };
  /**
   * `max_tokens` for the completion, sent when the provider accepts it (a
   * 400 that names it is retried once without). Set by raw mode.
   */
  maxTokens?: number;
}

export const MAX_TEXT_LENGTH = 50_000;
/**
 * Largest scanned or binary file handed to the helper model (inline base64
 * in the request body); also the Files plugin's `MAX_VISION_BYTES`.
 */
export const MAX_MODEL_LANE_BYTES = 10 * 1024 * 1024;
/** Upper bound on the `max_tokens` raw mode asks for. */
export const MAX_RAW_COMPLETION_TOKENS = 32_768;
const AI_PROCESS_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_LENGTH = 1024;

export const PROMPTS: Record<Exclude<FileCategory, 'unsupported'>, string> = {
  document: 'Extract all text content from this document verbatim.',
  image:
    'Describe this image in detail. Include all text, numbers, labels, and visual elements.',
  audio: 'Transcribe this audio completely. Include all spoken words.',
  video:
    'Describe this video in detail. Include actions, text overlays, and spoken content.',
};

export function formatContent(
  label: string,
  filename: string,
  content: string,
): string {
  return `[${label} of ${filename}]:\n${content}`;
}

export function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TEXT_LENGTH)}\n\n[...truncated]`;
}

/** Cut `text` to at most `maxChars` UTF-16 units without splitting a surrogate pair. */
export function capText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export function getAudioFormat(
  mimetype: string,
): 'mp3' | 'wav' | 'ogg' | 'flac' | 'webm' | 'mp4' | 'aac' {
  if (mimetype.includes('mp3') || mimetype.includes('mpeg')) return 'mp3';
  if (mimetype.includes('wav')) return 'wav';
  if (mimetype.includes('ogg')) return 'ogg';
  if (mimetype.includes('flac')) return 'flac';
  if (mimetype.includes('webm')) return 'webm';
  if (mimetype.includes('mp4') || mimetype.includes('m4a')) return 'mp4';
  if (mimetype.includes('aac')) return 'aac';
  return 'mp3';
}

interface ChatCompletion {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  model?: string;
}

/** The text of a reply: a string as is, a block array reduced to its text blocks. */
export function replyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

async function chatCompletion(
  provider: ExtractionProvider,
  contentParts: Array<Record<string, unknown>>,
  opts: ExtractOptions,
): Promise<ExtractionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);
  if (opts.signal?.aborted) controller.abort();
  const timer = setTimeout(onAbort, opts.timeoutMs ?? AI_PROCESS_TIMEOUT_MS);
  try {
    const send = (withMaxTokens: boolean): Promise<Response> =>
      fetchImpl(`${provider.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          ...provider.headers,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: 'user', content: contentParts }],
          ...(withMaxTokens && opts.maxTokens !== undefined
            ? { max_tokens: opts.maxTokens }
            : {}),
        }),
        signal: controller.signal,
      });
    let response = await send(true);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      // A provider that rejects `max_tokens` gets the request without it.
      if (
        opts.maxTokens !== undefined &&
        response.status === 400 &&
        /max_(completion_)?tokens/i.test(errorText)
      ) {
        response = await send(false);
      } else {
        throw new Error(
          `AI processing failed (${response.status}): ${errorText.slice(0, MAX_ERROR_BODY_LENGTH)}`,
        );
      }
    }
    const raw: unknown = await response.json();
    const result = raw as ChatCompletion;
    const choice = result.choices?.[0];
    return {
      content: replyText(choice?.message?.content),
      ...(choice?.finish_reason === 'length' ? { truncated: true } : {}),
      ...(result.usage
        ? {
            usage: {
              cost: result.usage.cost,
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
            },
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Hand a public image/video URL to the provider directly (no re-upload of
 * the bytes). The URL is SSRF-validated first.
 */
export async function aiProcessFromUrl(
  url: string,
  category: 'image' | 'video',
  provider: ExtractionProvider,
  opts: ExtractOptions = {},
): Promise<ExtractionResult> {
  validateUrlTarget(url);
  const parts: Array<Record<string, unknown>> = [
    { type: 'text', text: PROMPTS[category] },
    category === 'image'
      ? { type: 'image_url', image_url: { url } }
      : { type: 'video_url', video_url: { url } },
  ];
  return chatCompletion(provider, parts, opts);
}

/** Send the bytes inline (data URI / base64) with the category's prompt. */
export async function aiProcess(
  bytes: Uint8Array,
  mimetype: string,
  category: Exclude<FileCategory, 'unsupported'>,
  filename: string,
  provider: ExtractionProvider,
  opts: ExtractOptions = {},
): Promise<ExtractionResult> {
  const base64 = bytesToBase64(bytes);
  const dataUri = `data:${mimetype};base64,${base64}`;
  const parts: Array<Record<string, unknown>> = [
    { type: 'text', text: PROMPTS[category] },
  ];
  if (category === 'image') {
    parts.push({ type: 'image_url', image_url: { url: dataUri } });
  } else if (category === 'audio') {
    parts.push({
      type: 'input_audio',
      input_audio: { data: base64, format: getAudioFormat(mimetype) },
    });
  } else if (category === 'document') {
    parts.push({ type: 'file', file: { filename, file_data: dataUri } });
  } else {
    parts.push({ type: 'video_url', video_url: { url: dataUri } });
  }
  return chatCompletion(provider, parts, opts);
}

/**
 * The `max_tokens` that matches a character cap: about three characters per
 * token, bounded by what providers commonly accept.
 */
export function rawMaxTokens(maxChars: number): number {
  return Math.min(Math.ceil(maxChars / 3), MAX_RAW_COMPLETION_TOKENS);
}

/**
 * Text for one downloaded attachment by category — the Node
 * `processDocument` / `processImage` / `processAudio` / `processVideo`
 * dispatch. Plain text never touches the model.
 */
export async function extractText(
  bytes: Uint8Array,
  attachment: AttachmentInput,
  category: Exclude<FileCategory, 'unsupported'>,
  provider: ExtractionProvider | null,
  opts: ExtractOptions = {},
): Promise<{ text: string; usage?: ExtractionUsage; truncated?: boolean }> {
  const safeName = sanitizeAttachmentFilename(attachment.filename);
  if (category === 'document' && isPlainTextType(attachment.mimetype)) {
    if (opts.raw) {
      // At most 3 UTF-8 bytes per UTF-16 unit: decoding past this adds nothing.
      const head = bytes.subarray(0, opts.raw.maxChars * 3 + 4);
      return capText(new TextDecoder().decode(head), opts.raw.maxChars);
    }
    const text = new TextDecoder().decode(bytes);
    return { text: formatContent('Content', safeName, truncateText(text)) };
  }
  if (!provider) {
    throw new Error(
      'no helper model configured for attachment extraction on this host',
    );
  }
  const label =
    category === 'document'
      ? 'Content'
      : category === 'audio'
        ? 'Transcription'
        : 'Description';
  const { content, usage, truncated } = await aiProcess(
    bytes,
    attachment.mimetype,
    category,
    attachment.filename,
    provider,
    opts.raw && opts.maxTokens === undefined
      ? { ...opts, maxTokens: rawMaxTokens(opts.raw.maxChars) }
      : opts,
  );
  if (opts.raw) {
    const capped = capText(content, opts.raw.maxChars);
    return {
      text: capped.text,
      truncated: capped.truncated || truncated === true,
      ...(usage ? { usage } : {}),
    };
  }
  const body = category === 'document' ? truncateText(content) : content;
  return {
    text: formatContent(label, safeName, body),
    ...(usage ? { usage } : {}),
  };
}
