import { ReasoningEvent } from '@ixo/oracles-events';
import { Injectable, Logger } from '@nestjs/common';
import { once } from 'node:events';
import type { Response } from 'express';
import { type BaseMessage } from 'langchain';
import { handleTurn } from '../../turn/handle-turn.js';
import type { TurnStreamSink } from '../../turn/turn-stream.js';
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
 * The Node/express TRANSPORT SHELL of the chat request: headers, heartbeat,
 * abort-controller registration, the ALS SSE context, and the terminal
 * `done`/`error` wire frames. The turn itself — translating `streamEvents`
 * output into ordered wire events, flushing orphaned tool calls, the
 * completion marker — lives in the transport-neutral `handleTurn`
 * (`src/turn/`), which this class drives through an SSE `TurnStreamSink`.
 *
 * Wire format is unchanged from the legacy implementation:
 *
 *   - `ReasoningEvent` (thinking + chunked reasoning + completion marker)
 *   - `ToolCallEvent`  (server-executed tools — fired on `on_tool_start`)
 *   - `ActionCallEvent` (AG-UI actions — same channel, named in
 *      `payload.agActions`; the translator branches on the name)
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

          const { fullContent, aborted } = await handleTurn({
            stream,
            sessionId,
            requestId,
            agActionNames: new Set(
              (payload.agActions ?? []).map((a) => a.name),
            ),
            signal: abortController.signal,
            sink: this.createSseSink(res, abortController),
          });

          if (!aborted) {
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
      // Only clear the map entry if it still points at *our* controller. A
      // newer same-session request replaces the entry at the top of `run()`
      // (aborting us first); deleting unconditionally here would drop that
      // newer request's controller and make it un-abortable.
      if (abortControllers.get(sessionId) === abortController) {
        abortControllers.delete(sessionId);
      }
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * Frames → SSE lines. The write guard mirrors the legacy runner exactly
   * (`writableEnded`/aborted are silent skips, not errors). A saturated
   * socket (`res.write` returning `false`) pauses the turn loop until
   * `drain` instead of buffering unboundedly; the wait is tied to the
   * abort signal so a client disconnect mid-backpressure aborts the turn
   * rather than hanging it. Terminal `done`/`error` wire frames belong to
   * the shell, so `close` has nothing to add here.
   */
  private createSseSink(
    res: Response,
    abortController: AbortController,
  ): TurnStreamSink {
    return {
      write: async (frame) => {
        if (res.writableEnded || abortController.signal.aborted) return;
        const flushed = res.write(formatSSE(frame.event, frame.payload));
        if (flushed === false) {
          await once(res, 'drain', { signal: abortController.signal });
        }
      },
      close: async () => undefined,
    };
  }
}
