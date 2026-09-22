'use client';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { type WithRequiredEventProps } from '@ixo/oracles-events/types';
import { type IActionTools } from '../../../types/action-tool.type.js';
import { useOraclesContext } from '../../../providers/oracles-provider/oracles-context.js';
import { RequestError } from '../../../utils/request.js';
import {
  appendTail,
  DEFAULT_HISTORY_PAGE_SIZE,
  fetchHistoryPage,
  flattenPages,
} from '../../../utils/transcript-pages.js';
import { type HistoryData, historyQueryOptions } from './history-query.js';
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
import { reasoningMessageOf } from './reasoning-message.js';
import {
  type AnyEvent,
  type IChatOptions,
  type IMessage,
  IDLE_RUN_STATE,
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
  streamingThrottleMs,
  historyPageSize,
  model,
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
      streamingThrottleMs,
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

  const run = useSyncExternalStore(
    chatRef.current.subscribe,
    () => chatRef.current?.run ?? IDLE_RUN_STATE,
    () => IDLE_RUN_STATE,
  );

  const { refetch: refetchOracleSessions } = useOracleSessions(
    oracleDid,
    overrides,
  );
  const { config, isReady: isConfigReady } = useOraclesConfig(
    oracleDid,
    overrides,
  );
  const {
    authedRequest,
    executeAgAction,
    getAgActionRender,
    agActions,
    registeredAgActions,
  } = useOraclesContext();
  const apiUrl = overrides?.baseUrl ?? config.apiUrl;

  // The history, one turn-aligned page at a time: the newest page first,
  // older pages on demand (`loadEarlier`), what a turn added through
  // `revalidate` (transcript-pages.ts, history-query.ts). A runtime without
  // paging delivers the whole transcript as one page.
  const pageSize = historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
  const queryClient = useQueryClient();
  const requestJson = useCallback(
    <T>(url: string) => authedRequest<T>(url, 'GET', {}, oracleDid),
    [authedRequest, oracleDid],
  );
  const historyOptions = useMemo(
    () =>
      historyQueryOptions({
        oracleDid,
        sessionId,
        apiUrl,
        pageSize,
        request: requestJson,
      }),
    [oracleDid, sessionId, apiUrl, pageSize, requestJson],
  );
  const historyKey = historyOptions.queryKey;
  const {
    data: history,
    isLoading,
    error: queryError,
    status: queryStatus,
    refetch: refetchMessages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    ...historyOptions,
    enabled: Boolean(sessionId && apiUrl),
    retry: false,
  });
  // Newest page first (history-query.ts).
  const pages = history?.pages;

  /**
   * Bring the loaded history up to date after a turn (or a cache
   * invalidation): fetch what came after the newest loaded row and fold it
   * into the newest page. Against a runtime without paging, or before the
   * first page landed, the loaded history is refetched whole.
   */
  const fetchNewer = useCallback(async () => {
    const current = queryClient.getQueryData<HistoryData>(historyKey);
    const newest = current?.pages[0];
    if (!apiUrl) return;
    if (!newest || newest.legacy || !newest.nextCursor) {
      await refetchMessages();
      return;
    }
    let folded = current.pages;
    let cursor = newest.nextCursor;
    // A client that was away for many turns pages forward until it is
    // current; the bound only guards against a runtime that never says so.
    for (let round = 0; round < 50; round += 1) {
      const tail = await fetchHistoryPage<IMessage>(
        requestJson,
        apiUrl,
        sessionId,
        { limit: pageSize, after: cursor },
      );
      if (tail.legacy) {
        await refetchMessages();
        return;
      }
      folded = appendTail(folded, tail);
      if (!tail.hasNewer || !tail.nextCursor) break;
      cursor = tail.nextCursor;
    }
    queryClient.setQueryData<HistoryData>(historyKey, {
      ...current,
      pages: folded,
    });
  }, [
    queryClient,
    historyKey,
    refetchMessages,
    requestJson,
    apiUrl,
    sessionId,
    pageSize,
  ]);

  const revalidate = useCallback(async () => {
    await Promise.all([fetchNewer(), refetchOracleSessions()]);
  }, [fetchNewer, refetchOracleSessions]);

  /** Load the page of turns before the oldest one loaded. */
  const loadEarlier = useCallback(async () => {
    if (!hasNextPage || isFetchingNextPage) return;
    await fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Mirror the loaded pages into the chat store (transformed once agActions
  // are known). The store keeps the turn in flight on top while streaming.
  useEffect(() => {
    if (!pages || !chatRef.current || queryStatus !== 'success') return;
    const transformedMessages = transformToMessagesMap({
      messages: flattenPages(pages),
      uiComponents,
      agActionNames: agActions.map((action) => action.name),
    });
    void chatRef.current.setHistory(Object.values(transformedMessages));
  }, [pages, queryStatus, agActions, uiComponents]);

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
      // One reasoning message per request (its own id, so the answer that
      // streams next to it is never flagged as reasoning); the store
      // accumulates the chunks into it.
      await chatRef.current?.upsertEventMessage(
        reasoningMessageOf(reasoningData),
      );
    },
    [],
  );

  // WebSocket events handling
  const handleNewEvent = useCallback(
    (event: AnyEvent) => {
      if (!uiComponents) return;
      // The turn this chat is streaming itself already files its tool calls
      // from the stream; the socket mirrors them for other clients of the
      // session, and a second copy here rendered as a second card.
      if (
        event.eventName === 'tool_call' &&
        chatRef.current?.run.requestId === event.payload.requestId
      )
        return;
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
    resumeRun,
    detachStream,
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
    model,
    onToolCall: handleToolCall,
    onActionCall: handleActionCall,
    onError: handleError,
    onReasoning: handleReasoning,
  });

  // useLiveEvents removed - all events now come through streaming

  // Switching sessions mid-turn: stop following that turn's stream here (the
  // runtime keeps running it; coming back re-joins it below) so nothing of
  // it shows up in the session the user moved to.
  const currentSessionRef = useRef(sessionId);
  useEffect(() => {
    if (currentSessionRef.current !== sessionId) {
      currentSessionRef.current = sessionId;
      detachStream();
    }
  }, [sessionId, detachStream]);

  // A turn that is still running for this session (the page was reloaded
  // mid-reply, the runtime is recovering it, or the user left and came back)
  // is re-joined once the history has loaded, so the reply streams in here
  // instead of appearing only when the transcript is refetched. Latest
  // callbacks live in refs: the check runs once per session load and is
  // never cancelled by a callback identity change.
  const resumeRunRef = useRef(resumeRun);
  resumeRunRef.current = resumeRun;
  const authedRequestRef = useRef(authedRequest);
  authedRequestRef.current = authedRequest;
  const resumeCheckedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (queryStatus !== 'success' || !sessionId || !apiUrl) return;
    if (resumeCheckedForRef.current === sessionId) return;
    resumeCheckedForRef.current = sessionId;
    void (async () => {
      let active: { runId: string; status: string } | null = null;
      try {
        const result = await authedRequestRef.current<{
          run: { runId: string; status: string } | null;
        }>(`${apiUrl}/sessions/${sessionId}/run`, 'GET', {}, oracleDid);
        active = result.run;
      } catch (err) {
        // A runtime without durable runs (404) — nothing to re-join.
        if (!(err instanceof RequestError && err.status === 404))
          // eslint-disable-next-line no-console -- a silent miss here hides a running turn
          console.warn('[useChat] could not check for a running turn:', err);
        return;
      }
      if (currentSessionRef.current !== sessionId) return; // moved on
      if (!active) return;
      if (!['queued', 'running', 'recovering'].includes(active.status)) return;
      if (chatRef.current?.status === 'streaming') return;
      await resumeRunRef.current(active.runId);
    })();
  }, [queryStatus, sessionId, apiUrl, oracleDid]);

  // Build actionTools from registered AG-UI actions
  const actionTools = useMemo(() => {
    const tools: IActionTools = {};
    registeredAgActions.forEach((action) => {
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
  }, [registeredAgActions, executeAgAction, getAgActionRender]);

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
    /** The durable run behind the current or last turn (re-joins, resumes, how it ended). */
    run,
    isConfigReady,
    /** Older turns exist beyond the loaded history. */
    hasEarlier: Boolean(hasNextPage),
    /** Load the page of turns before the oldest one shown (no-op when none). */
    loadEarlier,
    isLoadingEarlier: isFetchingNextPage,
  };
}
