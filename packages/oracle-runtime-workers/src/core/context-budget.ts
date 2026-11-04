/**
 * Every context-related limit of a turn, derived from the model's window
 * (`context-window.ts`) so that they scale with the model:
 *
 *   - `summarizeAtTokens`  — the history is condensed once it is this large
 *                            (default 60% of the window, whatever its size;
 *                            never above the request cap nor above what the
 *                            summarizer reads, which only binds below a
 *                            ~34k window). The summary is written by the
 *                            turn's own model (the `summarizer` role), so no
 *                            second window bounds it;
 *   - `pruneAtTokens`      — above this, old tool results are demoted to
 *                            one-liners in the request (no model call, no
 *                            state change) before the model sees them;
 *   - `staleResultTurns`   — on a turn that opens after `cacheColdMs` of
 *                            quiet, tool results older than this many turns
 *                            leave the request (`read_result` reads them
 *                            back). Whatever the window: this is about what
 *                            a call costs, not about what fits;
 *   - `resultCapChars`     — a tool result larger than this is stored whole
 *                            and the model sees head + tail + a handle;
 *   - `requestCapTokens`   — a request that is still larger than this after
 *                            pruning is refused instead of sent to fail;
 *   - `outputReserveTokens`— the room left for the reply.
 *
 * A large window says nothing about what a request should cost, so the
 * fractions are bounded in tokens too (`summarizeMaxTokens`, `pruneMaxTokens`,
 * `resultCapMaxChars`): a million-token window would otherwise never condense
 * a thread that long ago stopped being worth re-sending, and would pass the
 * 272k-token point where providers such as OpenAI double the price.
 *
 * Token counts are chars/4 estimates (`estimateTokensApprox`), never billing.
 */
import type { Logger } from '../plugin-api/types';
import type { ContextWindowResolution } from './context-window';
import { estimateTokensApprox } from './manifest';
import { NOOP_LOGGER } from './utils';

export const CHARS_PER_TOKEN = 4;

export interface ContextKnobs {
  /** Fraction of the window at which the history is summarized (default 0.6). */
  summarizeFraction: number;
  /** Ceiling on the summarize threshold in tokens, whatever the window (default 200,000). */
  summarizeMaxTokens: number;
  /** Fraction of the window above which old tool results are pruned per request (default 0.35). */
  pruneFraction: number;
  /** Ceiling on the prune threshold in tokens, whatever the window (default 100,000). */
  pruneMaxTokens: number;
  /**
   * Finished turns whose tool results stay whole when a cold turn trims the
   * older ones out of the request (default 2; 0 never trims).
   */
  staleResultTurns: number;
  /**
   * Quiet time after which a turn counts as cold: the provider's prompt
   * cache is gone, so changing the prefix costs nothing. Default 2,100,000
   * (35 minutes): on `gpt-5.6-luna`, Bedrock and OpenAI routes alike, a prefix
   * left idle for 20 minutes still hit and one left for 35 missed. 0 makes
   * every turn cold.
   */
  cacheColdMs: number;
  /**
   * Turns an on-demand capability stays loaded without being used (default
   * 3). It is unloaded on the first cold turn after that; 0 never unloads.
   */
  pluginIdleTurns: number;
  /** Fraction of the window one tool result may occupy before it is capped (default 0.12). */
  resultCapFraction: number;
  /**
   * Ceiling on the result cap in chars (default 64,000 ≈ 16k tokens): a
   * million-token window does not make a half-megabyte tool result a good
   * idea — the rest stays reachable through `read_result`.
   */
  resultCapMaxChars: number;
  /** Fraction of the window a request may use, output reserve included (default 0.95). */
  requestFraction: number;
  /** Tokens reserved for the reply (default 8000). */
  outputReserveTokens: number;
  /** Optional message-count trigger for summarization (unset = tokens only). */
  summarizeTriggerMessages?: number;
  /** Recent messages kept verbatim by the summarizer (default 10). */
  keepMessages: number;
}

