/* eslint-disable no-console */
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useOraclesContext } from '../../providers/oracles-provider/oracles-context.js';
import {
  BACKGROUND_EXECUTOR_UNSUPPORTED,
  BACKGROUND_SOCKET_UNAVAILABLE,
  isCredentialRefusalMessage,
  type AuthRenewalStage,
  type RefusedCredentials,
} from '../../utils/auth-renewal.js';
import { RequestError } from '../../utils/request.js';
import { useOraclesConfig } from '../use-oracles-config.js';
import {
  executeBrowserToolCall,
  executeToolAndEmitResult,
  refuseBrowserToolCall,
  type BrowserToolCall,
} from './tool-executor.js';
import {
  type ConnectionStatus,
  type IUseWebSocketEventsReturn,
  type IWebSocketConfig,
  type WebSocketEvent,
} from './types.js';

export function useWebSocketEvents(
  props: IWebSocketConfig,
): IUseWebSocketEventsReturn {
  const { config, isReady: isConfigReady } = useOraclesConfig(
    props.oracleDid,
    props.overrides,
  );
  const { wallet, getDelegation, getInvocation, renewOracleAuth } =
    useOraclesContext();

  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [lastActivity, setLastActivity] = useState<string | null>(null);

  // Use ref to store socket to prevent reconnections on re-renders
  const socketRef = useRef<Socket | null>(null);
  // Use ref to store callback to prevent dependency issues
  const handleInvalidateCacheRef = useRef(props.handleInvalidateCache);
  const browserToolsRef = useRef(props.browserTools);
  const actionToolsRef = useRef(props.actionTools);

  // Update the callback refs when they change
  handleInvalidateCacheRef.current = props.handleInvalidateCache;
  browserToolsRef.current = props.browserTools;
  actionToolsRef.current = props.actionTools;

  const { sessionId, overrides } = props;
  const background = props.executor === 'background';

  const apiUrl = overrides?.wsUrl ?? config.socketUrl ?? overrides?.baseUrl;

  useEffect(() => {
    if (!wallet || !sessionId || !apiUrl) {
      return;
    }

    // Don't create new connection if one already exists for the same session
    if (socketRef.current?.connected) {
      return;
    }

    setConnectionStatus('connecting');
    setError(null);

    // The server REQUIRES a valid UCAN delegation on the WS handshake and
    // derives the user identity from it. Resolve the delegation (minting one
    // if it isn't cached yet) before opening the socket so the connection is
    // never rejected for a missing delegation. The async gap means we guard
    // the effect with `cancelled` and disconnect via the captured socket.
    let cancelled = false;
    let activeSocket: Socket | null = null;

    // A background socket never involves the user: it takes the cached
    // delegation only, mints invocations without user interaction, and
    // renews a refused CONNECT with stage 1 only (stage 2 mints a
    // delegation, a wallet prompt).
    const connect = async () => {
      const delegation = background
        ? await getDelegation(props.oracleDid, { background: true })
        : await getDelegation(props.oracleDid);
      if (cancelled) return;

      if (!delegation) {
        setConnectionStatus('error');
        setError(
          background
            ? new RequestError(
                `A background socket needs a cached delegation to ${props.oracleDid}: none is cached, and a background socket never mints one`,
                { code: BACKGROUND_SOCKET_UNAVAILABLE },
              )
            : new Error(
                'Missing UCAN delegation — cannot open authenticated WebSocket connection',
              ),
        );
        return;
      }

      // The handshake payload is built on every CONNECT (socket.io calls
      // `auth` again for each reconnect), so a socket that reconnects after
      // the cached invocation expired sends a current one. The invocation
      // is treated like a bearer token; without a createInvocation callback
      // it is null and a foreground handshake carries the delegation only.
      const oracleDid = props.oracleDid;
      // The credentials the latest CONNECT carried, for the renewal.
      let sent: RefusedCredentials = {};
      // The browser tools the latest background CONNECT declared: the only
      // calls a background socket runs.
      let declaredTools: ReadonlySet<string> = new Set();
      // Whether the runtime confirmed this connection as a background
      // executor (its `connected` event echoed it). Until it has, a
      // background socket runs and answers nothing: a runtime that ignored
      // the declaration may also send the call to the foreground socket.
      let backgroundConfirmed = false;
      const newSocket = io(apiUrl, {
        query: { sessionId, userDid: wallet.did },
        auth: (cb) => {
          if (background) {
            // Never a prompt and never a bare delegation: the CONNECT is
            // sent only with an invocation the host minted without the
            // user (or a cached one). It declares the browser tools this
            // socket can run, read now so tools registered since the last
            // CONNECT are declared.
            void Promise.all([
              getDelegation(oracleDid, { background: true }),
              getInvocation(oracleDid, { background: true }),
            ])
              .then(([current, invocation]) => {
                if (!invocation) {
                  stopWithoutInvocation();
                  return;
                }
                sent = { delegation: current ?? delegation, invocation };
                const tools = Object.keys(browserToolsRef.current ?? {});
                declaredTools = new Set(tools);
                cb({
                  ucanDelegation: current ?? delegation,
                  invocation,
                  executor: 'background',
                  tools,
                });
              })
              .catch(() => stopWithoutInvocation());
            return;
          }
          void Promise.all([getDelegation(oracleDid), getInvocation(oracleDid)])
            .then(([current, invocation]) => {
              sent = { delegation: current ?? delegation, invocation };
              cb({
                ucanDelegation: current ?? delegation,
                ...(invocation && { invocation }),
              });
            })
            .catch(() => {
              sent = { delegation, invocation: null };
              cb({ ucanDelegation: delegation });
            });
        },
        transports: ['websocket'],
      });

      // A background CONNECT without an invocation is not sent: the socket
      // is closed instead of answering socket.io's `auth` callback (closing
      // a socket that has not connected emits no `disconnect`).
      const stopWithoutInvocation = () => {
        newSocket.disconnect();
        if (cancelled) return;
        setIsConnected(false);
        setConnectionStatus('error');
        setError(
          new RequestError(
            `A background socket needs an invocation to ${oracleDid} minted without the user: none is cached and the host minted none, and a background socket never connects with a bare delegation`,
            { code: BACKGROUND_SOCKET_UNAVAILABLE },
          ),
        );
        setLastActivity(new Date().toISOString());
      };

      activeSocket = newSocket;
      socketRef.current = newSocket;

      // socket.io never retries a CONNECT the server refused (the socket is
      // no longer `active`). A refusal of the credentials renews them
      // (stage 1: a fresh invocation) and connects again; refused again,
      // stage 2 (a fresh delegation, then a fresh invocation) and one last
      // CONNECT. Any other refusal (an unknown session, a failed session
      // check) is final. A connection that succeeds earns the next refusal
      // its own renewal, starting again at stage 1. A background socket
      // stops after stage 1.
      let renewalStage: 0 | AuthRenewalStage = 0;
      const lastStage: AuthRenewalStage = background ? 1 : 2;

      // Connection event handlers
      newSocket.on('connect', () => {
        renewalStage = 0;
        setIsConnected(true);
        setConnectionStatus('connected');
        setLastActivity(new Date().toISOString());
        setError(null);
      });

      newSocket.on('disconnect', () => {
        backgroundConfirmed = false;
        setIsConnected(false);
        setConnectionStatus('disconnected');
        setLastActivity(new Date().toISOString());
      });

      // A runtime that knows executor kinds echoes the accepted one in its
      // `connected` event. One that does not echo `background` ignored the
      // declaration and treats this socket as a foreground one: it would
      // send it the session's events, AG-UI action calls (wallet signing
      // among them) and calls of any browser tool. A background socket
      // closes at once on such a runtime (a client-side close: socket.io
      // does not reconnect) and reports why. The runtime sends `connected`
      // before any call, and until it confirmed the executor a background
      // socket answers no call (`backgroundConfirmed`).
      if (background) {
        newSocket.on('connected', (payload: unknown) => {
          if (cancelled) return;
          if (
            typeof payload === 'object' &&
            payload !== null &&
            (payload as { executor?: unknown }).executor === 'background'
          ) {
            backgroundConfirmed = true;
            return;
          }
          newSocket.disconnect();
          setIsConnected(false);
          setConnectionStatus('error');
          setError(
            new RequestError(
              `The runtime of ${oracleDid} does not support background executors: its \`connected\` event did not confirm \`executor: 'background'\`, so the socket was closed`,
              { code: BACKGROUND_EXECUTOR_UNSUPPORTED },
            ),
          );
          setLastActivity(new Date().toISOString());
        });
      }

      newSocket.on('connect_error', (err) => {
        setIsConnected(false);
        setConnectionStatus('error');
        setError(err);
        setLastActivity(new Date().toISOString());
        if (
          newSocket.active ||
          !isCredentialRefusalMessage(err.message) ||
          renewalStage === lastStage ||
          cancelled
        )
          return;
        const stage: AuthRenewalStage = renewalStage === 0 ? 1 : 2;
        renewalStage = stage;
        void (
          background
            ? renewOracleAuth(oracleDid, stage, sent, { background: true })
            : renewOracleAuth(oracleDid, stage, sent)
        ).then((renewed) => {
          if (renewed && !cancelled) newSocket.connect();
        });
      });

      // Every server event is forwarded once, by the `onAny` listener below
      // (a dedicated `on(...)` per event name on top of it delivered
      // tool_call / render_component / cache invalidation twice).

      // Tools can arrive after connection: always listen, and read the
      // current registry only at dispatch. A call is run only for this
      // connection's own session and only while this connection is current
      // (a late call to a socket of a previous session or lifecycle is not).
      // The runtime sends a call to one socket of the session only, so every
      // call of this session gets a definite answer: a client with no
      // browser tools answers `Tool <name> not found: no browser tools
      // registered` rather than leaving the call to end as an unknown
      // outcome. A background socket also refuses a tool its latest CONNECT
      // did not declare.
      newSocket.on('browser_tool_call', async (data: BrowserToolCall) => {
        if (cancelled || data.sessionId !== sessionId) return;
        if (background && !backgroundConfirmed) return;
        if (background && !declaredTools.has(data.toolName)) {
          refuseBrowserToolCall(
            newSocket,
            data,
            `Tool ${data.toolName} not found: not declared by this background executor`,
          );
          return;
        }
        await executeBrowserToolCall(newSocket, browserToolsRef.current, data);
      });

      // Listen for AG-UI action calls (always register listener, even if no tools yet)
      // The listener will check actionToolsRef at execution time. Only a
      // running call of this session is executed; a status frame of an
      // action that already ran (`done` / `error`) is not a new call. A
      // background socket never runs an AG-UI action (wallet signing is
      // one): it registers no listener.
      if (!background) {
        newSocket.on(
          'action_call',
          async (data: {
            sessionId: string;
            requestId: string;
            toolName: string;
            toolCallId: string;
            args: Record<string, unknown>;
            status: string;
          }) => {
            if (
              cancelled ||
              data.sessionId !== sessionId ||
              data.status !== 'isRunning'
            )
              return;
            const tool = actionToolsRef.current?.[data.toolName];
            if (!tool) {
              console.error(
                `[SDK WS] Action tool ${data.toolName} not found in registry`,
                'Available tools:',
                Object.keys(actionToolsRef.current || {}),
              );
              // Send error back to server
              newSocket.emit('action_call_result', {
                toolCallId: data.toolCallId,
                sessionId: data.sessionId,
                result: {
                  success: false,
                  error: `Action tool ${data.toolName} not found`,
                },
                error: `Action tool ${data.toolName} not found`,
              });
              return;
            }

            await executeToolAndEmitResult(
              {
                socket: newSocket,
                toolId: data.toolCallId,
                eventName: 'action_call_result',
                sessionId: data.sessionId,
              },
              async () => {
                return await tool.handler(data.args);
              },
            );

            // Call render function immediately after successful handler execution
            // This provides immediate UI feedback without waiting for SSE status update
            if (tool.render) {
              try {
                tool.render({
                  status: 'done',
                  args: data.args,
                });
              } catch (renderError) {
                console.error(
                  `[SDK WS] Error calling render for ${data.toolName}:`,
                  renderError,
                );
              }
            }
          },
        );
      }

      // Listen for all events from the server
      newSocket.onAny((_, ev: unknown) => {
        const event = isWebSocketEvent(ev) ? ev : null;
        if (!event) {
          return;
        }
        // Skip browser_tool_call and action_call events as they're handled above
        if (
          event.eventName === 'browser_tool_call' ||
          event.eventName === 'action_call'
        ) {
          return;
        }

        props.handleNewEvent?.(event);
        setLastActivity(new Date().toISOString());

        // Handle cache invalidation using ref
        if (
          event.eventName === 'message_cache_invalidation' &&
          handleInvalidateCacheRef.current
        ) {
          handleInvalidateCacheRef.current();
        }
      });
    };

    void connect();

    // Cleanup on unmount
    return () => {
      cancelled = true;
      activeSocket?.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      setConnectionStatus('disconnected');
    };
  }, [
    sessionId,
    wallet?.did,
    wallet?.address,
    wallet?.matrix.accessToken,
    apiUrl,
    background,
  ]);

  return {
    isConnected,
    error,
    connectionStatus,
    lastActivity,
    isConfigReady,
    socket: socketRef.current,
  };
}

// Export event names for convenience (same as SSE version)
export const evNames = {
  ToolCall: 'tool_call',
  ActionCall: 'action_call',
  RenderComponent: 'render_component',
  MessageCacheInvalidation: 'message_cache_invalidation',
  RouterUpdate: 'router_update',
  BrowserToolCall: 'browser_tool_call',
} as const;

const isWebSocketEvent = (event: unknown): event is WebSocketEvent => {
  return (
    typeof event === 'object' &&
    event !== null &&
    'eventName' in event &&
    'payload' in event &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    'sessionId' in event.payload &&
    'requestId' in event.payload
  );
};
