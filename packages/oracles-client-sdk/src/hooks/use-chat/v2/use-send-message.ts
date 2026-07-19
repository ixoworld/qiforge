/* eslint-disable no-console */
'use client';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { useOraclesContext } from '../../../providers/oracles-provider/oracles-context.js';
import { RequestError } from '../../../utils/request.js';
import {
  parseSSEStream,
  type SSEActionCallEventData,
  type SSEErrorEventData,
  type SSEReasoningEventData,
  type SSEToolCallEventData,
} from '../../../utils/sse-parser.js';
import { useOraclesConfig } from '../../use-oracles-config.js';
import {
  type Attachment,
  type IMessage,
  type ISendMessageOptions,
} from './types.js';

interface IUseSendMessageReturn {
  sendMessage: (
    message: string,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
  ) => Promise<void>;
  abortStream: () => Promise<void>;
  isSending: boolean;
  error?: Error | null;
  isConfigReady: boolean;
}

export function useSendMessage({
  oracleDid,
  sessionId,
  overrides,
  onPaymentRequiredError,
  browserTools,
  chatRef,
  refetchQueries,
  model,
  onToolCall,
  onError,
  onReasoning,
  onActionCall,
}: ISendMessageOptions): IUseSendMessageReturn {
  const { config, isReady: isConfigReady } = useOraclesConfig(
    oracleDid,
    overrides,
  );
  const apiUrl = overrides?.baseUrl ?? config.apiUrl;
  const { wallet, authedRequest, agActions, getDelegation, getInvocation } =
    useOraclesContext();

  // Abort controller for canceling requests
  const abortControllerRef = useRef<AbortController | null>(null);

  // Abort function to cancel ongoing stream
  const abortStream = useCallback(async () => {
    if (abortControllerRef.current) {
      // Call backend abort endpoint with sessionId
      try {
        await authedRequest(
          `${apiUrl}/messages/abort`,
          'POST',
          {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          },
          oracleDid,
        );
      } catch (err) {
        console.error('Failed to abort on backend:', err);
      }

      // Also abort locally for immediate UI feedback
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      chatRef?.current?.setStatus('ready');
    }
  }, [sessionId, chatRef, apiUrl]);

  const { mutateAsync, isPending, error } = useMutation({
    retry: false, // Prevent retries on abort/errors
    mutationFn: async ({
      message,
      metadata,
      attachments,
    }: {
      message: string;
      metadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }) => {
      if (!apiUrl) {
        throw new Error('API URL is required');
      }
      if (!wallet?.did) {
        throw new Error('DID is required');
      }

      // Set status to streaming
      chatRef?.current?.setStatus('submitted');

      try {
        // 1. Add optimistic user message immediately
        const userMessage: IMessage = {
          id: window.crypto.randomUUID(),
          content: message,
          type: 'human',
        };
        await chatRef?.current?.addUserMessage(userMessage);

        // Add optimistic file messages (one per attachment)
        if (attachments?.length) {
          for (const attachment of attachments) {
            const fileMessage: IMessage = {
              id: window.crypto.randomUUID(),
              content: `[Processing file: ${attachment.filename}]`,
              type: 'human',
              attachment: {
                filename: attachment.filename,
                mimetype: attachment.mimetype,
                size: attachment.size,
                mxcUri: attachment.mxcUri,
                eventId: attachment.eventId,
              },
            };
            await chatRef?.current?.addUserMessage(fileMessage);
          }
        }

        // 2. Stream AI response
        chatRef?.current?.setStatus('streaming');

        // Get UCAN delegation for this oracle (cached or freshly created)
        const delegation = oracleDid ? await getDelegation(oracleDid) : null;

        if (!delegation) {
          throw new Error(
            'UCAN delegation is required. Ensure createDelegation is provided to OraclesProvider.',
          );
        }

        // Get UCAN invocation (treated like a bearer token). Migration-safe:
        // if no createInvocation callback is provided this is null and we
        // proceed with delegation only.
        const invocation = oracleDid ? await getInvocation(oracleDid) : null;

        // Create abort controller for this request
        abortControllerRef.current = new AbortController();

        const results = await askOracleStream({
          apiURL: apiUrl,
          message,
          delegation,
          invocation,
          sessionId,
          model,
          metadata,
          attachments,
          browserTools: browserTools
            ? Object.values(browserTools).map((tool) => ({
                name: tool.toolName,
                description: tool.description,
                schema: zodToJsonSchema(tool.schema),
              }))
            : undefined,
          agActions:
            agActions.length > 0
              ? agActions.map((action) => ({
                  name: action.name,
                  description: action.description,
                  schema: zodToJsonSchema(action.parameters),
                  hasRender: action.hasRender,
                }))
              : undefined,
          abortSignal: abortControllerRef.current?.signal,

          // Message chunks (existing pattern)
          onMessage: async ({ chunk, requestId }) => {
            await chatRef?.current?.upsertAIMessage(requestId, chunk);
          },

          onToolCall: onToolCall
            ? async ({ toolCallData, requestId }) => {
                await onToolCall({ toolCallData, requestId });
              }
            : undefined,

          onActionCall: onActionCall
            ? async ({ actionCallData, requestId }) => {
                await onActionCall({ actionCallData, requestId });
              }
            : undefined,

          onError: onError
            ? async ({ error, requestId }) => {
                await onError({ error, requestId });
              }
            : undefined,

          onReasoning: onReasoning
            ? async ({ reasoningData, requestId }) => {
                await onReasoning({ reasoningData, requestId });
              }
            : undefined,

          onDone: () => {
            chatRef?.current?.setStatus('ready');
            abortControllerRef.current = null;
          },
        });

        chatRef?.current?.setStatus('ready');

        return { requestId: results.requestId };
      } catch (err) {
        // Clear abort controller on error
        abortControllerRef.current = null;

        // Handle abort errors gracefully - user intentionally cancelled
        if (
          err instanceof Error &&
          (err.name === 'AbortError' ||
            (err instanceof DOMException && err.name === 'AbortError'))
        ) {
          chatRef?.current?.setStatus('ready');
          return;
        }

        if (RequestError.isRequestError(err) && err.claims) {
          onPaymentRequiredError(err.claims as string[]);
          chatRef?.current?.setStatus('ready');
          return;
        }
        chatRef?.current?.setStatus(
          'error',
          err instanceof Error ? err : new Error('Unknown error'),
        );
        throw err;
      } finally {
        // Clear abort controller when done
        abortControllerRef.current = null;

        // Refetch queries regardless of success/error/early return
        if (refetchQueries) {
          await refetchQueries();
        }
      }
    },
  });

  const sendMessage = useCallback(
    async (
      message: string,
      metadata?: Record<string, unknown>,
      attachments?: Attachment[],
    ) => {
      await mutateAsync({ message, metadata, attachments });
    },
    [mutateAsync],
  );

  return {
    sendMessage,
    abortStream,
    isSending: isPending,
    error,
    isConfigReady,
  };
}

