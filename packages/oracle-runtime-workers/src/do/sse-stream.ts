/**
 * LangGraph `streamEvents` → run frames → Server-Sent Events.
 *
 * Wire-compatible port of the Node runtime's `SseStreamRunner`: the same
 * event names and payload shapes the Portal / client SDK parse (`message`,
 * `reasoning`, `tool_call`, `action_call`, `error`, `done`), the same
 * "instant Thinking…" ack, the same 15 s heartbeat comment.
 *
 * Two halves, since runs became durable (docs/plans/durable-runs.md):
 *
 *   - `runTurnFrames` consumes the graph events and pushes every frame into
 *     the run's `RunBuffer` (the source of truth: numbered, packed into
 *     SQLite, replayable). It runs to the end of the turn whoever is or is
 *     not connected; only the run's abort signal stops it.
 *   - `createSseSubscriberStream` is what an HTTP response is: a replay of
 *     the frames after the client's cursor, then the live tail. Cancelling
 *     it (the browser left) only unsubscribes.
 *
 * Every frame carries its sequence number as the SSE `id:` line, so a client
 * that reconnects can ask for `?after=<id>`.
 */
import {
  classifyLlmError,
  isOperatorFault,
  redactOperatorFault,
} from '../llm/provider-error';
import { type AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import {
  isHarnessLimitError,
  type HarnessLimitError,
} from '../core/turn-budget';
import { RunBuffer, type RunFrame } from './run-buffer';

/** Where the producer puts frames — a `RunBuffer`, or a test sink. */
export interface FrameSink {
  push(event: string, data: unknown): RunFrame;
}

export interface TurnFrameProducerInput {
  /** `agent.streamEvents(stateInput, config)` async iterable. */
  events: AsyncIterable<unknown>;
  sink: FrameSink;
  sessionId: string;
  requestId: string;
  /** The run this turn belongs to (in the `run` and `done` frames). */
  runId?: string;
  /** Set on a resumed attempt (the coordinator announced it; no `run` frame here). */
  resumed?: boolean;
  /**
   * Longest tool/action output a frame carries. Wrapped tools are capped
   * before their result exists (result-cap.ts); this is the belt for
   * anything else (a sub-agent's reply), so no multi-megabyte frame ever
   * reaches a client or a segment row.
   */
  toolOutputCapChars?: number;
  abortController: AbortController;
  /** Names declared as client-side AG-UI actions (rendered as `action_call`). */
  agActionNames?: ReadonlySet<string>;
  /** Called with the reply text once the turn finished normally. */
  onComplete?: (fullText: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
  log?: (msg: string) => void;
  /** BYO provider of this turn, when it ran on the user's own credential. */
  byoProvider?: string;
  /**
   * Receives every `tool_call` / `action_call` / `router_update` frame the
   * stream writes, for the session's realtime sockets (the SSE consumer
   * already has them). Payloads carry `sessionId`.
   */
  mirror?: (eventName: string, payload: Record<string, unknown>) => void;
  /** The `done` frame's `messageId` (the final assistant message), when known. */
  messageIdOf?: () => string | undefined;
  /** Called on every frame — the keep-alive touch. */
  onFrame?: () => void;
}

export type TurnFrameOutcome =
  | { status: 'completed'; fullText: string }
  | { status: 'aborted'; fullText: string }
  | { status: 'failed'; fullText: string; error: unknown };

/** Legacy one-shot input: a producer and a subscriber on an in-memory buffer. */
export type SseTurnRunnerInput = Omit<
  TurnFrameProducerInput,
  'sink' | 'onFrame'
>;

const THINKING_PHRASES = [
  'Thinking...',
  'Working...',
  'Analyzing...',
  'Processing...',
  'Reasoning...',
  'Reading...',
  'Synthesizing...',
  'Considering...',
  'Investigating...',
  'Solving...',
  'Reviewing...',
  'Reflecting...',
];

export function pickThinkingPhrase(): string {
  return (
    THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)] ??
    'Thinking...'
  );
}

