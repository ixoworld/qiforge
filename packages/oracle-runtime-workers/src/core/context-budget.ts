/**
 * Every context-related limit of a turn, derived from the model's window
 * (`context-window.ts`) so that they scale with the model:
 *
 *   - `summarizeAtTokens`  — the history is condensed once it is this large
 *                            (default half the window; Hermes fires at 50%);
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
  /** Fraction of the window at which the history is summarized (default 0.5). */
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
  summarizeFraction: 0.5,
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
  /** The summarizer's own input limit (what it may read to write the summary). */
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

/** The budget for a turn on `resolution.model`. */
export function contextBudgetFor(
  resolution: ContextWindowResolution,
  knobs: ContextKnobs = DEFAULT_CONTEXT_KNOBS,
): ContextBudget {
  const window = resolution.tokens;
  // The reply reserve can never eat a small window: cap it at a quarter.
  const outputReserveTokens = Math.min(
    knobs.outputReserveTokens,
    Math.floor(window / 4),
  );
  const requestCapTokens = Math.max(
    1_000,
    Math.floor(window * knobs.requestFraction) - outputReserveTokens,
  );
  const summarizeAtTokens = Math.min(
    Math.floor(window * knobs.summarizeFraction),
    requestCapTokens,
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
    summaryInputTokens: Math.max(1_000, requestCapTokens - 4_000),
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

export function describeBudget(b: ContextBudget): string {
  return `model=${b.model} window=${b.windowTokens} (${b.origin}) summarizeAt=${b.summarizeAtTokens} pruneAt=${b.pruneAtTokens} resultCap=${b.resultCapChars}c requestCap=${b.requestCapTokens} reserve=${b.outputReserveTokens}`;
}
