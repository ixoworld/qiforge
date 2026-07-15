'use client';
import { useQuery } from '@tanstack/react-query';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type WithRequiredEventProps } from '@ixo/oracles-events/types';
import { type IActionTools } from '../../../types/action-tool.type.js';
import { useOraclesContext } from '../../../providers/oracles-provider/oracles-context.js';
import { RequestError } from '../../../utils/request.js';
import {
  type SSEActionCallEventData,
  type SSEErrorEvent,
  type SSEReasoningEventData,
  type SSEToolCallPayload,
} from '../../../utils/sse-parser.js';
import { useOracleSessions } from '../../use-oracle-sessions/use-oracle-sessions.js';
import { useOraclesConfig } from '../../use-oracles-config.js';
import { useWebSocketEvents } from '../../use-websocket-events/use-websocket-events.js';
import { resolveContent } from '../resolve-content.js';
import transformToMessagesMap from '../transform-to-messages-map.js';
import { OracleChat } from './oracle-chat.js';
import {
  isAnonymousMessageFeedbackCapabilitySupported,
  submitAnonymousMessageFeedback,
} from './message-feedback.js';
import {
  type AnonymousMessageFeedbackSubmission,
  type AnyEvent,
  type ChatCapabilities,
  type IChatOptions,
  type IMessage,
} from './types.js';
import { useSendMessage } from './use-send-message.js';

