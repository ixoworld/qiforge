import type { WithRequiredEventProps } from '@ixo/oracles-events/types';
import type { Socket } from 'socket.io-client';
import { type IBrowserTools } from '../../types/browser-tool.type.js';
import { type IActionTools } from '../../types/action-tool.type.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebSocketEvent<T = Record<string, any>> = {
  eventName: string;
  payload: WithRequiredEventProps<T>;
};

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface IWebSocketConfig {
  oracleDid: string;
  sessionId: string;
  handleInvalidateCache?: () => void;
  handleNewEvent: (event: WebSocketEvent) => void;
  browserTools?: IBrowserTools;
  actionTools?: IActionTools;
  /**
   * What the runtime uses this socket for. `'foreground'` (the default):
   * the socket renders the chat — it receives the session's events and
   * runs any browser tool or AG-UI action call of the session. With
   * `'background'` the CONNECT declares the socket a background executor
   * (`executor: 'background'` and `tools`: the names of `browserTools`,
   * read again at every CONNECT): the runtime sends it only calls of the
   * declared browser tools, and only when no foreground socket of the
   * session is connected, and none of the session's events. A runtime
   * keeps at most 24 names that match `^[A-Za-z0-9_-]{1,64}$`. A
   * background socket never listens for AG-UI action calls, answers a
   * browser tool call only after the runtime's `connected` event echoed
   * `executor: 'background'`, and refuses (a `tool_result` error) a tool
   * its latest CONNECT did not declare; when the `connected` event lacks
   * that echo (a runtime without background executors) it closes, never
   * reconnects, and reports `connectionStatus` `'error'` with an error of
   * code `BACKGROUND_EXECUTOR_UNSUPPORTED`. A background socket never
   * involves the user: it sends the cached
   * delegation only (`getDelegation(oracleDid, { background: true })`;
   * none cached: `connectionStatus` `'error'` with an error of code
   * `BACKGROUND_SOCKET_UNAVAILABLE`, and nothing is opened), mints
   * invocations with `getInvocation(oracleDid, { background: true })` and
   * never connects without one (the same error, the socket closed), and
   * renews a refused CONNECT with stage 1 only, in background mode — when
   * that renews nothing the socket stays disconnected with the refusal as
   * its error. Changing it reconnects the socket.
   */
  executor?: 'foreground' | 'background';
  overrides?: {
    baseUrl?: string;
    wsUrl?: string;
  };
}

export interface IUseWebSocketEventsReturn {
  isConnected: boolean;
  error: Error | null;
  connectionStatus: ConnectionStatus;
  lastActivity: string | null;
  isConfigReady: boolean;
  socket: Socket | null;
}