// Stream AI responses from the oracle
const askOracleStream = async (props: {
  apiURL: string;
  message: string;
  sessionId: string;
  delegation: string;
  invocation?: string | null;
  /** Model id to answer with; omitted → the oracle's default model. */
  model?: string;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
  browserTools?: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }[];
  agActions?: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
    hasRender: boolean;
  }[];
  abortSignal?: AbortSignal;

  // Callbacks for different event types
  onMessage: (args: {
    chunk: string;
    requestId: string;
  }) => void | Promise<void>;
  onToolCall?: (args: {
    toolCallData: SSEToolCallEventData;
    requestId: string;
  }) => void | Promise<void>;
  onActionCall?: (args: {
    actionCallData: SSEActionCallEventData;
    requestId: string;
  }) => void | Promise<void>;
  onError?: (args: {
    error: SSEErrorEventData;
    requestId: string;
  }) => void | Promise<void>;
  onReasoning?: (args: {
    reasoningData: SSEReasoningEventData;
    requestId: string;
  }) => void | Promise<void>;
  onDone?: () => void;
}): Promise<{ text: string; requestId: string }> => {
  const response = await fetch(`${props.apiURL}/messages/${props.sessionId}`, {
    headers: {
      'Content-Type': 'application/json',
      'x-ucan-delegation': props.delegation,
      ...(props.invocation && {
        Authorization: `Bearer ${props.invocation}`,
        'X-Auth-Type': 'ucan',
      }),
    },
    body: JSON.stringify({
      message: props.message,
      stream: true,
      ...(props.model && { model: props.model }),
      ...(props.metadata && { metadata: props.metadata }),
      ...(props.attachments?.length && { attachments: props.attachments }),
      ...(props.browserTools && { tools: props.browserTools }),
      ...(props.agActions && { agActions: props.agActions }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    method: 'POST',
    signal: props.abortSignal,
  });

  if (!response.ok) {
    const err = (await response.json()) as { message: string };
    throw new RequestError(err.message, err);
  }

  const requestId = response.headers.get('X-Request-Id');

  if (!requestId) {
    throw new Error('Did not receive a request ID');
  }

  // Check if ReadableStream is supported
  if (!response.body) {
    throw new Error('ReadableStream not supported in this browser');
  }

  const reader = response.body.getReader();
  let accumulatedText = '';

  try {
    // Parse SSE events from the stream
    for await (const sseEvent of parseSSEStream(reader)) {
      // Type-safe event handling using discriminated unions
      switch (sseEvent.event) {
        case 'message':
          await props.onMessage({ chunk: sseEvent.data.content, requestId });
          accumulatedText += sseEvent.data.content;
          break;

        case 'tool_call':
          if (props.onToolCall) {
            await props.onToolCall({ toolCallData: sseEvent.data, requestId });
          }
          break;

        case 'action_call':
          if (props.onActionCall) {
            await props.onActionCall({
              actionCallData: sseEvent.data,
              requestId,
            });
          } else {
            console.warn(
              '[useSendMessage] action_call received but onActionCall handler is missing',
            );
          }
          break;

        case 'error':
          if (props.onError) {
            await props.onError({ error: sseEvent.data, requestId });
          }
          break;

        case 'done':
          props.onDone?.();
          break;

        case 'router.update':
          // Ignore for now - future enhancement
          break;

        case 'render_component':
          // Ignore for now - future enhancement
          break;

        case 'browser_tool_call':
          // Ignore for now - future enhancement
          break;

        case 'message_cache_invalidation':
          // Ignore for now - future enhancement
          break;

        case 'reasoning':
          if (props.onReasoning) {
            await props.onReasoning({
              reasoningData: sseEvent.data,
              requestId,
            });
          }
          break;

        default:
          // This should never happen with proper typing, but handle gracefully
          console.debug(
            'Unknown SSE event:',
            (sseEvent as unknown as { event: string }).event,
          );
          break;
      }
    }

    return {
      text: accumulatedText,
      requestId,
    };
  } catch (error) {
    void reader.cancel();

    // Handle abort errors gracefully
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        (error instanceof DOMException && error.name === 'AbortError'))
    ) {
      // Don't throw abort errors - they're expected when user cancels
      return {
        text: accumulatedText,
        requestId,
      };
    }

    throw error;
  }
};
