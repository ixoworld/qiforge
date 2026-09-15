/* eslint-disable no-console */
'use client';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { useOraclesContext } from '../../../providers/oracles-provider/oracles-context.js';
import { RequestError } from '../../../utils/request.js';
import {
  streamRun,
  StreamRunStartError,
  withRequestId,
  type RunStreamState,
  type StreamRunInput,
  type StreamRunResult,
} from '../../../utils/run-stream.js';
import {
  type SSEActionCallEventData,
  type SSEDoneEventData,
  type SSEErrorEventData,
  type SSEReasoningEventData,
  type SSERunEventData,
  type SSEToolCallEventData,
} from '../../../utils/sse-parser.js';
import { useOraclesConfig } from '../../use-oracles-config.js';
import type { OracleChat } from './oracle-chat.js';
import {
  type Attachment,
  type ChatRunState,
  type IMessage,
  type ISendMessageOptions,
} from './types.js';

/**
 * Inline every repeated subschema instead of emitting a JSON-pointer back
 * reference to it.
 *
 * `zod-to-json-schema` defaults to `$refStrategy: 'root'`, which turns the
 * second occurrence of a shared subschema into `$ref:
 * '#/properties/ops/items/anyOf/2/...'`. The oracle rebuilds these schemas with
 * `z.fromJSONSchema`, which resolves only `#` and `#/$defs/*` and throws
 * `Reference not found` on anything else — killing the turn before the agent
 * runs.
 */
const JSON_SCHEMA_OPTIONS = { $refStrategy: 'none' } as const;

interface IUseSendMessageReturn {
  sendMessage: (
    message: string,
    metadata?: Record<string, unknown>,
    attachments?: Attachment[],
  ) => Promise<void>;
  abortStream: () => Promise<void>;
  /**
   * Attach to a turn that is already running for this session (the page
   * was reloaded, or another tab sent it): replays what the runtime kept
   * and streams the rest, exactly like the turn's own stream.
   */
  resumeRun: (runId: string) => Promise<void>;
  /**
   * Stop following the stream this hook is consuming WITHOUT stopping the
   * turn on the runtime (the chat moved to another session; the run keeps
   * going and is re-joined when the user comes back).
   */
  detachStream: () => void;
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
  // The run being consumed (a turn's own stream or a resumed one) and a
  // counter so a stream that was superseded never touches the status.
  const activeRunRef = useRef<string | null>(null);
  const streamSeqRef = useRef(0);
  // The session the in-flight turn belongs to: `isSending` is per session,
  // so a turn started in one session never shows as "thinking" in another.
  const sendingSessionRef = useRef<string | null>(null);

  const detachStream = useCallback(() => {
    const controller = abortControllerRef.current;
    if (!controller) return;
    streamSeqRef.current += 1; // the stream's settle is now stale
    abortControllerRef.current = null;
    activeRunRef.current = null;
    sendingSessionRef.current = null;
    controller.abort();
  }, []);

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

