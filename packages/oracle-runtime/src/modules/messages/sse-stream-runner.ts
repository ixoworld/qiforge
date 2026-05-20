import {
  ActionCallEvent,
  ReasoningEvent,
  ToolCallEvent,
} from '@ixo/oracles-events';
import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AIMessageChunk, type BaseMessage, ToolMessage } from 'langchain';
import { emojify } from '../../utils/emoji.js';
import { AgentBuilder } from './agent-builder.js';
import { type SendMessagePayload } from './dto/send-message.dto.js';
import { type PreparedRequest } from './request-preparer.js';
import {
  emitSSEEvent,
  formatSSE,
  runWithSSEContext,
  sendSSEDone,
  sendSSEError,
  setSSEHeaders,
  startSSEHeartbeat,
} from './sse.utils.js';

interface RawDelta {
  reasoning?: string;
  reasoning_content?: string | null;
  reasoning_details?: unknown;
}

interface RawResponse {
  choices?: Array<{ delta?: RawDelta }>;
}

const THINKING_PHRASES = [
  'Thinking...',
  'Working...',
  'Analyzing...',
  'Processing...',
  'Computing...',
  'Crunching...',
  'Deliberating...',
  'Reasoning...',
  'Calculating...',
  'Evaluating...',
  'Pondering...',
  'Reading...',
  'Synthesizing...',
  'Formulating...',
  'Considering...',
  'Exploring ideas...',
  'Investigating...',
  'Brainstorming...',
  'Solving...',
  'Reviewing...',
  'Reflecting...',
];

function pickThinkingPhrase(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]!;
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

export interface StreamRunInput {
  payload: SendMessagePayload & {
    msgFromMatrixRoom?: boolean;
    clientType?: 'matrix' | 'slack' | 'portal';
  };
  prepared: PreparedRequest;
  inputMessages: BaseMessage[];
  res: Response;
  abortControllers: Map<string, AbortController>;
  /**
   * Called once the agent stream completes with the assembled assistant
   * content, so the orchestrator can fire-and-forget Matrix replay and
   * post-message sync without coupling SseStreamRunner to either.
   */
  onComplete?: (assistantText: string) => void;
}

/**
 * Owns the SSE side of the chat request: headers, heartbeat, abort
 * controller registration, and the for-await loop translating
 * `streamEvents` output into the wire format the frontend consumes.
 *
 * Event types preserved verbatim from the legacy implementation:
 *
 *   - `ReasoningEvent` (thinking + chunked reasoning + completion marker)
 *   - `ToolCallEvent`  (server-executed tools — fired on `tool_calls`)
 *   - `ActionCallEvent` (AG-UI actions — same `tool_calls` channel but
 *      named in `payload.agActions`; the runner branches on the name)
 *   - `message` chunk (plain assistant text)
 *   - `error` + `done`
 *
 * The SSE headers and the first `Thinking...` event are emitted by
 * `MessagesController` BEFORE the orchestrator hands off — this class
 * picks up after the connection is open, so we don't pay the pre-flight
 * latency before the client knows the request was accepted.
 */
@Injectable()
export class SseStreamRunner {
  private readonly logger = new Logger(SseStreamRunner.name);

  constructor(private readonly agentBuilder: AgentBuilder) {}

