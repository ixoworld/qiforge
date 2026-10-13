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
 *   - `resultCapChars`     — a tool result larger than this is stored whole
 *                            and the model sees head + tail + a handle;
 *   - `requestCapTokens`   — a request that is still larger than this after
 *                            pruning is refused instead of sent to fail;
 *   - `outputReserveTokens`— the room left for the reply.
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
  /** Fraction of the window above which old tool results are pruned per request (default 0.35). */
  pruneFraction: number;
  /** Fraction of the window one tool result may occupy before it is capped (default 0.12). */
  resultCapFraction: number;
  /**
   * Ceiling on the result cap in chars (default 200,000 ≈ 50k tokens): a
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
  pruneFraction: 0.35,
  resultCapFraction: 0.12,
  resultCapMaxChars: 200_000,
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
    pruneFraction: fraction(
      'CONTEXT_PRUNE_FRACTION',
      DEFAULT_CONTEXT_KNOBS.pruneFraction,
    ),
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
    requestCapTokens,
    summaryInputTokens,
  );
  const pruneAtTokens = Math.min(
    Math.floor(window * knobs.pruneFraction),
    summarizeAtTokens,
  );
  return {
    model: resolution.model,
    windowTokens: window,
    origin: resolution.origin,
    summarizeAtTokens,
    pruneAtTokens,
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

/** chars/4 over a message's content, whatever its shape. */
export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokensApprox(content);
  if (content == null) return 0;
  try {
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
  return `model=${b.model} window=${b.windowTokens} (${b.origin}) summarizeAt=${b.summarizeAtTokens} pruneAt=${b.pruneAtTokens} resultCap=${b.resultCapChars}c requestCap=${b.requestCapTokens} reserve=${b.outputReserveTokens} summaryInput=${b.summaryInputTokens}`;
}