  // Frames go to the chat instance the turn started in — never to whatever
  // `chatRef` points at later (the user may have switched sessions).
  const frameCallbacks = useCallback(
    (chat: OracleChat | undefined): RunFrameCallbacks => ({
      onMessage: async ({ chunk, requestId }) => {
        await chat?.upsertAIMessage(requestId, chunk);
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
      onRun: async ({ run, frame }) => {
        if (frame.resumed && run.requestId) {
          // The runtime restarted and picked the turn up: show exactly the
          // text it kept (the frames it lost may have been displayed).
          await chat?.setAIMessageContent(run.requestId, run.text);
        }
        chat?.setRun({
          runId: run.runId,
          requestId: run.requestId,
          reconnecting: false,
          resumed: run.resumed,
        });
      },
      onFrame: () => {
        if (chat?.run.reconnecting) chat.setRun({ reconnecting: false });
      },
      onDone: async ({ data, run }) => {
        if (
          run.requestId &&
          typeof data.partialText === 'string' &&
          data.status !== 'finished'
        ) {
          // The run ended without a committed reply: the runtime's kept
          // text is the truth, whatever this client had displayed.
          await chat?.setAIMessageContent(run.requestId, run.text);
        }
      },
      onDisconnect: () => {
        chat?.setRun({ reconnecting: true });
      },
    }),
    [onToolCall, onActionCall, onError, onReasoning],
  );

  /** Close the books on a stream that ended, unless a newer one took over. */
  const settleStream = useCallback(
    (seq: number, result: StreamRunResult, chat: OracleChat | undefined) => {
      if (seq !== streamSeqRef.current) return;
      chat?.setRun({
        runId: result.runId,
        requestId: result.requestId,
        reconnecting: false,
        resumed: result.resumed,
        ended: endedOf(result),
      });
      chat?.setStatus('ready');
      abortControllerRef.current = null;
      activeRunRef.current = null;
      sendingSessionRef.current = null;
    },
    [],
  );

  /**
   * The delegation is minted lazily and may not be there yet in the first
   * moments after a reload; a resume waits for it briefly instead of giving
   * up (a turn that is still running deserves the wait).
   */
  const delegationWithRetry = useCallback(
    async (did: string): Promise<string | null> => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const delegation = await getDelegation(did);
        if (delegation) return delegation;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    },
    [getDelegation],
  );

  const resumeRun = useCallback(
    async (runId: string) => {
      if (!apiUrl || !oracleDid) return;
      if (activeRunRef.current === runId) return;
      const chat = chatRef?.current;
      const delegation = await delegationWithRetry(oracleDid);
      if (!delegation) {
        console.warn(
          '[useSendMessage] a turn is still running but no UCAN delegation is available to re-join it',
        );
        return;
      }
      if (activeRunRef.current === runId) return; // attached meanwhile
      if (chatRef?.current !== chat) return; // the session changed meanwhile
      const invocation = await getInvocation(oracleDid);
      const seq = ++streamSeqRef.current;
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      activeRunRef.current = runId;
      sendingSessionRef.current = sessionId;
      chat?.setStatus('streaming');
      chat?.setRun({
        runId,
        requestId: null,
        reconnecting: false,
        resumed: 0,
        ended: null,
      });
      try {
        const result = await joinOracleRun({
          apiURL: apiUrl,
          runId,
          delegation,
          invocation,
          abortSignal: controller.signal,
          callbacks: frameCallbacks(chat),
        });
        settleStream(seq, result, chat);
      } catch (err) {
        if (seq === streamSeqRef.current) {
          activeRunRef.current = null;
          sendingSessionRef.current = null;
          if (abortControllerRef.current === controller)
            abortControllerRef.current = null;
          chat?.setStatus('ready');
        }
        console.warn(
          '[useSendMessage] could not resume the running turn:',
          err,
        );
      } finally {
        if (refetchQueries) {
          await refetchQueries();
        }
      }
    },
    [
      apiUrl,
      oracleDid,
      sessionId,
      chatRef,
      delegationWithRetry,
      getInvocation,
      frameCallbacks,
      settleStream,
      refetchQueries,
    ],
  );

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

      // The chat this turn belongs to. Everything below writes to it, not
      // to `chatRef`, which follows the user to other sessions.
      const chat = chatRef?.current;
      sendingSessionRef.current = sessionId;
      // A new message starts clean: an error banner from the previous turn
      // must not outlive the retry it prompted.
      chat?.clearError();
      // Set status to streaming
      chat?.setStatus('submitted');
      let controller: AbortController | null = null;