  async run(input: StreamRunInput): Promise<void> {
    const { payload, prepared, inputMessages, res, abortControllers } = input;
    const { sessionId, requestId } = prepared;

    // SSE headers + heartbeat may already be set by the controller (early
    // flush). Set them defensively here in case run() is called directly.
    if (!res.headersSent) {
      setSSEHeaders(res, requestId);
      res.flushHeaders();
    }
    const heartbeat = startSSEHeartbeat(res);
    const abortController = new AbortController();

    const existingController = abortControllers.get(sessionId);
    if (existingController) {
      existingController.abort();
    }
    abortControllers.set(sessionId, abortController);

    const onClose = () => abortController.abort();
    res.on('close', onClose);

    try {
      await runWithSSEContext(
        res,
        async () => {
          const thinkingText = pickThinkingPhrase();
          const thinkingEvent = ReasoningEvent.createChunk(
            sessionId,
            requestId,
            thinkingText,
            [{ type: 'thinking', text: thinkingText }],
            false,
          );
          emitSSEEvent(thinkingEvent);
          thinkingEvent.emit();

          const { agent, stateInput, langGraphConfig } =
            await this.agentBuilder.build(
              { payload, prepared, inputMessages },
              abortController,
            );

          // ReactAgent.streamEvents returns the same `{event, data, tags}`
          // shape as LangChain's `streamEvents v2` — the v2 envelope is the
          // default for ReactAgent in langchain@1.4, no extra option needed.
          const stream = agent.streamEvents(stateInput, langGraphConfig);

          let fullContent = '';
          const toolCallMap = new Map<string, ToolCallEvent>();
          const actionCallMap = new Map<string, ActionCallEvent>();
          const agActionNames = new Set(
            (payload.agActions ?? []).map((a) => a.name),
          );

          for await (const evt of stream) {
            if (abortController.signal.aborted) break;
            const { data, event, run_id, name } = evt as {
              data: unknown;
              event: string;
              run_id: string;
              name?: string;
            };

            if (event === 'on_tool_start') {
              this.handleToolStart(
                run_id,
                name ?? 'tool',
                data as { input: unknown },
                sessionId,
                requestId,
                agActionNames,
                toolCallMap,
                actionCallMap,
                res,
                abortController,
              );
              continue;
            }

            if (event === 'on_tool_end') {
              this.handleToolEnd(
                run_id,
                data as { output: ToolMessage },
                toolCallMap,
                actionCallMap,
                res,
                abortController,
              );
              continue;
            }

            if (event === 'on_chat_model_stream') {
              const chunkContent = this.handleChatStream(
                data as { chunk: AIMessageChunk },
                sessionId,
                requestId,
                res,
                abortController,
              );
              if (chunkContent) fullContent += chunkContent;
            }
          }

          if (!abortController.signal.aborted) {
            const completeEvent = ReasoningEvent.createChunk(
              sessionId,
              requestId,
              '',
              undefined,
              true,
            );
            if (!res.writableEnded) {
              res.write(
                formatSSE(completeEvent.eventName, completeEvent.payload),
              );
            }
            sendSSEDone(res);
            input.onComplete?.(fullContent);
          }
        },
        abortController,
      );
    } catch (error) {
      const aborted =
        error instanceof Error &&
        (error.name === 'AbortError' ||
          error.message.includes('aborted') ||
          error.message.includes('Stream aborted by client'));
      if (aborted) {
        if (!res.writableEnded) sendSSEDone(res);
        return;
      }
      this.logger.error('Stream failed', error);
      if (!res.writableEnded && !abortController.signal.aborted) {
        sendSSEError(
          res,
          error instanceof Error ? error : 'Something went wrong',
        );
        sendSSEDone(res);
      }
    } finally {
      clearInterval(heartbeat);
      res.off('close', onClose);
      abortControllers.delete(sessionId);
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * Fires when an agent invokes a tool. `data.input` carries the fully
   * parsed args — the right place to emit the `isRunning` event with
   * complete args. We key the map by `run_id` from the event envelope so
   * the matching `on_tool_end` (which shares the same `run_id`) can pair
   * with it regardless of how the model formatted the original
   * `tool_call_id`.
   */
  private handleToolStart(
    runId: string,
    toolName: string,
    data: { input: unknown },
    sessionId: string,
    requestId: string,
    agActionNames: Set<string>,
    toolCallMap: Map<string, ToolCallEvent>,
    actionCallMap: Map<string, ActionCallEvent>,
    res: Response,
    abortController: AbortController,
  ): void {
    const args = extractToolArgs(data.input);
    const isAction = agActionNames.has(toolName);

    if (isAction) {
      const actionCallEvent = new ActionCallEvent({
        requestId,
        sessionId,
        toolCallId: runId,
        toolName,
        args,
        status: 'isRunning',
      });
      this.writeSse(
        res,
        abortController,
        actionCallEvent.eventName,
        actionCallEvent.payload,
      );
      actionCallMap.set(runId, actionCallEvent);
      return;
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
    this.writeSse(
      res,
      abortController,
      toolCallEvent.eventName,
      toolCallEvent.payload,
    );
    toolCallMap.set(runId, toolCallEvent);
  }

  private handleToolEnd(
    runId: string,
    data: { output: ToolMessage },
    toolCallMap: Map<string, ToolCallEvent>,
    actionCallMap: Map<string, ActionCallEvent>,
    res: Response,
    abortController: AbortController,
  ): void {
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
      this.writeSse(
        res,
        abortController,
        actionCallEvent.eventName,
        actionCallEvent.payload,
      );
      actionCallMap.delete(runId);
      return;
    }

    const toolCallEvent = toolCallMap.get(runId);
    if (!toolCallEvent) return;
    toolCallEvent.payload.output = emojify(toolMessage.content);
    toolCallEvent.payload.status = 'done';
    (toolCallEvent.payload.args as Record<string, unknown>).toolName =
      toolMessage.name;
    toolCallEvent.payload.eventId = runId;
    this.writeSse(
      res,
      abortController,
      toolCallEvent.eventName,
      toolCallEvent.payload,
    );
    toolCallMap.delete(runId);
  }

  /**
   * Emits reasoning + text chunks. Tool-call emission has moved to
   * `handleToolStart` (which fires on `on_tool_start` with full,
   * finalized args) — the chunk's partial `tool_calls` deltas are
   * intentionally ignored here to avoid emitting an `isRunning` event
   * with empty args before the model finishes producing the call.
   */
  private handleChatStream(
    data: { chunk: AIMessageChunk },
    sessionId: string,
    requestId: string,
    res: Response,
    abortController: AbortController,
  ): string | undefined {
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
      this.writeSse(
        res,
        abortController,
        reasoningEvent.eventName,
        reasoningEvent.payload,
      );
    }

    const content = chunk.content;
    if (!content) return undefined;
    const parsed = emojify(String(content));
    this.writeSse(res, abortController, 'message', {
      content: parsed,
      timestamp: new Date().toISOString(),
    });
    return parsed;
  }

  private writeSse(
    res: Response,
    abortController: AbortController,
    eventName: string,
    payload: unknown,
  ): void {
    if (res.writableEnded || abortController.signal.aborted) return;
    res.write(formatSSE(eventName, payload));
  }
}
