/* eslint-disable no-console */
/**
 * SSE event types + stream parser for integration tests.
 *
 * **MIRROR of `packages/oracles-client-sdk/src/utils/sse-parser.ts`.**
 * Keep both files in sync. The SSE wire format is the contract between
 * the runtime (server) and the client SDK (frontend) — tests need to
 * parse it exactly the way real clients do, with the same typed event
 * union, or they'll drift from production behavior.
 *
 * Cross-package import was rejected because `oracles-client-sdk` is a
 * React-tagged package (`"use client"`) and importing into a Node test
 * harness creates an awkward dependency direction. Duplication of a
 * shared wire contract is the lesser evil. If this file ever changes,
 * update its twin in the client SDK at the same time.
 */

// Base SSE event structure
export interface BaseSSEEvent<TEvent extends string, TData> {
  event: TEvent;
  data: TData;
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
  status: 'isRunning' | 'done';
  output?: string;
  eventId?: string;
}

export interface SSEErrorEventData {
  error: string;
  timestamp: string;
}

export interface SSEDoneEventData {
  timestamp?: string;
}

export interface SSERouterUpdateEventData {
  step: string;
  sessionId: string;
  requestId: string;
  eventId?: string;
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

export interface SSEActionCallEventData {
  sessionId: string;
  requestId: string;
  toolName: string;
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
  | BaseSSEEvent<'router.update', SSERouterUpdateEventData>
  | BaseSSEEvent<'render_component', SSERenderComponentEventData>
  | BaseSSEEvent<'browser_tool_call', SSEBrowserToolCallEventData>
  | BaseSSEEvent<
      'message_cache_invalidation',
      SSEMessageCacheInvalidationEventData
    >
  | BaseSSEEvent<'reasoning', SSEReasoningEventData>;

function isValidSSEEventType(
  eventType: string,
): eventType is SSEEvent['event'] {
  const validEventTypes: SSEEvent['event'][] = [
    'message',
    'tool_call',
    'action_call',
    'error',
    'done',
    'router.update',
    'render_component',
    'browser_tool_call',
    'message_cache_invalidation',
    'reasoning',
  ];
  return validEventTypes.includes(eventType as SSEEvent['event']);
}

/**
 * Parse SSE stream from a ReadableStream reader. Yields typed `SSEEvent`s.
 * Handles buffer management across chunk boundaries, JSON parse errors,
 * and graceful abort behavior.
 */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        if (
          readError instanceof Error &&
          (readError.name === 'AbortError' ||
            (readError instanceof DOMException &&
              readError.name === 'AbortError'))
        ) {
          break;
        }
        throw readError;
      }

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let event = '';
      let data = '';

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine === '' || trimmedLine.startsWith(':')) {
          if (event && data) {
            try {
              const parsedData = JSON.parse(data);
              if (isValidSSEEventType(event)) {
                yield { event, data: parsedData };
              }
            } catch (parseError) {
              console.warn('Failed to parse SSE data:', data, parseError);
            }
            event = '';
            data = '';
          }
          continue;
        }

        if (trimmedLine.startsWith('event:')) {
          event = trimmedLine.slice(6).trim();
        } else if (trimmedLine.startsWith('data:')) {
          data = trimmedLine.slice(5).trim();
        }
      }
    }

    // Flush any trailing event left in the buffer.
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
          if (isValidSSEEventType(event)) {
            yield { event, data: parsedData };
          }
        } catch (parseError) {
          console.warn('Failed to parse final SSE data:', data, parseError);
        }
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        (error instanceof DOMException && error.name === 'AbortError'))
    ) {
      return;
    }
    console.error('Error parsing SSE stream:', error);
    throw error;
  }
}