      try {
        // 1. Add optimistic user message immediately
        const userMessage: IMessage = {
          id: window.crypto.randomUUID(),
          content: message,
          type: 'human',
        };
        await chat?.addUserMessage(userMessage);

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
            await chat?.addUserMessage(fileMessage);
          }
        }

        // 2. Stream AI response
        chat?.setStatus('streaming');

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

        // Create abort controller for this request (a resumed stream that
        // is still attached is dropped: this message supersedes its turn)
        const seq = ++streamSeqRef.current;
        abortControllerRef.current?.abort();
        controller = new AbortController();
        abortControllerRef.current = controller;
        chat?.setRun({
          runId: null,
          requestId: null,
          reconnecting: false,
          resumed: 0,
          ended: null,
        });

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
                schema: zodToJsonSchema(tool.schema, JSON_SCHEMA_OPTIONS),
              }))
            : undefined,
          agActions:
            agActions.length > 0
              ? agActions.map((action) => ({
                  name: action.name,
                  description: action.description,
                  schema: zodToJsonSchema(
                    action.parameters,
                    JSON_SCHEMA_OPTIONS,
                  ),
                  hasRender: action.hasRender,
                }))
              : undefined,
          abortSignal: controller.signal,
          onRequestStarted: (requestId) => {
            chat?.setRun({ requestId });
          },
          onRunStarted: (runId) => {
            activeRunRef.current = runId;
          },
          callbacks: frameCallbacks(chat),
        });

        settleStream(seq, results, chat);

        return { requestId: results.requestId };
      } catch (err) {
        // Clear abort controller on error (only if it is still ours)
        if (abortControllerRef.current === controller)
          abortControllerRef.current = null;
        if (sendingSessionRef.current === sessionId)
          sendingSessionRef.current = null;

        // Handle abort errors gracefully - user intentionally cancelled
        if (
          err instanceof Error &&
          (err.name === 'AbortError' ||
            (err instanceof DOMException && err.name === 'AbortError'))
        ) {
          chat?.setStatus('ready');
          return;
        }

        if (RequestError.isRequestError(err) && err.claims) {
          onPaymentRequiredError(err.claims as string[]);
          chat?.setStatus('ready');
          return;
        }
        chat?.setStatus(
          'error',
          err instanceof Error ? err : new Error('Unknown error'),
        );
        throw err;
      } finally {
        // Clear abort controller when done (only if it is still ours)
        if (abortControllerRef.current === controller)
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
    resumeRun,
    detachStream,
    isSending: isPending && sendingSessionRef.current === sessionId,
    error,
    isConfigReady,
  };
}

/** Map how a stream ended (and its `done` frame) to the chat's run state. */
function endedOf(result: StreamRunResult): NonNullable<ChatRunState['ended']> {
  if (result.ended === 'aborted') return 'aborted';
  if (result.ended === 'disconnected' || result.ended === 'error')
    return 'disconnected';
  const done = result.done as SSEDoneEventData | undefined;
  if (!done) return 'done';
  if (done.interrupted || done.status === 'interrupted') return 'interrupted';
  if (done.aborted || done.status === 'aborted') return 'aborted';
  if (done.failed || done.status === 'failed') return 'failed';
  return 'done';
}

interface RunFrameCallbacks {
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
  /** The `run` frame: the turn's durable run id, or a resumed attempt. */
  onRun?: (args: {
    run: Readonly<RunStreamState>;
    frame: SSERunEventData;
  }) => void | Promise<void>;
  /** Any frame (clears a "reconnecting" state on the first one after a drop). */
  onFrame?: () => void;
  onDone?: (args: {
    data: SSEDoneEventData;
    run: Readonly<RunStreamState>;
  }) => void | Promise<void>;
  onDisconnect?: StreamRunInput['onDisconnect'];
}

const authHeaders = (
  delegation: string,
  invocation?: string | null,
): Record<string, string> => ({
  'x-ucan-delegation': delegation,
  ...(invocation && {
    Authorization: `Bearer ${invocation}`,
    'X-Auth-Type': 'ucan',
  }),
});

/** `GET /runs/:runId?after=<seq>` — re-join a durable run after a cursor. */
const joinRunRequest =
  (
    apiURL: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): StreamRunInput['join'] =>
  (runId, after) =>
    fetch(`${apiURL}/runs/${encodeURIComponent(runId)}?after=${after}`, {
      headers,
      method: 'GET',
      signal,
    });