/**
 * One SSE frame. The sequence number travels as the standard `id:` field,
 * placed after `event:` so the existing frame parsers (which key on the
 * first line) keep working.
 */
export function formatSSE(
  eventType: string,
  data: unknown,
  id?: number,
): string {
  const idLine = id !== undefined && id > 0 ? `id: ${id}\n` : '';
  return `event: ${eventType}\n${idLine}data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * Frames a recovery must never lose, packed at once instead of on the
 * timer: a settled tool/action result (the checkpoint that holds it never
 * re-emits it, so a client re-joining after a reset would otherwise see the
 * call running forever) and `done` (the run's close — its pack also carries
 * the last text). Everything else waits for the timer: a tool's `isRunning`
 * frame is re-emitted by a resumed attempt when the tool runs again, the
 * `run` / `router.update` / `error` frames are informational, and text is
 * what the timer is for. One row per flush interval of output, plus one per
 * settled tool call, is the segment write budget of a turn.
 */
export function isImmediateFrame(event: string, data: unknown): boolean {
  if (event === 'done') return true;
  if (event === 'tool_call' || event === 'action_call')
    return (data as { status?: string } | null)?.status !== 'isRunning';
  return false;
}

interface ToolCallPayload {
  sessionId: string;
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'isRunning' | 'done';
  output?: string;
  eventId?: string;
}

interface ActionCallPayload {
  sessionId: string;
  requestId: string;
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  status: 'isRunning' | 'done' | 'error';
  output?: string;
  error?: string;
}

function extractToolArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') {
    const maybe = input as { input?: unknown };
    if (maybe.input && typeof maybe.input === 'object')
      return maybe.input as Record<string, unknown>;
    return input as Record<string, unknown>;
  }
  return {};
}

/**
 * Model calls whose tokens must never reach the user's reply: the
 * summarizer's own invoke (LangChain tags it `lc_source: 'summarization'`),
 * anything tagged `summarization` or `internal` (sub-agents run under their
 * own run name below the main agent, tagged by subagent-as-tool). Only the
 * outermost agent's model output belongs on the wire.
 */
export function isInternalModelEvent(evt: {
  metadata?: Record<string, unknown>;
  tags?: string[];
}): boolean {
  const source = evt.metadata?.['lc_source'];
  if (source === 'summarization') return true;
  const tags = evt.tags ?? [];
  return tags.some((t) => t === 'summarization' || t === 'internal');
}

function collectBlockStrings(
  content: unknown,
  type: string,
  field: string,
): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === type
      ) {
        const v = (block as Record<string, unknown>)[field];
        return typeof v === 'string' ? v : '';
      }
      return '';
    })
    .join('');
}

function safeParseToolContent(
  content: unknown,
): { success?: boolean; error?: unknown } | null {
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object'
      ? (parsed as { success?: boolean; error?: unknown })
      : null;
  } catch {
    return null;
  }
}

function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return collectBlockStrings(content, 'text', 'text');
  return content == null ? '' : JSON.stringify(content);
}

/** SSE frame name → socket event name (Node's `serverEvents` spelling). */
const MIRRORED_EVENTS: Record<string, string | undefined> = {
  tool_call: 'tool_call',
  action_call: 'action_call',
  'router.update': 'router_update',
};

/**
 * Consume one turn's graph events and push its frames into the sink. Runs
 * to the end whether or not anyone is subscribed; `abortController` is the
 * only way to stop it early. The `done` frame is always the last frame.
 */
export async function runTurnFrames(
  input: TurnFrameProducerInput,
): Promise<TurnFrameOutcome> {
  const { sessionId, requestId, abortController, sink } = input;
  const toolCallMap = new Map<string, ToolCallPayload>();
  const actionCallMap = new Map<string, ActionCallPayload>();
  let fullContent = '';

  const cap = input.toolOutputCapChars;
  const wireCap = (payload: unknown): unknown => {
    if (!cap || !payload || typeof payload !== 'object') return payload;
    const output = (payload as { output?: unknown }).output;
    if (typeof output !== 'string' || output.length <= cap) return payload;
    const budget = Math.max(200, cap - 200);
    const head = Math.floor(budget * 0.4);
    const tail = budget - head;
    return {
      ...payload,
      output: `${output.slice(0, head)}\n\n… [${output.length - head - tail} characters omitted on the wire] …\n\n${output.slice(output.length - tail)}`,
    };
  };
  const write = (eventName: string, rawPayload: unknown) => {
    const payload =
      eventName === 'tool_call' || eventName === 'action_call'
        ? wireCap(rawPayload)
        : rawPayload;
    try {
      sink.push(eventName, payload);
    } catch {
      return;
    }
    input.onFrame?.();
    // Node's WebSocket gateway relays these to the session's sockets as
    // well; message chunks and `done` stay SSE-only, as there.
    const mirrored = MIRRORED_EVENTS[eventName];
    if (mirrored && input.mirror && payload && typeof payload === 'object')
      input.mirror(mirrored, payload as Record<string, unknown>);
  };
  const doneFrame = (extra: Record<string, unknown> = {}) => {
    const messageId = input.messageIdOf?.();
    write('done', {
      ...(input.runId ? { runId: input.runId } : {}),
      ...(messageId ? { messageId } : {}),
      ...extra,
    });
  };

  // A resumed attempt was announced by the coordinator when it was
  // scheduled (its `run` frame carries `resumed`, `attempt`,
  // `partialLength`); only a fresh run opens with the frame here.
  if (input.runId && !input.resumed)
    write('run', { runId: input.runId, sessionId, requestId });
  write('router.update', {
    step: pickThinkingPhrase(),
    sessionId,
    requestId,
    ...(input.runId ? { runId: input.runId } : {}),
  });

  // The turn hit its budget (tokens, tool attempts, deadline): the abort
  // was the harness's, not the user's, so the client gets a terminal
  // `error` naming the limit before `done` — not a silent "aborted".
  const limitFailure = (limit: HarnessLimitError) => {
    flushOrphans();
    write('reasoning', {
      sessionId,
      requestId,
      reasoning: '',
      isComplete: true,
      timestamp: new Date().toISOString(),
    });
    write('error', {
      error: limit.message,
      kind: limit.kind,
      limit: limit.limit,
      source: 'platform',
      retryable: false,
      sessionId,
      requestId,
      timestamp: new Date().toISOString(),
    });
    doneFrame({ failed: true });
    return { status: 'failed' as const, fullText: fullContent, error: limit };
  };

  const flushOrphans = () => {
    for (const evt of actionCallMap.values()) {
      write('action_call', {
        ...evt,
        status: 'error',
        error: 'Action did not complete',
      });
    }
    actionCallMap.clear();
    for (const evt of toolCallMap.values()) {
      write('tool_call', {
        ...evt,
        status: 'done',
        output: '⏱️ Tool did not complete',
      });
    }
    toolCallMap.clear();
  };

  // Tool calls the main agent's model produced, by call id, until their
  // tool run starts. A call whose arguments fail the tool's schema never
  // starts (LangChain validates before the tool's start callback), so
  // `on_tool_start` / `on_tool_end` never fire for it; the error tool
  // message the tools node returns is the only trace. Anything still
  // recorded when that node ends is reported from that message.
  const pendingCalls = new Map<
    string,
    { toolName: string; args: Record<string, unknown> }
  >();
  /**
   * The model's call id for a tool run that is starting. The start event
   * does not carry it, and the arguments it carries are the schema-parsed
   * ones (defaults applied), so they cannot be matched against the model's.
   * The tools node starts the calls of one model turn in the order the model
   * produced them, so the first pending call with this tool's name is it.
   * Keying every frame of a call by that id — the id the transcript uses —
   * is what lets a client show ONE card per call, live and after a refetch.
   */
  const takePendingCall = (toolName: string): string | undefined => {
    for (const [id, call] of pendingCalls) {
      if (call.toolName === toolName) {
        pendingCalls.delete(id);
        return id;
      }
    }
    return undefined;
  };

  try {
    for await (const raw of input.events) {
      if (abortController.signal.aborted) break;
      const evt = raw as {
        event: string;
        run_id: string;
        name?: string;
        data: unknown;
        metadata?: Record<string, unknown>;
        tags?: string[];
      };
      if (evt.event === 'on_chat_model_end') {
        if (isInternalModelEvent(evt)) continue;
        const output = (evt.data as { output?: AIMessageChunk })?.output;
        for (const call of output?.tool_calls ?? []) {
          if (call.id)
            pendingCalls.set(call.id, {
              toolName: call.name,
              args: (call.args ?? {}) as Record<string, unknown>,
            });
        }
        continue;
      }
      if (evt.event === 'on_chain_end' && evt.name === 'tools') {
        if (pendingCalls.size === 0) continue;
        const output = (evt.data as { output?: unknown })?.output;
        const messages: unknown[] = Array.isArray(output)
          ? output
          : Array.isArray((output as { messages?: unknown[] })?.messages)
            ? ((output as { messages: unknown[] }).messages ?? [])
            : [];
        for (const message of messages) {
          if (!ToolMessage.isInstance(message)) continue;
          const call = pendingCalls.get(message.tool_call_id);
          if (!call) continue;
          pendingCalls.delete(message.tool_call_id);
          const text = toText(message.content);
          const failed = message.status === 'error';
          write('tool_call', {
            sessionId,
            requestId,
            toolName: message.name ?? call.toolName,
            args: {
              ...call.args,
              toolName: message.name ?? call.toolName,
            },
            status: failed ? 'error' : 'done',
            output: text,
            ...(failed && { error: text || 'Tool call rejected' }),
            eventId: message.tool_call_id,
          });
        }
        pendingCalls.clear();
        continue;
      }
      if (evt.event === 'on_tool_start') {
        const toolName = evt.name ?? 'tool';
        const args = extractToolArgs((evt.data as { input?: unknown })?.input);
        const callId = takePendingCall(toolName) ?? evt.run_id;
        if (input.agActionNames?.has(toolName)) {
          const payload: ActionCallPayload = {
            requestId,
            sessionId,
            toolCallId: callId,
            toolName,
            args,
            status: 'isRunning',
          };
          actionCallMap.set(evt.run_id, payload);
          write('action_call', payload);
        } else {
          const payload: ToolCallPayload = {
            requestId,
            sessionId,
            toolName,
            args: { ...args, toolName },
            status: 'isRunning',
            eventId: callId,
          };
          toolCallMap.set(evt.run_id, payload);
          write('tool_call', payload);
        }
        continue;
      }
      if (evt.event === 'on_tool_end') {
        const output = (evt.data as { output?: ToolMessage })?.output;
        const text = toText(output?.content);
        const action = actionCallMap.get(evt.run_id);
        if (action) {
          const parsed = safeParseToolContent(output?.content);
          const failed = parsed?.success === false || Boolean(parsed?.error);
          write('action_call', {
            ...action,
            output: text,
            status: failed ? 'error' : 'done',
            ...(failed && {
              error:
                typeof parsed?.error === 'string'
                  ? parsed.error
                  : 'Action failed',
            }),
          });
          actionCallMap.delete(evt.run_id);
          continue;
        }
        const tool = toolCallMap.get(evt.run_id);
        if (tool) {
          // A tool whose call was rejected (schema mismatch) or whose
          // retries ran out comes back as a ToolMessage with
          // `status: 'error'`, not as `on_tool_error`; the client must
          // see it as failed, not as a finished call with odd output.
          const failed = output?.status === 'error';
          write('tool_call', {
            ...tool,
            status: failed ? 'error' : 'done',
            output: text,
            ...(failed && { error: text || 'Tool failed' }),
            args: {
              ...tool.args,
              toolName: output?.name ?? tool.toolName,
            },
          });
          toolCallMap.delete(evt.run_id);
        }
        continue;
      }
      if (evt.event === 'on_tool_error') {
        // A tool that threw (retries exhausted, upstream down, MCP
        // timeout) never emits `on_tool_end`; without this branch the
        // client only learns "did not complete" at stream end.
        const raw = (evt.data as { error?: unknown })?.error;
        const message =
          raw instanceof Error ? raw.message : String(raw ?? 'Tool failed');
        const action = actionCallMap.get(evt.run_id);
        if (action) {
          write('action_call', {
            ...action,
            output: message,
            status: 'error',
            error: message,
          });
          actionCallMap.delete(evt.run_id);
          continue;
        }
        const tool = toolCallMap.get(evt.run_id);
        if (tool) {
          write('tool_call', {
            ...tool,
            status: 'done',
            output: `⚠️ ${message}`,
          });
          toolCallMap.delete(evt.run_id);
        }
        continue;
      }
      if (evt.event === 'on_chat_model_stream') {
        if (isInternalModelEvent(evt)) continue;
        const chunk = (evt.data as { chunk?: AIMessageChunk })?.chunk;
        if (!chunk) continue;
        const raw = chunk.additional_kwargs?.__raw_response as
          | {
              choices?: Array<{
                delta?: {
                  reasoning?: string;
                  reasoning_content?: string;
                  reasoning_details?: unknown[];
                };
              }>;
            }
          | undefined;
        const delta = raw?.choices?.[0]?.delta;
        const deltaReasoning = delta?.reasoning ?? delta?.reasoning_content;
        const reasoning = deltaReasoning?.trim()
          ? deltaReasoning
          : collectBlockStrings(chunk.content, 'reasoning', 'reasoning');
        if (reasoning && reasoning.trim()) {
          const details = Array.isArray(delta?.reasoning_details)
            ? delta.reasoning_details
                .filter(
                  (d): d is { type: string; text: string } =>
                    !!d &&
                    typeof d === 'object' &&
                    typeof (d as { type?: unknown }).type === 'string' &&
                    typeof (d as { text?: unknown }).text === 'string' &&
                    (d as { text: string }).text.trim().length > 0,
                )
                .map((d) => ({
                  type: d.type,
                  text: d.text,
                  format: 'unknown',
                  index: 0,
                }))
            : undefined;
          write('reasoning', {
            sessionId,
            requestId,
            reasoning,
            ...(details && { reasoningDetails: details }),
            isComplete: false,
            timestamp: new Date().toISOString(),
          });
        }
        const text =
          typeof chunk.content === 'string'
            ? chunk.content
            : collectBlockStrings(chunk.content, 'text', 'text');
        if (text) {
          fullContent += text;
          write('message', {
            content: text,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
    if (!abortController.signal.aborted) {
      flushOrphans();
      write('reasoning', {
        sessionId,
        requestId,
        reasoning: '',
        isComplete: true,
        timestamp: new Date().toISOString(),
      });
      await input.onComplete?.(fullContent);
      doneFrame();
      return { status: 'completed', fullText: fullContent };
    }
    const reason: unknown = abortController.signal.reason;
    if (isHarnessLimitError(reason)) return limitFailure(reason);
    // Aborted (POST /messages/abort, or superseded): close the stream
    // cleanly so the UI leaves its "thinking" state.
    flushOrphans();
    doneFrame({ aborted: true });
    return { status: 'aborted', fullText: fullContent };
  } catch (error) {
    if (isHarnessLimitError(error)) return limitFailure(error);
    const reason: unknown = abortController.signal.reason;
    if (isHarnessLimitError(reason)) return limitFailure(reason);
    // The run's signal is the authority: LangGraph rethrows the signal's
    // reason (whatever the aborter passed), not always an `AbortError`.
    const aborted =
      abortController.signal.aborted ||
      (error instanceof Error &&
        (error.name === 'AbortError' || /abort/i.test(error.message)));
    if (aborted) {
      flushOrphans();
      doneFrame({ aborted: true });
      return { status: 'aborted', fullText: fullContent };
    }
    input.onError?.(error);
    flushOrphans();
    write('reasoning', {
      sessionId,
      requestId,
      reasoning: '',
      isComplete: true,
      timestamp: new Date().toISOString(),
    });
    // Same wire shape as the Node runtime's `sendSSEError`: the
    // classification is redacted here — the one place an LLM failure
    // becomes bytes on a client's wire.
    const classified = classifyLlmError(error, {
      byoProvider: input.byoProvider,
    });
    if (isOperatorFault(classified))
      input.log?.(
        `OPERATOR FAULT (platform ${classified.kind}) on turn ${requestId}: ${classified.detail}`,
      );
    const safe = redactOperatorFault(classified);
    write('error', {
      error: safe.message,
      kind: safe.kind,
      source: safe.source,
      ...(safe.provider && { provider: safe.provider }),
      ...(safe.providerLabel && { providerLabel: safe.providerLabel }),
      ...(safe.status !== undefined && { status: safe.status }),
      retryable: safe.retryable,
      detail: safe.detail,
      sessionId,
      requestId,
      timestamp: new Date().toISOString(),
    });
    doneFrame({ failed: true });
    return { status: 'failed', fullText: fullContent, error };
  }
}

export interface SseSubscriberInput {
  /** Frames to replay first (from segments and the buffer's tail), in order. */
  replay: readonly RunFrame[];
  /** Live source; omitted for a run that already ended (replay, then done). */
  buffer?: RunBuffer;
  /** Emitted after the replay when there is no live buffer and no `done` was replayed. */
  trailer?: { event: string; data: unknown };
  heartbeatMs?: number;
  /** The client went away (the run is NOT stopped). */
  onCancel?: () => void;
}

/**
 * An SSE response body over a run: the replay, then every live frame until
 * the `done` frame. Cancelling only detaches.
 */
export function createSseSubscriberStream(
  input: SseSubscriberInput,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const write = (frame: RunFrame) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(formatSSE(frame.event, frame.data, frame.seq)),
          );
        } catch {
          closed = true;
          return;
        }
        if (frame.event === 'done') finish();
      };
      for (const frame of input.replay) write(frame);
      if (closed) return;
      if (input.buffer && !input.buffer.isClosed) {
        unsubscribe = input.buffer.subscribe(write);
      } else {
        if (input.trailer)
          write({
            seq: 0,
            event: input.trailer.event,
            data: input.trailer.data,
          });
        finish();
        return;
      }
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          closed = true;
        }
      }, input.heartbeatMs ?? 15_000);
    },
    cancel: () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      input.onCancel?.();
    },
  });
}

/**
 * One-shot turn stream (no durability): a private buffer, the producer
 * running behind it, and a subscriber from the first frame. Kept for the
 * unit tests and hosts that do not persist runs. Cancelling the stream
 * aborts the turn, as the pre-durable runtime did.
 */
export function createSseTurnStream(
  input: SseTurnRunnerInput,
): ReadableStream<Uint8Array> {
  const buffer = new RunBuffer({
    flushMs: 60_000,
    flushBytes: Number.MAX_SAFE_INTEGER,
    onPack: () => undefined,
    setTimer: () => null,
    clearTimer: () => undefined,
  });
  const stream = createSseSubscriberStream({
    replay: [],
    buffer,
    onCancel: () => input.abortController.abort(),
  });
  void runTurnFrames({ ...input, sink: buffer }).finally(() => buffer.close());
  return stream;
}