export const DEFAULT_CONTEXT_KNOBS: ContextKnobs = {
  summarizeFraction: 0.6,
  summarizeMaxTokens: 200_000,
  pruneFraction: 0.35,
  pruneMaxTokens: 100_000,
  staleResultTurns: 2,
  cacheColdMs: 2_100_000,
  pluginIdleTurns: 3,
  resultCapFraction: 0.12,
  resultCapMaxChars: 64_000,
  requestFraction: 0.95,
  outputReserveTokens: 8_000,
  keepMessages: 10,
};

export interface ContextBudget {
  model: string;
  windowTokens: number;
  origin: ContextWindowResolution['origin'];
  summarizeAtTokens: number;
  pruneAtTokens: number;
  staleResultTurns: number;
  cacheColdMs: number;
  pluginIdleTurns: number;
  resultCapChars: number;
  requestCapTokens: number;
  outputReserveTokens: number;
  /**
   * The summarizer's input limit (what it may read to write the summary):
   * the main model's request cap less a margin for the summary prompt. The
   * summarizer is the main model, so its request has the same room.
   */
  summaryInputTokens: number;
  summarizeTriggerMessages?: number;
  keepMessages: number;
}

/** Parse the `CONTEXT_*` env knobs; anything unusable keeps its default (with a warning). */
export function contextKnobs(
  env: Record<string, unknown>,
  logger: Logger = NOOP_LOGGER,
): ContextKnobs {
  const fraction = (key: string, fallback: number): number => {
    const raw = env[key];
    if (typeof raw !== 'string' || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1) return n;
    logger.warn(
      `[context] ${key}=${raw} is not a fraction in (0, 1]; using ${fallback}`,
    );
    return fallback;
  };
  const int = (
    key: string,
    fallback: number | undefined,
    min: number,
  ): number | undefined => {
    const raw = env[key];
    if (typeof raw !== 'string' || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= min) return n;
    logger.warn(
      `[context] ${key}=${raw} is not an integer ≥ ${min}; using ${fallback ?? 'unset'}`,
    );
    return fallback;
  };
  const summarizeTriggerMessages = int(
    'CONTEXT_SUMMARIZE_MESSAGES',
    undefined,
    4,
  );
  return {
    summarizeFraction: fraction(
      'CONTEXT_SUMMARIZE_FRACTION',
      DEFAULT_CONTEXT_KNOBS.summarizeFraction,
    ),
    summarizeMaxTokens:
      int(
        'CONTEXT_SUMMARIZE_MAX_TOKENS',
        DEFAULT_CONTEXT_KNOBS.summarizeMaxTokens,
        1_000,
      ) ?? DEFAULT_CONTEXT_KNOBS.summarizeMaxTokens,
    pruneFraction: fraction(
      'CONTEXT_PRUNE_FRACTION',
      DEFAULT_CONTEXT_KNOBS.pruneFraction,
    ),
    pruneMaxTokens:
      int(
        'CONTEXT_PRUNE_MAX_TOKENS',
        DEFAULT_CONTEXT_KNOBS.pruneMaxTokens,
        1_000,
      ) ?? DEFAULT_CONTEXT_KNOBS.pruneMaxTokens,
    staleResultTurns:
      int(
        'CONTEXT_STALE_RESULT_TURNS',
        DEFAULT_CONTEXT_KNOBS.staleResultTurns,
        0,
      ) ?? DEFAULT_CONTEXT_KNOBS.staleResultTurns,
    cacheColdMs:
      int('CONTEXT_CACHE_COLD_MS', DEFAULT_CONTEXT_KNOBS.cacheColdMs, 0) ??
      DEFAULT_CONTEXT_KNOBS.cacheColdMs,
    pluginIdleTurns:
      int(
        'CONTEXT_PLUGIN_IDLE_TURNS',
        DEFAULT_CONTEXT_KNOBS.pluginIdleTurns,
        0,
      ) ?? DEFAULT_CONTEXT_KNOBS.pluginIdleTurns,
    resultCapFraction: fraction(
      'CONTEXT_RESULT_CAP_FRACTION',
      DEFAULT_CONTEXT_KNOBS.resultCapFraction,
    ),
    resultCapMaxChars:
      int(
        'CONTEXT_RESULT_CAP_MAX_CHARS',
        DEFAULT_CONTEXT_KNOBS.resultCapMaxChars,
        4_000,
      ) ?? DEFAULT_CONTEXT_KNOBS.resultCapMaxChars,
    requestFraction: fraction(
      'CONTEXT_REQUEST_FRACTION',
      DEFAULT_CONTEXT_KNOBS.requestFraction,
    ),
    outputReserveTokens:
      int(
        'CONTEXT_OUTPUT_RESERVE_TOKENS',
        DEFAULT_CONTEXT_KNOBS.outputReserveTokens,
        256,
      ) ?? DEFAULT_CONTEXT_KNOBS.outputReserveTokens,
    ...(summarizeTriggerMessages !== undefined
      ? { summarizeTriggerMessages }
      : {}),
    keepMessages:
      int('CONTEXT_KEEP_MESSAGES', DEFAULT_CONTEXT_KNOBS.keepMessages, 2) ??
      DEFAULT_CONTEXT_KNOBS.keepMessages,
  };
}

