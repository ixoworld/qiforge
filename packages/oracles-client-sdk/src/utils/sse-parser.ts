/* eslint-disable no-console */
/**
 * SSE (Server-Sent Events) stream parser for handling real-time events
 * from the backend streaming API.
 */

// Base SSE event structure
export interface BaseSSEEvent<TEvent extends string, TData> {
  event: TEvent;
  data: TData;
  /**
   * The frame's sequence number (the SSE `id:` field) on runtimes with
   * durable runs. A client that reconnects asks `GET /runs/:runId?after=<id>`
   * for everything after the last id it saw.
   */
  id?: number;
}

// Individual event data types
export interface SSEMessageEventData {
  content: string;
  timestamp: string;
}

export interface SSEToolCallEventData {
  sessionId: string;
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'isRunning' | 'done' | 'error';
  output?: string;
  error?: string;
  eventId?: string;
}

export interface SSEErrorEventData {
  error: string;
  timestamp: string;
  kind?: string;
  retryable?: boolean;
  detail?: string;
  runId?: string;
}

/**
 * The last frame of a turn. On runtimes with durable runs it names the run
 * and the final message, and says how the run ended when it did not finish
 * normally (`aborted` by the user or a newer message, `interrupted` after
 * the recovery cap, `failed`); `partialText` is the reply so far in those
 * cases. A `done` produced for a re-join of a run that already ended
 * carries `replayed: true` and its `status`.
 */
export interface SSEDoneEventData {
  timestamp?: string;
  runId?: string;
  messageId?: string;
  aborted?: boolean;
  interrupted?: boolean;
  failed?: boolean;
  status?:
    | 'queued'
    | 'running'
    | 'recovering'
    | 'finished'
    | 'aborted'
    | 'interrupted'
    | 'failed';
  partialText?: string;
  replayed?: boolean;
}

/** First frame of a durable run: the id a client re-joins with. */
export interface SSERunEventData {
  runId: string;
  sessionId: string;
  requestId: string;
  /** Set when this attempt resumed a run cut off by a runtime restart. */
  resumed?: boolean;
  attempt?: number;
  /**
   * With `resumed`: the length of the reply text the runtime kept and
   * continues from. A client that displayed more than that (the last frames
   * before the restart were never persisted) cuts its text back to this
   * length before appending the frames that follow.
   */
  partialLength?: number;
}

export interface SSERouterUpdateEventData {
  step: string;
  sessionId: string;
  requestId: string;
  eventId?: string;
  runId?: string;
  /** The message waits behind the session's running turn (`multitask: 'enqueue'`). */
  queued?: boolean;
}

export interface SSERenderComponentEventData {
  componentName: string;
  args?: Record<string, unknown>;
  status?: 'isRunning' | 'done';
  sessionId: string;
  requestId: string;
  eventId?: string;
}

export interface SSEBrowserToolCallEventData {
  toolName: string;
  args?: Record<string, unknown>;
  status?: 'isRunning' | 'done';
  sessionId: string;
  requestId: string;
  eventId?: string;
}

/**
 * SSE event data for AG-UI action calls
 * @remarks
 * Args are NOT included in SSE events to avoid data duplication.
 * Args are sent once via WebSocket where the handler executes and render is called.
 * SSE events provide status updates only for the chat UI timeline.
 */
export interface SSEActionCallEventData {
  sessionId: string;
  requestId: string;
  toolName: string;
  /** Args excluded from SSE events (sent via WebSocket only) */
  args?: Record<string, unknown>;
  status?: 'isRunning' | 'done' | 'error';
  output?: string;
  toolCallId?: string;
  error?: string;
}

export interface SSEMessageCacheInvalidationEventData {
  status?: 'isRunning' | 'done';
  sessionId: string;
  requestId: string;
  eventId?: string;
}

export interface SSEReasoningEventData {
  sessionId: string;
  requestId: string;
  reasoning: string;
  reasoningDetails?: Array<{
    type: string;
    text: string;
    format: string;
    index: number;
  }>;
  isComplete?: boolean;
  timestamp?: string;
  eventId?: string;
}

