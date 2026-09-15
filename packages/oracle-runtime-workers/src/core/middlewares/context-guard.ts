/**
 * Keeps every model request inside the model's window.
 *
 * Three layers, all on the request only (graph state and the transcript are
 * never rewritten here):
 *
 *   1. **Pressure pruning.** Above `pruneAtTokens` (35% of the window), tool
 *      results outside the kept tail are demoted to one-line placeholders
 *      (a capped result keeps its `read_result` handle) and results whose
 *      text is identical to a later one are replaced by a back-reference.
 *      No model call, no storage — Hermes' deterministic passes.
 *   2. **The hard cap.** A request still above `requestCapTokens` after a
 *      harder prune is refused with a clear error instead of being sent to
 *      fail at the provider.
 *   3. **Overflow recovery.** When the provider rejects the request anyway,
 *      the limit it names is learned (the window is lowered for good), the
 *      request is pruned hard, and it is retried once.
 *
 * Token counts are chars/4 estimates; the thresholds leave the slack for it.
 */
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';
import { estimateContentTokens, type ContextBudget } from '../context-budget';
import { isContextOverflowError } from '../context-window';
import { NOOP_LOGGER } from '../utils';
import { cappedMetaOf } from './result-cap';

export class ContextOverflowError extends Error {
  readonly retryable = false;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

/**
 * What the guard did to a request, for the host's per-session counters
 * (`GET /debug/context?session=`): the stage that pruned and how much it
 * saved, a provider overflow that was retried, or a request it refused.
 */
export type ContextGuardEvent =
  | {
      kind: 'prune';
      stage: 'soft' | 'hard' | 'overflow';
      pruned: number;
      beforeTokens: number;
      afterTokens: number;
    }
  | { kind: 'overflow-retry'; learnedWindow?: number }
  | { kind: 'refused'; tokens: number };

export interface ContextGuardOptions {
  budget: ContextBudget;
  /**
   * A provider rejected the request as too long: learn from it. Returns the
   * new window (tokens) when the error named one.
   */
  onOverflow?: (error: unknown) => Promise<number | undefined>;
  /** Observes every prune, overflow retry and refusal (never throws into the turn). */
  onEvent?: (event: ContextGuardEvent) => void;
  logger?: Logger;
}

export interface PruneOptions {
  /** Messages at the end that are never touched. */
  keepTail: number;
  /** Tool results shorter than this are left alone. */
  demoteMinChars: number;
}

export const PRUNE_SOFT: PruneOptions = { keepTail: 10, demoteMinChars: 600 };
export const PRUNE_HARD: PruneOptions = { keepTail: 4, demoteMinChars: 200 };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}

function placeholder(
  message: ToolMessage,
  text: string,
  reason: 'pruned' | 'duplicate',
): ToolMessage {
  const name = message.name ?? 'tool';
  const meta = cappedMetaOf(message);
  const body =
    reason === 'duplicate'
      ? `[${name} result: identical to a later ${name} result, omitted]`
      : `[${name} result (${text.length} characters) pruned from context${meta?.id ? `; the full result is saved as ${meta.id} — read_result({ id: "${meta.id}" }) reads it` : ''}]`;
  return new ToolMessage({
    ...(message.id ? { id: message.id } : {}),
    tool_call_id: message.tool_call_id,
    name,
    status: message.status,
    content: body,
    additional_kwargs: { ...message.additional_kwargs, pruned: reason },
  });
}

/**
 * Old tool results → one-liners; duplicates → back-references. The last
 * `keepTail` messages are returned as they are. Pure: new message objects
 * with the same ids, the input untouched.
 */
export function pruneToolResults(
  messages: BaseMessage[],
  options: PruneOptions,
): { messages: BaseMessage[]; pruned: number } {
  const cutoff = Math.max(0, messages.length - options.keepTail);
  const out = [...messages];
  let pruned = 0;
  // Duplicates: keep the LAST full copy anywhere; earlier identical results
  // (outside the tail) point at it.
  const seenLater = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (!ToolMessage.isInstance(m)) continue;
    const text = textOf(m.content);
    if (i >= cutoff) {
      if (text.length >= 40) seenLater.add(text);
      continue;
    }
    if (text.length >= 40 && seenLater.has(text)) {
      out[i] = placeholder(m, text, 'duplicate');
      pruned += 1;
      continue;
    }
    if (text.length >= 40) seenLater.add(text);
    if (text.length > options.demoteMinChars) {
      out[i] = placeholder(m, text, 'pruned');
      pruned += 1;
    }
  }
  return { messages: out, pruned };
}

