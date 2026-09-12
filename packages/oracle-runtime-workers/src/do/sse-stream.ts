/**
 * LangGraph `streamEvents` → Server-Sent Events, as a Web `ReadableStream`.
 *
 * Wire-compatible port of the Node runtime's `SseStreamRunner`: the same
 * event names and payload shapes the Portal / client SDK parse
 * (`message`, `reasoning`, `tool_call`, `action_call`, `error`, `done`),
 * the same "instant Thinking…" ack, the same 15 s heartbeat comment.
 *
 * On Workers the response body is a stream we write into; the client
 * disconnecting cancels the stream, which aborts the run.
 */
import {
  classifyLlmError,
  isOperatorFault,
  redactOperatorFault,
} from '../llm/provider-error';
import type { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import { isToolMessage } from '@langchain/core/messages';

export interface SseTurnRunnerInput {
  /** `agent.streamEvents(stateInput, config)` async iterable. */
  events: AsyncIterable<unknown>;
  sessionId: string;
  requestId: string;
  abortController: AbortController;
  /** Names declared as client-side AG-UI actions (rendered as `action_call`). */
  agActionNames?: ReadonlySet<string>;
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
}

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

export function formatSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

interface ToolCallPayload {
  sessionId: string;
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'isRunning' | 'done' | 'error';
  output?: string;
  eventId?: string;
  /** Set with `status: 'error'`: what the tool reported (schema rejection, retries exhausted). */
  error?: string;
}

/**
 * Model calls the agent makes for itself — the summarization middleware
 * condensing the thread, a sub-agent's inner turn — stream through the same
 * `streamEvents` pipe as the user-facing reply. Only the outermost agent's
 * model output belongs on the wire; everything else is bookkeeping the user
 * never asked to read (the "Here is a summary of the conversation to date"
 * leak). The summarizer tags its invoke with `lc_source: 'summarization'`;
 * sub-agents run under their own run name below the main agent.
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

/**
 * Build the SSE body for one turn. The returned stream starts emitting the
 * Thinking… ack immediately; `events` is consumed lazily once the consumer
 * reads. Errors inside the run become an `error` frame followed by `done`.
 */
/** SSE frame name → socket event name (Node's `serverEvents` spelling). */
const MIRRORED_EVENTS: Record<string, string | undefined> = {
  tool_call: 'tool_call',
  action_call: 'action_call',
  'router.update': 'router_update',
};

export function createSseTurnStream(
  input: SseTurnRunnerInput,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { sessionId, requestId, abortController } = input;
  const toolCallMap = new Map<string, ToolCallPayload>();
  const actionCallMap = new Map<string, ActionCallPayload>();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const write = (
        eventName: string,
        payload: unknown,
        opts: { force?: boolean } = {},
      ) => {
        if (closed || (abortController.signal.aborted && !opts.force)) return;
        try {
          controller.enqueue(encoder.encode(formatSSE(eventName, payload)));
        } catch {
          closed = true;
        }
        // Node's WebSocket gateway relays these to the session's sockets as
        // well; message chunks and `done` stay SSE-only, as there.
        const mirrored = MIRRORED_EVENTS[eventName];
        if (mirrored && input.mirror && payload && typeof payload === 'object')
          input.mirror(mirrored, payload as Record<string, unknown>);
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      write('router.update', {
        step: pickThinkingPhrase(),
        sessionId,
        requestId,
      });
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          closed = true;
        }
      }, 15_000);

      const flushOrphans = () => {
        for (const [runId, evt] of actionCallMap) {
          write('action_call', {
            ...evt,
            status: 'error',
            error: 'Action did not complete',
            toolCallId: runId,
          });
        }
        actionCallMap.clear();
        for (const [runId, evt] of toolCallMap) {
          write('tool_call', {
            ...evt,
            status: 'done',
            output: '⏱️ Tool did not complete',
            eventId: runId,
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
      const sameArgs = (a: unknown, b: unknown) => {
        try {
          return JSON.stringify(a) === JSON.stringify(b);
        } catch {
          return false;
        }
      };
      const forgetStartedCall = (toolName: string, args: unknown) => {
        for (const [id, call] of pendingCalls) {
          if (call.toolName === toolName && sameArgs(call.args, args)) {
            pendingCalls.delete(id);
            return;
          }
        }
      };

      const run = async () => {
        let fullContent = '';
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
                if (!isToolMessage(message)) continue;
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
              const args = extractToolArgs(
                (evt.data as { input?: unknown })?.input,
              );
              forgetStartedCall(toolName, args);
              if (input.agActionNames?.has(toolName)) {
                const payload: ActionCallPayload = {
                  requestId,
                  sessionId,
                  toolCallId: evt.run_id,
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
                  eventId: evt.run_id,
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
                const failed =
                  parsed?.success === false || Boolean(parsed?.error);
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
                  eventId: evt.run_id,
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
                raw instanceof Error
                  ? raw.message
                  : String(raw ?? 'Tool failed');
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
                  eventId: evt.run_id,
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
              const deltaReasoning =
                delta?.reasoning ?? delta?.reasoning_content;
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
            write('done', {});
            await input.onComplete?.(fullContent);
          } else {
            // Aborted by the client (POST /messages/abort): close the stream
            // cleanly so the UI leaves its "thinking" state.
            write('done', {}, { force: true });
          }
        } catch (error) {
          const aborted =
            error instanceof Error &&
            (error.name === 'AbortError' || /abort/i.test(error.message));
          if (!aborted) {
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
          }
          write('done', {}, { force: true });
        } finally {
          finish();
        }
      };
      void run();
    },
    cancel: () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      abortController.abort();
    },
  });
}