// Type-safe SSE events using discriminated unions
export type SSEEvent =
  | BaseSSEEvent<'message', SSEMessageEventData>
  | BaseSSEEvent<'tool_call', SSEToolCallEventData>
  | BaseSSEEvent<'action_call', SSEActionCallEventData>
  | BaseSSEEvent<'error', SSEErrorEventData>
  | BaseSSEEvent<'done', SSEDoneEventData>
  | BaseSSEEvent<'run', SSERunEventData>
  | BaseSSEEvent<'router.update', SSERouterUpdateEventData>
  | BaseSSEEvent<'render_component', SSERenderComponentEventData>
  | BaseSSEEvent<'browser_tool_call', SSEBrowserToolCallEventData>
  | BaseSSEEvent<
      'message_cache_invalidation',
      SSEMessageCacheInvalidationEventData
    >
  | BaseSSEEvent<'reasoning', SSEReasoningEventData>;

// Legacy type aliases for backward compatibility
export type SSEToolCallPayload = SSEToolCallEventData;
export type SSEErrorEvent = SSEErrorEventData;
export type SSEMessageEvent = SSEMessageEventData;

// Helper function to validate SSE event types
function isValidSSEEventType(
  eventType: string,
): eventType is SSEEvent['event'] {
  const validEventTypes: SSEEvent['event'][] = [
    'message',
    'tool_call',
    'action_call',
    'error',
    'done',
    'run',
    'router.update',
    'render_component',
    'browser_tool_call',
    'message_cache_invalidation',
    'reasoning',
  ];
  return validEventTypes.includes(eventType as SSEEvent['event']);
}

/** `true` for the abort of a cancelled fetch, in every runtime's spelling. */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError'))
  );
}

/**
 * Parse an SSE stream (the server's frames: `id:`, `event:`, `data:` lines,
 * a blank line ending each frame, `: heartbeat` comments in between) into
 * typed events.
 *
 * Framing follows the SSE specification, so a frame is intact whatever the
 * network did to it: a frame's lines may arrive across any number of reads
 * (the field state persists between chunks, and a chunk may cut a UTF-8
 * sequence in half), line ends may be `\n` or `\r\n`, several `data:` lines
 * are joined with newlines, and a comment never ends a frame in progress. A
 * last frame the server did not terminate is still delivered.
 *
 * A frame whose data is not JSON is logged and skipped; the stream goes on.
 * Frames with an event name this client does not know are skipped. An
 * aborted read (the user cancelled) ends the stream without an error.
 *
 * @param reader - ReadableStreamDefaultReader for the SSE stream
 * @returns AsyncGenerator yielding parsed SSE events
 */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  const data: string[] = [];
  let id: number | undefined;

  const dispatch = (): SSEEvent | undefined => {
    const eventName = event;
    const payload = data.join('\n');
    event = '';
    data.length = 0;
    const frameId = id;
    id = undefined;
    if (!eventName || payload === '') return undefined;
    if (!isValidSSEEventType(eventName)) return undefined;
    try {
      // The event name decides the payload type; the server is the
      // authority on the shape, as it always was.
      const parsedData = JSON.parse(payload);
      return {
        event: eventName,
        data: parsedData,
        ...(frameId !== undefined ? { id: frameId } : {}),
      };
    } catch (parseError) {
      console.warn('Failed to parse SSE data:', payload, parseError);
      return undefined;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      // The decoder is flushed at the end (a chunk may have ended inside a
      // multi-byte character), and a final unterminated frame is closed.
      buffer += done
        ? `${decoder.decode()}\n\n`
        : decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const rawLine = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf('\n');
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          const frame = dispatch();
          if (frame) yield frame;
        } else if (line.startsWith(':')) {
          // A comment (the heartbeat): not part of any frame.
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith('id:')) {
          const n = Number(line.slice(3).trim());
          if (Number.isFinite(n)) id = n;
        }
      }
      if (done) return;
    }
  } catch (error) {
    // The user cancelled: the stream ends, nothing to report.
    if (isAbortError(error)) return;
    console.error('Error parsing SSE stream:', error);
    throw error;
  }
}