/** chars/4 over the request: system prompt, tool schemas, messages. */
export function estimateRequestTokens(input: {
  systemTokens: number;
  schemaTokens: number;
  messages: BaseMessage[];
}): number {
  let tokens = input.systemTokens + input.schemaTokens;
  for (const m of input.messages) {
    tokens += estimateContentTokens(m.content) + 4;
    if (AIMessage.isInstance(m) && m.tool_calls?.length)
      tokens += estimateContentTokens(m.tool_calls);
  }
  return tokens;
}

export function createContextGuardMiddleware(
  options: ContextGuardOptions,
): AgentMiddleware {
  const logger = options.logger ?? NOOP_LOGGER;
  const { budget } = options;
  const emit = (event: ContextGuardEvent): void => {
    try {
      options.onEvent?.(event);
    } catch (err) {
      logger.warn(
        `[context] onEvent failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const schemaTokensCache = new WeakMap<object, number>();
  const schemaTokensOf = (tools: unknown[]): number => {
    let total = 0;
    for (const entry of tools) {
      if (!entry || typeof entry !== 'object') continue;
      let n = schemaTokensCache.get(entry);
      if (n === undefined) {
        try {
          n = estimateContentTokens(
            'schema' in entry ? convertToOpenAITool(entry as never) : entry,
          );
        } catch {
          n = 0;
        }
        schemaTokensCache.set(entry, n);
      }
      total += n;
    }
    return total;
  };
  return createMiddleware({
    name: 'ContextGuardMiddleware',
    wrapModelCall: async (request, handler) => {
      const systemTokens = estimateContentTokens(
        request.systemMessage?.content ?? '',
      );
      const schemaTokens = schemaTokensOf(request.tools ?? []);
      const size = (messages: BaseMessage[]) =>
        estimateRequestTokens({ systemTokens, schemaTokens, messages });
      let messages = request.messages;
      let tokens = size(messages);
      const shrink = (
        opts: PruneOptions,
        stage: 'soft' | 'hard' | 'overflow',
        why: string,
      ): void => {
        const before = tokens;
        const result = pruneToolResults(messages, opts);
        messages = result.messages;
        tokens = size(messages);
        if (result.pruned > 0) {
          logger.log(
            `[context] ${why}: pruned ${result.pruned} tool result(s), ~${before} → ~${tokens} tokens (window ${budget.windowTokens})`,
          );
          emit({
            kind: 'prune',
            stage,
            pruned: result.pruned,
            beforeTokens: before,
            afterTokens: tokens,
          });
        }
      };
      if (tokens > budget.pruneAtTokens)
        shrink(PRUNE_SOFT, 'soft', 'over the prune threshold');
      if (tokens > budget.requestCapTokens)
        shrink(PRUNE_HARD, 'hard', 'over the request cap');
      if (tokens > budget.requestCapTokens) {
        emit({ kind: 'refused', tokens });
        throw new ContextOverflowError(
          `The conversation no longer fits the model's context window (about ${tokens} of ${budget.windowTokens} tokens even after trimming old tool results). Start a new session or ask for a shorter answer.`,
        );
      }
      try {
        return await handler({ ...request, messages });
      } catch (error) {
        if (!isContextOverflowError(error)) throw error;
        const learned = await options
          .onOverflow?.(error)
          .catch(() => undefined);
        logger.warn(
          `[context] provider rejected the request as too long (${learned ? `window now ${learned}` : 'no limit named'}); retrying once with a hard prune`,
        );
        emit({
          kind: 'overflow-retry',
          ...(learned !== undefined ? { learnedWindow: learned } : {}),
        });
        shrink(PRUNE_HARD, 'overflow', 'after the provider overflow');
        try {
          return await handler({ ...request, messages });
        } catch (retryError) {
          if (!isContextOverflowError(retryError)) throw retryError;
          throw new ContextOverflowError(
            "The conversation no longer fits the model's context window, even after trimming. Start a new session.",
            retryError,
          );
        }
      }
    },
  });
}
