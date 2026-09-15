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

/**
 * Parse SSE stream from ReadableStream reader
 * Handles buffer management, event/data parsing, and JSON deserialization
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
  let data = '';
  let id: number | undefined;

  try {
    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        // Handle abort errors gracefully - this is expected when user cancels
        if (
          readError instanceof Error &&
          (readError.name === 'AbortError' ||
            (readError instanceof DOMException &&
              readError.name === 'AbortError'))
        ) {
          // Stream was intentionally aborted, exit gracefully
          break;
        }
        // Re-throw other errors
        throw readError;
      }

      const { done, value } = readResult;
      if (done) break;

      // Decode chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');

      // Keep last incomplete line in buffer
      buffer = lines.pop() || '';

      // Process complete lines. `event`/`data`/`id` persist across chunks:
      // a frame's lines can arrive split over two network reads.
      for (const line of lines) {
        const trimmedLine = line.trim();

        // Skip empty lines and comments
        if (trimmedLine === '' || trimmedLine.startsWith(':')) {
          // Empty line = event complete
          if (event && data) {
            try {
              const parsedData = JSON.parse(data);
              // Type-safe event creation with fallback for unknown events
              if (isValidSSEEventType(event)) {
                yield {
                  event,
                  data: parsedData,
                  ...(id !== undefined ? { id } : {}),
                };
              }
            } catch (parseError) {
              console.warn('Failed to parse SSE data:', data, parseError);
            }
            event = '';
            data = '';
            id = undefined;
          }
          continue;
        }

        if (trimmedLine.startsWith('event:')) {
          event = trimmedLine.slice(6).trim();
        } else if (trimmedLine.startsWith('data:')) {
          data = trimmedLine.slice(5).trim();
        } else if (trimmedLine.startsWith('id:')) {
          const n = Number(trimmedLine.slice(3).trim());
          if (Number.isFinite(n)) id = n;
        }
      }
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      let event = '';
      let data = '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('event:')) {
          event = trimmedLine.slice(6).trim();
        } else if (trimmedLine.startsWith('data:')) {
          data = trimmedLine.slice(5).trim();
        }
      }

      if (event && data) {
        try {
          const parsedData = JSON.parse(data);
          // Type-safe event creation with fallback for unknown events
          if (isValidSSEEventType(event)) {
            yield { event, data: parsedData };
          }
        } catch (parseError) {
          console.warn('Failed to parse final SSE data:', data, parseError);
        }
      }
    }
  } catch (error) {
    // Handle abort errors gracefully - expected when stream is cancelled
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        (error instanceof DOMException && error.name === 'AbortError'))
    ) {
      // Stream was aborted, exit gracefully without throwing
      return;
    }
    console.error('Error parsing SSE stream:', error);
    throw error;
  }
}