export function useChat({
  oracleDid,
  sessionId,
  overrides,
  onPaymentRequiredError,
  browserTools,
  uiComponents,
  streamingMode,
}: IChatOptions) {
  // Create chat instance with lazy initialization
  const chatRef = useRef<OracleChat | null>(null);

  // Initialize or recreate chat if sessionId changes
  if (!chatRef.current || chatRef.current.id !== sessionId) {
    // Cleanup old instance to prevent memory leaks
    if (chatRef.current) {
      chatRef.current.cleanup();
    }

    chatRef.current = new OracleChat({
      oracleDid,
      sessionId,
      onPaymentRequiredError,
      browserTools,
      uiComponents,
      overrides,
      streamingMode,
    });
  }

  // Subscribe to messages with useSyncExternalStore
  const messages = useSyncExternalStore(
    chatRef.current.subscribe,
    () => chatRef.current?.messages ?? [],
    () => [], // Server snapshot (SSR)
  );

  const status = useSyncExternalStore(
    chatRef.current.subscribe,
    () => chatRef.current?.status,
    () => 'ready' as const,
  );

  const error = useSyncExternalStore(
    chatRef.current.subscribe,
    () => chatRef.current?.error,
    () => undefined,
  );

  const { refetch: refetchOracleSessions } = useOracleSessions(
    oracleDid,
    overrides,
  );
  const { config, isReady: isConfigReady } = useOraclesConfig(
    oracleDid,
    overrides,
  );
  const { authedRequest, executeAgAction, getAgActionRender, agActions } =
    useOraclesContext();
  const apiUrl = overrides?.baseUrl ?? config.apiUrl;
  const [submittingFeedbackMessageId, setSubmittingFeedbackMessageId] =
    useState<string | null>(null);
  const [messageFeedbackError, setMessageFeedbackError] =
    useState<Error | null>(null);

  // React Query for initial data fetch
  const {
    data,
    isLoading,
    error: queryError,
    status: queryStatus,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: [oracleDid, 'messages', sessionId],
    queryFn: async () => {
      const result = await authedRequest<{
        messages: IMessage[];
        capabilities?: ChatCapabilities;
      }>(`${apiUrl}/messages/${sessionId}`, 'GET', {}, oracleDid);

      // Don't transform here - return raw messages
      // Transformation will happen in useEffect when agActions is available
      return result;
    },
    enabled: Boolean(sessionId && apiUrl),
    retry: false,
  });

  const revalidate = useCallback(async () => {
    await Promise.all([refetchMessages(), refetchOracleSessions()]);
  }, [refetchMessages, refetchOracleSessions]);

  // Sync React Query data with OracleChat state when data changes
  // Transform messages here when agActions is available
  useEffect(() => {
    if (data && chatRef.current && queryStatus === 'success') {
      // Don't overwrite messages if we're currently streaming
      const currentStatus = chatRef.current.status;
      if (currentStatus === 'streaming' || currentStatus === 'submitted') {
        return;
      }

      const transformedMessages = transformToMessagesMap({
        messages: data.messages,
        uiComponents,
        agActionNames: agActions.map((action) => action.name),
      });

      const messagesArray = Object.values(transformedMessages);
      void chatRef.current.setInitialMessages(messagesArray);
    }
  }, [data, queryStatus, agActions, uiComponents]);

  const isAnonymousMessageFeedbackSupported =
    isAnonymousMessageFeedbackCapabilitySupported(data?.capabilities);

  useEffect(() => {
    setSubmittingFeedbackMessageId(null);
    setMessageFeedbackError(null);
  }, [sessionId]);

  const submitMessageFeedback = useCallback(
    async (
      messageId: string,
      submission: AnonymousMessageFeedbackSubmission,
    ) => {
      if (!apiUrl || !sessionId) {
        throw new Error('A configured chat session is required');
      }
      if (!isAnonymousMessageFeedbackSupported) {
        throw new Error('Message feedback is not supported by this Agent');
      }

      const chat = chatRef.current;
      const target = chat?.messages.find((message) => message.id === messageId);
      if (!target || target.type !== 'ai' || target.isComplete === false) {
        throw new Error('Completed Agent message not found');
      }
      setSubmittingFeedbackMessageId(messageId);
      setMessageFeedbackError(null);

      try {
        return await submitAnonymousMessageFeedback({
          apiUrl,
          sessionId,
          messageId,
          submission,
          oracleDid,
          authedRequest,
        });
      } catch (feedbackError) {
        const normalizedError =
          feedbackError instanceof Error
            ? feedbackError
            : new Error('Failed to save message feedback');
        setMessageFeedbackError(normalizedError);
        throw normalizedError;
      } finally {
        setSubmittingFeedbackMessageId(null);
      }
    },
    [
      apiUrl,
      authedRequest,
      isAnonymousMessageFeedbackSupported,
      oracleDid,
      sessionId,
    ],
  );

  // Handle tool call events from streaming
  const handleToolCall = useCallback(
    async ({
      toolCallData,
      requestId,
    }: {
      toolCallData: SSEToolCallPayload;
      requestId: string;
    }) => {
      if (!uiComponents) return;

      const eventId = toolCallData.eventId ?? requestId;

      const toolCallMessage: IMessage = {
        id: `${requestId}-ToolCall-${eventId}`,
        type: 'ai',
        content: resolveContent({
          eventName: 'tool_call',
          payload: toolCallData,
        }),
        toolCalls: [
          {
            id: eventId,
            name: toolCallData.toolName,
            args: toolCallData.args,
            status: toolCallData.status,
            output: toolCallData.output,
          },
        ],
      };

      await chatRef.current?.upsertEventMessage(toolCallMessage);
    },
    [uiComponents],
  );

  // Handle AG-UI action call events from streaming (status updates only)
  // Note: Render function is called in WebSocket handler immediately after execution
  // SSE events only update the chat UI timeline with status changes
  const handleActionCall = useCallback(
    async ({
      actionCallData,
      requestId,
    }: {
      actionCallData: SSEActionCallEventData;
      requestId: string;
    }) => {
      const eventId = actionCallData.toolCallId ?? requestId;

      const actionCallMessage: IMessage = {
        id: `${requestId}-ActionCall-${eventId}`,
        type: 'ai',
        content: resolveContent({
          eventName: 'action_call',
          payload:
            actionCallData as WithRequiredEventProps<SSEActionCallEventData>,
        }),
        toolCalls: [
          {
            id: eventId,
            name: actionCallData.toolName,
            args: actionCallData.args, // May be undefined in SSE events (sent via WebSocket instead)
            status: actionCallData.status,
            output: actionCallData.output,
            error: actionCallData.error,
          },
        ],
      };

      // Update chat UI with status change
      await chatRef.current?.upsertEventMessage(actionCallMessage);
    },
    [],
  );

  // Handle error events from streaming
  const handleError = useCallback(
    async ({
      error: errorData,
      requestId,
    }: {
      error: SSEErrorEvent;
      requestId: string;
    }) => {
      if (!uiComponents) return;

      const errorMessage: IMessage = {
        id: `${requestId}-error`,
        type: 'ai',
        content: resolveContent({ eventName: 'error', payload: errorData }),
      };

      await chatRef.current?.addUserMessage(errorMessage);
    },
    [uiComponents],
  );

  // Handle reasoning events from streaming
  const handleReasoning = useCallback(
    async ({
      reasoningData,
    }: {
      reasoningData: SSEReasoningEventData;
      requestId: string;
    }) => {
      // Use consistent ID for all reasoning chunks from the same request

      // Create reasoning message - upsertEventMessage will handle accumulation
      const reasoningMessage: IMessage = {
        id: reasoningData.requestId,
        type: 'ai',
        content: reasoningData.reasoning,
        reasoning:
          reasoningData.reasoningDetails
            ?.map((detail) => detail.text)
            .filter((text) => text && text.trim().length > 0) // Filter out empty text
            .join('\n') || '', // Safe fallback to empty string
        isComplete: reasoningData.isComplete,
        isReasoning: true,
      };

      await chatRef.current?.upsertEventMessage(reasoningMessage);
    },
    [],
  );

  // WebSocket events handling
  const handleNewEvent = useCallback(
    (event: AnyEvent) => {
      if (!uiComponents) return;
      // Process immediately when event arrives
      if (event.payload.sessionId === sessionId) {
        const messagePayload: IMessage = {
          id: `${event.payload.requestId}-${event.eventName}-${event.payload.eventId}`,
          type: 'ai',
          content: resolveContent({
            eventName: event.eventName,
            payload: event.payload,
          }),
          toolCalls:
            'toolName' in event.payload && 'status' in event.payload
              ? [
                  {
                    id: event.payload.requestId,
                    args: event.payload.args,
                    name: event.payload.toolName,
                    status: event.payload.status,
                    output:
                      'output' in event.payload
                        ? event.payload.output
                        : undefined,
                  },
                ]
              : undefined,
        };
        void chatRef.current?.upsertEventMessage(messagePayload);
      }
    },
    [sessionId, uiComponents],
  );

  // Handle new events from streaming or WebSocket
  const {
    sendMessage,
    abortStream,
    isSending,
    error: sendMessageError,
  } = useSendMessage({
    oracleDid,
    sessionId,
    overrides,
    onPaymentRequiredError,
    browserTools,
    chatRef: chatRef as MutableRefObject<OracleChat>,
    refetchQueries: revalidate,
    onToolCall: handleToolCall,
    onActionCall: handleActionCall,
    onError: handleError,
    onReasoning: handleReasoning,
  });

  // useLiveEvents removed - all events now come through streaming

  // Build actionTools from registered AG-UI actions
  const actionTools = useMemo(() => {
    const tools: IActionTools = {};
    agActions.forEach((action) => {
      tools[action.name] = {
        toolName: action.name,
        description: action.description,
        schema: action.parameters,
        handler: async (args: unknown) => {
          return await executeAgAction(action.name, args);
        },
        render: getAgActionRender(action.name),
      };
    });
    return tools;
  }, [agActions, executeAgAction, getAgActionRender]);

  const { isConnected: isWebSocketConnected } = useWebSocketEvents({
    oracleDid,
    sessionId,
    overrides,
    handleInvalidateCache: () => {
      void revalidate();
    },
    handleNewEvent: (event) => {
      // Type assertion for WebSocket events
      handleNewEvent(event as AnyEvent);
    },
    browserTools,
    actionTools,
  });

  // Cleanup on unmount to ensure garbage collection
  useEffect(() => {
    return () => {
      if (chatRef.current) {
        chatRef.current.cleanup();
        chatRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (queryError instanceof RequestError && queryError.outstandingClaims) {
      onPaymentRequiredError?.(queryError.outstandingClaims ?? []);
    }
  }, [queryError]);

  return {
    messages: messages ?? [],
    isLoading,
    error: error || queryError,
    isSending: isSending || status === 'streaming',
    sendMessage,
    abortStream,
    refetchMessages,
    sendMessageError,
    isRealTimeConnected: isWebSocketConnected,
    status,
    isConfigReady,
    submitMessageFeedback,
    isAnonymousMessageFeedbackSupported,
    submittingFeedbackMessageId,
    messageFeedbackError,
  };
}
