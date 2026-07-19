import {
  ActionCallEvent,
  ReasoningEvent,
  ToolCallEvent,
} from '@ixo/oracles-events';
import type { AIMessageChunk, ToolMessage } from 'langchain';
import { emojify } from '../utils/emoji.js';

interface RawDelta {
  reasoning?: string;
  reasoning_content?: string | null;
  reasoning_details?: unknown;
}

interface RawResponse {
  choices?: Array<{ delta?: RawDelta }>;
}

/** One translated wire event — the transport-agnostic (name, payload) pair. */
export interface TranslatedEvent {
  event: string;
  payload: unknown;
}

/**
 * The slice of a LangChain `streamEvents` v2 envelope the translator reads.
 * Kept structural (not imported from LangChain's tracer types) so callers
 * can feed recorded envelopes in tests.
 */
export interface AgentStreamEnvelope {
  event: string;
  run_id: string;
  name?: string;
  data: unknown;
}

/**
 * Parse a `ToolMessage.content` payload into a JSON object when possible.
 * Returns `null` if the content is a non-JSON string, an array of content
 * blocks (LangChain multi-modal output), or anything else we can't reason
 * about. Used by the action-call status decoder to detect failures.
 */
function safeParseToolContent(
  content: unknown,
): Record<string, unknown> | null {
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON text — fall through.
    }
    return null;
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  return null;
}

/**
 * Unwrap the args object emitted on `on_tool_start.data.input`. MCP tools
 * surface their args as `{ input: "<json-string>" }` because their schema
 * accepts a single stringified payload — parse the inner JSON so the
 * frontend sees the real fields. For native tools, `input` is already
 * the parsed args object and is returned as-is.
 */
