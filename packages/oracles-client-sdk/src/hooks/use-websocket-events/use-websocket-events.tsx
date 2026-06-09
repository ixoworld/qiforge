/* eslint-disable no-console */
import { type AllEvents } from '@ixo/oracles-events/types';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useOraclesContext } from '../../providers/oracles-provider/oracles-context.js';
import { useOraclesConfig } from '../use-oracles-config.js';
import {
  type ConnectionStatus,
  type IUseWebSocketEventsReturn,
  type IWebSocketConfig,
  type WebSocketEvent,
} from './types.js';
import { executeToolAndEmitResult } from './tool-executor.js';

export function useWebSocketEvents(
  props: IWebSocketConfig,
): IUseWebSocketEventsReturn {
  const { config, isReady: isConfigReady } = useOraclesConfig(
    props.oracleDid,
    props.overrides,
  );
  const { wallet, getDelegation, getInvocation } = useOraclesContext();

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

    const connect = async () => {
      const delegation = await getDelegation(props.oracleDid);
      if (cancelled) return;

      if (!delegation) {
        setConnectionStatus('error');
        setError(
          new Error(
            'Missing UCAN delegation — cannot open authenticated WebSocket connection',
          ),
        );
        return;
      }

      // Resolve the UCAN invocation (treated like a bearer token) alongside
      // the delegation. Migration-safe: if no createInvocation callback is
      // provided this is null and the handshake behaves as before.
      const invocation = await getInvocation(props.oracleDid);
      if (cancelled) return;

      // Create WebSocket connection
      const newSocket = io(apiUrl, {
        query: { sessionId, userDid: wallet.did },
        auth: {
          ucanDelegation: delegation,
          ...(invocation && { invocation }),
        },
        transports: ['websocket'],
      });

      activeSocket = newSocket;
      socketRef.current = newSocket;

      // Connection event handlers
      newSocket.on('connect', () => {
        setIsConnected(true);
        setConnectionStatus('connected');
        setLastActivity(new Date().toISOString());
        setError(null);
      });

      newSocket.on('disconnect', () => {
        setIsConnected(false);
        setConnectionStatus('disconnected');
        setLastActivity(new Date().toISOString());
      });

      newSocket.on('connect_error', (err) => {
        setIsConnected(false);
        setConnectionStatus('error');
        setError(err);
        setLastActivity(new Date().toISOString());
      });

      const handleEvent = (event: AllEvents) => {
        props.handleNewEvent?.(event);
      };

      newSocket.on(evNames.ToolCall, handleEvent);
      newSocket.on(evNames.RenderComponent, handleEvent);
      newSocket.on(
        evNames.MessageCacheInvalidation,
        handleInvalidateCacheRef.current ?? (() => {}),
      );

      if (
        browserToolsRef.current &&
        Object.keys(browserToolsRef.current).length > 0
      ) {
        // Listen for browser tool calls
        newSocket.on(
          'browser_tool_call',
          async (data: {
            toolCallId: string;
            toolName: string;
            args: Record<string, unknown>;
          }) => {
            await executeToolAndEmitResult(
              {
                socket: newSocket,
                toolId: data.toolCallId,
                eventName: 'tool_result',
              },
              async () => {
                const tool = browserToolsRef.current?.[data.toolName];
                if (!tool) {
                  throw new Error(`Tool ${data.toolName} not found`);
                }
                return await tool.fn(data.args);
              },
            );
          },
        );
      }

      // Listen for AG-UI action calls (always register listener, even if no tools yet)
      // The listener will check actionToolsRef at execution time
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
  }, [sessionId, wallet, apiUrl]);

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