/** Dispatch one SSE frame of a run to the typed callbacks. */
const frameHandler =
  (callbacks: RunFrameCallbacks): StreamRunInput['onEvent'] =>
  async (sseEvent, run) => {
    callbacks.onFrame?.();
    const requestId = run.requestId ?? '';
    // Type-safe event handling using discriminated unions
    switch (sseEvent.event) {
      case 'message':
        await callbacks.onMessage({ chunk: sseEvent.data.content, requestId });
        break;

      case 'tool_call':
        if (callbacks.onToolCall) {
          await callbacks.onToolCall({
            toolCallData: sseEvent.data,
            requestId,
          });
        }
        break;

      case 'action_call':
        if (callbacks.onActionCall) {
          await callbacks.onActionCall({
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
        if (callbacks.onError) {
          await callbacks.onError({ error: sseEvent.data, requestId });
        }
        break;

      case 'run':
        await callbacks.onRun?.({ run, frame: sseEvent.data });
        break;

      case 'done':
        await callbacks.onDone?.({ data: sseEvent.data, run });
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
        if (callbacks.onReasoning) {
          await callbacks.onReasoning({
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
  };

/** Attach to a run that is already executing: replay from the start, then live. */
const joinOracleRun = async (props: {
  apiURL: string;
  runId: string;
  delegation: string;
  invocation?: string | null;
  abortSignal?: AbortSignal;
  callbacks: RunFrameCallbacks;
}): Promise<StreamRunResult> => {
  const headers = authHeaders(props.delegation, props.invocation);
  return streamRun({
    resume: { runId: props.runId, after: 0 },
    start: () => Promise.reject(new Error('a resumed run is never started')),
    join: joinRunRequest(props.apiURL, headers, props.abortSignal),
    onEvent: frameHandler(props.callbacks),
    onDisconnect: props.callbacks.onDisconnect,
    signal: props.abortSignal,
  });
};

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
  /** The turn's request id, as soon as the runtime accepted the turn. */
  onRequestStarted?: (requestId: string) => void;
  /** The turn's durable run id, as soon as the runtime announced it. */
  onRunStarted?: (runId: string) => void;
  callbacks: RunFrameCallbacks;
}): Promise<StreamRunResult & { requestId: string }> => {
  const headers = authHeaders(props.delegation, props.invocation);
  let requestId: string | null = null;
  let result: StreamRunResult;
  try {
    result = await streamRun({
      start: async () => {
        const response = await fetch(
          `${props.apiURL}/messages/${props.sessionId}`,
          {
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({
              message: props.message,
              stream: true,
              ...(props.model && { model: props.model }),
              ...(props.metadata && { metadata: props.metadata }),
              ...(props.attachments?.length && {
                attachments: props.attachments,
              }),
              ...(props.browserTools && { tools: props.browserTools }),
              ...(props.agActions && { agActions: props.agActions }),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
            method: 'POST',
            signal: props.abortSignal,
          },
        );
        requestId = response.headers.get('X-Request-Id');
        if (response.ok) {
          if (!requestId) {
            throw new Error('Did not receive a request ID');
          }
          props.onRequestStarted?.(requestId);
          // Check if ReadableStream is supported
          if (!response.body) {
            throw new Error('ReadableStream not supported in this browser');
          }
          const runId = response.headers.get('x-run-id');
          if (runId) props.onRunStarted?.(runId);
        }
        return response;
      },
      join: joinRunRequest(props.apiURL, headers, props.abortSignal),
      onEvent: frameHandler(props.callbacks),
      onDisconnect: props.callbacks.onDisconnect,
      signal: props.abortSignal,
    });
  } catch (error) {
    if (error instanceof StreamRunStartError) {
      let parsed: { message?: string } = {};
      try {
        parsed = JSON.parse(error.body) as { message?: string };
      } catch {
        parsed = { message: error.body || error.message };
      }
      throw withRequestId(
        new RequestError(parsed.message ?? error.message, parsed),
        requestId,
      );
    }
    throw withRequestId(error, requestId);
  }
  return { ...result, requestId: result.requestId ?? requestId ?? '' };
};
