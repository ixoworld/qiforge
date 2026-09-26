import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { type AgentMiddleware, createMiddleware } from 'langchain';
import type { Logger } from '../../plugin-api/types';
import { NOOP_LOGGER } from '../utils';
import { isCapabilityGateRefusal } from './capability-gate';
import { isSummarizationMessage } from './summarization';

/** Identical successful calls a turn may make, per effect. */
export interface RepetitionCaps {
  reads: number;
  writes: number;
}

export const DEFAULT_REPETITION_CAPS: RepetitionCaps = { reads: 5, writes: 1 };

/**
 * Parse `TURN_MAX_IDENTICAL_READS` / `TURN_MAX_IDENTICAL_WRITES`; anything
 * that is not a positive number keeps its default (as `turnLimitsFromEnv`).
 */
export function repetitionCapsFromEnv(env: {
  TURN_MAX_IDENTICAL_READS?: unknown;
  TURN_MAX_IDENTICAL_WRITES?: unknown;
}): RepetitionCaps {
  const positive = (raw: unknown, fallback: number): number => {
    if (typeof raw !== 'number' && typeof raw !== 'string') return fallback;
    if (raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  return {
    reads: positive(
      env.TURN_MAX_IDENTICAL_READS,
      DEFAULT_REPETITION_CAPS.reads,
    ),
    writes: positive(
      env.TURN_MAX_IDENTICAL_WRITES,
      DEFAULT_REPETITION_CAPS.writes,
    ),
  };
}

export interface ToolRepetitionGuardMiddlewareOptions {
  /**
   * At most this many messages back to scan for a prior identical failed
   * call. The scan never reaches past the start of the current turn;
   * unset, it covers the whole turn.
   */
  lookback?: number;
  /**
   * Effect of a tool by name (the main agent passes its read/write map;
   * a sub-agent dispatch is a write). Unset, every tool is capped as a read.
   */
  effectOf?: (toolName: string) => 'read' | 'write';
  /** Identical successful calls of a read allowed per turn (default 5, `TURN_MAX_IDENTICAL_READS`). */
  maxIdenticalReads?: number;
  /** Identical successful calls of a write allowed per turn (default 1, `TURN_MAX_IDENTICAL_WRITES`). */
  maxIdenticalWrites?: number;
  /** Optional logger; defaults to a no-op. */
  logger?: Logger;
}

/**
 * Detects when the agent issues the same `(toolName, args)` pair after that
 * exact call already failed in the current turn, and short-circuits before
 * the tool is invoked again. The short-circuit message quotes the earlier
 * error and tells the model to change tools/args instead.
 *
 * A turn starts at the latest human message (the user's, or a sub-agent's
 * task). A failure from an earlier turn never blocks: the user may have
 * fixed its cause and asked again ("I granted access, try again").
 *
 * It also caps identical calls that SUCCEEDED in the turn: a write may run
 * once per turn with the same arguments (again would repeat its effect —
 * the user can ask again in a new message), a read up to
 * `maxIdenticalReads` times (room for polling, not for a loop). An
 * identical call earlier in the same model response counts too, since the
 * calls of one response run side by side and neither sees the other's
 * result.
 *
 * `toolRetryMiddleware` retries inside one call; this guard prevents the
 * model from making the *next* identical call.
 */
export const createToolRepetitionGuardMiddleware = (
  options: ToolRepetitionGuardMiddlewareOptions = {},
): AgentMiddleware => {
  const logger = options.logger ?? NOOP_LOGGER;
  const lookback = options.lookback ?? Number.POSITIVE_INFINITY;
  const maxReads = options.maxIdenticalReads ?? DEFAULT_REPETITION_CAPS.reads;
  const maxWrites =
    options.maxIdenticalWrites ?? DEFAULT_REPETITION_CAPS.writes;

  return createMiddleware({
    name: 'ToolRepetitionGuardMiddleware',
    wrapToolCall: async (toolCallRequest, handler) => {
      const { toolCall, state } = toolCallRequest;
      const toolName = toolCall.name ?? toolCallRequest.tool?.name;
      if (!toolName) return handler(toolCallRequest);

      const argsKey = canonicalArgsKey(toolCall.args);
      const messages = state.messages ?? [];
      const start = Math.max(
        turnStart(messages),
        messages.length - lookback,
        0,
      );
      const argsById = toolCallArgsById(messages, start);

      for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (!(msg instanceof ToolMessage)) continue;
        if (msg.status !== 'error') continue;
        // The capability gate refused it without running it; after a
        // `load_capability` the same call is the expected next step.
        if (isCapabilityGateRefusal(msg)) continue;
        if (msg.name !== toolName) continue;

        const priorArgs = argsById.get(msg.tool_call_id);
        if (priorArgs === undefined) continue;
        if (canonicalArgsKey(priorArgs) !== argsKey) continue;

        const priorError = toolMessageText(msg);
        logger.warn(
          `Repetition guard: short-circuiting duplicate failed call to ${toolName}`,
          { toolName, priorError },
        );
        return new ToolMessage({
          content: [
            `You already called \`${toolName}\` with these exact arguments earlier in this turn and it failed with:`,
            '',
            priorError,
            '',
            'Do NOT repeat the same call. Read the error message, then either:',
            '- change the arguments to satisfy the constraint the error describes, OR',
            '- pick a different tool that fits the constraint.',
          ].join('\n'),
          tool_call_id: toolCall.id ?? '',
          name: toolName,
          status: 'error',
        });
      }

      // Identical calls that succeeded in this turn, plus identical calls
      // earlier in this same model response (still running beside this one).
      let identical = 0;
      let lastResult: ToolMessage | undefined;
      for (let i = start; i < messages.length; i++) {
        const msg = messages[i];
        if (!(msg instanceof ToolMessage)) continue;
        if (msg.status === 'error' || msg.name !== toolName) continue;
        const priorArgs = argsById.get(msg.tool_call_id);
        if (priorArgs === undefined) continue;
        if (canonicalArgsKey(priorArgs) !== argsKey) continue;
        identical += 1;
        lastResult = msg;
      }
      for (const sibling of stepCallsBefore(messages, toolCall.id, start)) {
        if (
          sibling.name === toolName &&
          canonicalArgsKey(sibling.args) === argsKey
        )
          identical += 1;
      }
      const effect = options.effectOf?.(toolName) ?? 'read';
      const cap = effect === 'write' ? maxWrites : maxReads;
      if (identical < cap) return handler(toolCallRequest);

      logger.warn(
        `Repetition guard: ${toolName} already ran ${identical} time(s) this turn with these exact arguments (${effect} cap ${cap}); not run again`,
      );
      const earlier = lastResult
        ? ['', 'It returned:', '', excerpt(toolMessageText(lastResult))]
        : [];
      return new ToolMessage({
        content: (effect === 'write'
          ? [
              lastResult
                ? `\`${toolName}\` already ran with these exact arguments in this turn, so it was NOT run again: running it twice would repeat its effect.`
                : `An identical \`${toolName}\` call is already part of this step, so this one was NOT run: running it twice would repeat its effect.`,
              ...earlier,
              '',
              'Use that outcome. If the user wants it done again, confirm with them — they can ask again in a new message.',
            ]
          : [
              `You have already called \`${toolName}\` with these exact arguments ${identical} times in this turn, so it was NOT called again.`,
              ...earlier,
              '',
              'Use the result you have, change the arguments, or pick a different tool.',
            ]
        ).join('\n'),
        tool_call_id: toolCall.id ?? '',
        name: toolName,
        status: 'error',
      });
    },
  });
};

const EXCERPT_CHARS = 800;

function excerpt(text: string): string {
  return text.length <= EXCERPT_CHARS
    ? text
    : `${text.slice(0, EXCERPT_CHARS)}… (${text.length - EXCERPT_CHARS} more characters)`;
}

/** Tool call id → arguments for every AI tool call from `start` on. */
function toolCallArgsById(
  messages: readonly BaseMessage[],
  start: number,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !AIMessage.isInstance(m)) continue;
    for (const tc of m.tool_calls ?? []) if (tc.id) out.set(tc.id, tc.args);
  }
  return out;
}

/** The calls that precede `callId` in the model response that issued it. */
function stepCallsBefore(
  messages: readonly BaseMessage[],
  callId: string | undefined,
  start: number,
): Array<{ name: string; args: unknown }> {
  if (!callId) return [];
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    if (!m || !AIMessage.isInstance(m)) continue;
    const calls = m.tool_calls ?? [];
    const at = calls.findIndex((tc) => tc.id === callId);
    if (at >= 0) return calls.slice(0, at);
  }
  return [];
}

/**
 * Index of the message that opens the current turn: the latest human
 * message, other than the summary the summarizer writes in place of the
 * condensed history (it starts no turn). 0 when there is none.
 */
export function turnStart(messages: readonly BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      HumanMessage.isInstance(message) &&
      !isSummarizationMessage(message)
    )
      return i;
  }
  return 0;
}

function canonicalArgsKey(args: unknown): string {
  if (args === null || args === undefined) return 'null';
  if (typeof args !== 'object') return JSON.stringify(args);
  if (Array.isArray(args)) {
    return `[${args.map(canonicalArgsKey).join(',')}]`;
  }
  const obj = args as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalArgsKey(obj[k])}`).join(',')}}`;
}

function toolMessageText(msg: ToolMessage): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}