/** Tokens the summary prompt and its framing need on top of the history it reads. */
const SUMMARY_PROMPT_MARGIN_TOKENS = 4_000;

/** What a request to a model with `window` may hold, the reply reserve left out. */
function requestCapFor(
  window: number,
  knobs: ContextKnobs,
): { requestCapTokens: number; outputReserveTokens: number } {
  // The reply reserve can never eat a small window: cap it at a quarter.
  const outputReserveTokens = Math.min(
    knobs.outputReserveTokens,
    Math.floor(window / 4),
  );
  const requestCapTokens = Math.max(
    1_000,
    Math.floor(window * knobs.requestFraction) - outputReserveTokens,
  );
  return { requestCapTokens, outputReserveTokens };
}

/**
 * The budget for a turn on `resolution.model`, from that model's window
 * alone: the summary is written by the same model (the `summarizer` role),
 * so no other window bounds what it reads.
 */
export function contextBudgetFor(
  resolution: ContextWindowResolution,
  knobs: ContextKnobs = DEFAULT_CONTEXT_KNOBS,
): ContextBudget {
  const window = resolution.tokens;
  const { requestCapTokens, outputReserveTokens } = requestCapFor(
    window,
    knobs,
  );
  // The summarizer keeps only the newest `summaryInputTokens` of what it is
  // asked to condense (LangChain trims with `strategy: 'last'`; the summary
  // prompt needs its own room in the request) and drops the rest unread —
  // the earlier summary first. Summarizing therefore starts no later than
  // that limit, so the thread's memory is never lost unread. With the
  // default knobs this only binds below a window of ~34.3k tokens (60% of
  // the window exceeds 95% less the reply reserve and the prompt margin);
  // above it the trigger is the plain fraction.
  const summaryInputTokens = Math.max(
    1_000,
    requestCapTokens - SUMMARY_PROMPT_MARGIN_TOKENS,
  );
  const summarizeAtTokens = Math.min(
    Math.floor(window * knobs.summarizeFraction),
    knobs.summarizeMaxTokens,
    requestCapTokens,
    summaryInputTokens,
  );
  const pruneAtTokens = Math.min(
    Math.floor(window * knobs.pruneFraction),
    knobs.pruneMaxTokens,
    summarizeAtTokens,
  );
  return {
    model: resolution.model,
    windowTokens: window,
    origin: resolution.origin,
    summarizeAtTokens,
    pruneAtTokens,
    staleResultTurns: knobs.staleResultTurns,
    cacheColdMs: knobs.cacheColdMs,
    pluginIdleTurns: knobs.pluginIdleTurns,
    resultCapChars: Math.min(
      Math.floor(window * knobs.resultCapFraction) * CHARS_PER_TOKEN,
      knobs.resultCapMaxChars,
    ),
    requestCapTokens,
    outputReserveTokens,
    summaryInputTokens,
    ...(knobs.summarizeTriggerMessages !== undefined
      ? { summarizeTriggerMessages: knobs.summarizeTriggerMessages }
      : {}),
    keepMessages: knobs.keepMessages,
  };
}