function extractToolArgs(input: unknown): Record<string, unknown> | undefined {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (
    keys.length === 1 &&
    keys[0] === 'input' &&
    typeof obj.input === 'string'
  ) {
    try {
      const parsed: unknown = JSON.parse(obj.input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — fall through and return the wrapper as-is.
    }
  }
  return obj;
}

export interface StreamTranslatorOptions {
  sessionId: string;
  requestId: string;
  /**
   * Names of client-side AG-UI actions. Tool starts whose name is in this
   * set are emitted as `ActionCallEvent`s instead of `ToolCallEvent`s.
   */
  agActionNames: ReadonlySet<string>;
}

/**
 * Stateful per-turn translator: LangChain `streamEvents` v2 envelopes in,
 * ordered wire events out. Pure of transport — no express, no sockets, no
 * timers — so the same translation runs under Node SSE today and a Worker
 * transport later.
 *
 * Wire semantics preserved verbatim from the legacy SSE runner:
 *
 *   - `on_tool_start`  → ToolCallEvent/ActionCallEvent `isRunning` (keyed by
 *     `run_id` so the matching end event pairs up regardless of how the
 *     model formatted the original `tool_call_id`)
 *   - `on_tool_end`    → the same event instance completed (`done`, or
 *     decoded `error` for actions)
 *   - `on_chat_model_stream` → `reasoning` chunks (from the raw provider
 *     delta) and plain `message` chunks (emojified)
 *   - `flushOrphans()` → terminal frames for tool/action calls that never
 *     received an end event, so no client spinner sticks forever
 *   - `completionEvent()` → the reasoning completion marker
 */
export function createStreamTranslator(options: StreamTranslatorOptions) {
  const { sessionId, requestId, agActionNames } = options;

  const toolCallMap = new Map<string, ToolCallEvent>();
  const actionCallMap = new Map<string, ActionCallEvent>();
  let fullContent = '';

  function handleToolStart(
    runId: string,
    toolName: string,
    data: { input: unknown },
  ): TranslatedEvent[] {
    const args = extractToolArgs(data.input);

    if (agActionNames.has(toolName)) {
      const actionCallEvent = new ActionCallEvent({
        requestId,
        sessionId,
        toolCallId: runId,
        toolName,
        args,
        status: 'isRunning',
      });
      actionCallMap.set(runId, actionCallEvent);
      return [
        { event: actionCallEvent.eventName, payload: actionCallEvent.payload },
      ];
    }

    const toolCallEvent = new ToolCallEvent({
      requestId,
      sessionId,
      toolName,
      args: args ?? {},
      status: 'isRunning',
    });
    (toolCallEvent.payload.args as Record<string, unknown>).toolName = toolName;
    toolCallEvent.payload.eventId = runId;
    toolCallMap.set(runId, toolCallEvent);
    return [{ event: toolCallEvent.eventName, payload: toolCallEvent.payload }];
  }

  function handleToolEnd(
    runId: string,
    data: { output: ToolMessage },
  ): TranslatedEvent[] {
    const toolMessage = data.output;

    const actionCallEvent = actionCallMap.get(runId);
    if (actionCallEvent) {
      actionCallEvent.payload.output = emojify(toolMessage.content.toString());
      actionCallEvent.payload.toolCallId = runId;
      const parsed = safeParseToolContent(toolMessage.content);
      if (parsed?.success === false || parsed?.error) {
        actionCallEvent.payload.status = 'error';
        actionCallEvent.payload.error =
          (parsed.error as string) || 'Action failed';
      } else {
        actionCallEvent.payload.status = 'done';
      }
      actionCallMap.delete(runId);
      return [
        { event: actionCallEvent.eventName, payload: actionCallEvent.payload },
      ];
    }

    const toolCallEvent = toolCallMap.get(runId);
    if (!toolCallEvent) return [];
    toolCallEvent.payload.output = emojify(toolMessage.content);
    toolCallEvent.payload.status = 'done';
    (toolCallEvent.payload.args as Record<string, unknown>).toolName =
      toolMessage.name;
    toolCallEvent.payload.eventId = runId;
    toolCallMap.delete(runId);
    return [{ event: toolCallEvent.eventName, payload: toolCallEvent.payload }];
  }

  /**
   * Emits reasoning + text chunks. Tool-call emission happens on
   * `on_tool_start` (which fires with full, finalized args) — the chunk's
   * partial `tool_calls` deltas are intentionally ignored here to avoid
   * emitting an `isRunning` event with empty args before the model
   * finishes producing the call.
   */
  function handleChatStream(data: {
    chunk: AIMessageChunk;
  }): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    const chunk = data.chunk;
    const rawResponse = chunk.additional_kwargs?.__raw_response as
      | RawResponse
      | undefined;
    const delta = rawResponse?.choices?.[0]?.delta;
    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoning && reasoning.trim()) {
      const reasoningDetails = Array.isArray(delta?.reasoning_details)
        ? delta.reasoning_details
            .filter(
              (d): d is { type: string; text: string } =>
                d != null &&
                typeof d === 'object' &&
                typeof (d as { type?: unknown }).type === 'string' &&
                typeof (d as { text?: unknown }).text === 'string' &&
                (d as { text: string }).text.trim().length > 0,
            )
            .map((d) => ({ type: d.type, text: d.text }))
        : undefined;
      const reasoningEvent = ReasoningEvent.createChunk(
        sessionId,
        requestId,
        reasoning,
        reasoningDetails,
        false,
      );
      out.push({
        event: reasoningEvent.eventName,
        payload: reasoningEvent.payload,
      });
    }

    const content = chunk.content;
    if (!content) return out;
    const parsed = emojify(String(content));
    fullContent += parsed;
    out.push({
      event: 'message',
      payload: { content: parsed, timestamp: new Date().toISOString() },
    });
    return out;
  }

  return {
    /** Translate one stream envelope into zero-or-more ordered wire events. */
    translate(evt: unknown): TranslatedEvent[] {
      const { data, event, run_id, name } = evt as AgentStreamEnvelope;
      if (event === 'on_tool_start') {
        return handleToolStart(
          run_id,
          name ?? 'tool',
          data as {
            input: unknown;
          },
        );
      }
      if (event === 'on_tool_end') {
        return handleToolEnd(run_id, data as { output: ToolMessage });
      }
      if (event === 'on_chat_model_stream') {
        return handleChatStream(data as { chunk: AIMessageChunk });
      }
      return [];
    },

    /**
     * Terminal frames for any tool/action call that started but never
     * received a matching `on_tool_end`. Keeps the frontend from showing a
     * perpetually-spinning tool when the agent ends a turn with unresolved
     * tool runs in flight.
     */
    flushOrphans(): TranslatedEvent[] {
      const out: TranslatedEvent[] = [];
      for (const [runId, evt] of actionCallMap) {
        evt.payload.status = 'error';
        evt.payload.error = 'Action did not complete';
        evt.payload.toolCallId = runId;
        out.push({ event: evt.eventName, payload: evt.payload });
      }
      actionCallMap.clear();

      for (const [runId, evt] of toolCallMap) {
        // `IToolCallEvent.status` only allows 'isRunning' | 'done' — there's
        // no error variant on tool calls (unlike actions). Mark as 'done'
        // with a sentinel output so the FE clears its spinner but the user
        // sees the call didn't actually produce a result.
        evt.payload.status = 'done';
        evt.payload.output = '⏱️ Tool did not complete';
        evt.payload.eventId = runId;
        out.push({ event: evt.eventName, payload: evt.payload });
      }
      toolCallMap.clear();
      return out;
    },

    /** The reasoning completion marker ending a successful turn. */
    completionEvent(): TranslatedEvent {
      const completeEvent = ReasoningEvent.createChunk(
        sessionId,
        requestId,
        '',
        undefined,
        true,
      );
      return { event: completeEvent.eventName, payload: completeEvent.payload };
    },

    /** Assistant text accumulated from `message` chunks so far. */
    get fullContent(): string {
      return fullContent;
    },
  };
}

export type StreamTranslator = ReturnType<typeof createStreamTranslator>;