/**
 * What one image block costs the model, whatever its byte size. Providers
 * bill an image by its pixels, not by its base64: every one the runtime
 * sends is scaled to a 1568 px long edge by the provider (or before, by the
 * `IMAGES` binding), which is at most ~3,300 tokens on the costliest
 * provider formula (width × height / 750). Counting the base64 at chars/4
 * instead made one resized phone photo look like ~128k tokens, enough for
 * the context guard to refuse the turn on a model with a smaller window.
 */
export const IMAGE_BLOCK_TOKENS = 3_300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An image content block in any of the shapes a message carries: the
 * LangChain data block the attachments build (`type: 'image'` with `data`
 * or `url`) or the OpenAI chat shape (`type: 'image_url'`). File blocks are
 * not images: a document's cost does follow its size, and native documents
 * are kept small (`NATIVE_DOCUMENT_MAX_BYTES`).
 */
function isImageBlock(block: unknown): boolean {
  return (
    isRecord(block) && (block.type === 'image' || block.type === 'image_url')
  );
}

/**
 * chars/4 over a message's content, whatever its shape; each image block
 * counts {@link IMAGE_BLOCK_TOKENS} instead of its base64.
 */
export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokensApprox(content);
  if (content == null) return 0;
  try {
    if (Array.isArray(content) && content.some(isImageBlock)) {
      const images = content.filter(isImageBlock).length;
      const rest = content.filter((block) => !isImageBlock(block));
      return (
        images * IMAGE_BLOCK_TOKENS +
        (rest.length ? estimateTokensApprox(JSON.stringify(rest)) : 0)
      );
    }
    return estimateTokensApprox(JSON.stringify(content));
  } catch {
    return 0;
  }
}

/**
 * Per-message memo of the chars/4 estimates: every model step of a turn
 * re-estimates the whole history (the context guard, the turn budget, the
 * summarizer's trigger), and the history is the same message objects from
 * step to step. An entry is reused only while the message still holds the
 * same `content` / `tool_calls` values it was computed from.
 */
interface MessageEstimate {
  content: unknown;
  contentTokens: number;
  toolCalls?: { value: unknown; tokens: number };
}

const messageEstimates = new WeakMap<object, MessageEstimate>();

function estimateOf(message: { content: unknown }): MessageEstimate {
  const cached = messageEstimates.get(message);
  if (cached && cached.content === message.content) return cached;
  const fresh: MessageEstimate = {
    content: message.content,
    contentTokens: estimateContentTokens(message.content),
  };
  messageEstimates.set(message, fresh);
  return fresh;
}

/** `estimateContentTokens(message.content)`, memoised per message. */
export function messageContentTokens(message: { content: unknown }): number {
  return estimateOf(message).contentTokens;
}

/** `estimateContentTokens(toolCalls)` for `message`'s tool calls, memoised per message. */
export function messageToolCallTokens(
  message: { content: unknown },
  toolCalls: unknown,
): number {
  const entry = estimateOf(message);
  if (entry.toolCalls && entry.toolCalls.value === toolCalls)
    return entry.toolCalls.tokens;
  const tokens = estimateContentTokens(toolCalls);
  entry.toolCalls = { value: toolCalls, tokens };
  return tokens;
}

export function describeBudget(b: ContextBudget): string {
  return `model=${b.model} window=${b.windowTokens} (${b.origin}) summarizeAt=${b.summarizeAtTokens} pruneAt=${b.pruneAtTokens} staleTurns=${b.staleResultTurns} coldMs=${b.cacheColdMs} pluginIdle=${b.pluginIdleTurns} resultCap=${b.resultCapChars}c requestCap=${b.requestCapTokens} reserve=${b.outputReserveTokens} summaryInput=${b.summaryInputTokens}`;
}
