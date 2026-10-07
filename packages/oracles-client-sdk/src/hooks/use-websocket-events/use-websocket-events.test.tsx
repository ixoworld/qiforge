// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { IOraclesContextProps } from '../../providers/oracles-provider/types.js';
import type { IBrowserTools } from '../../types/browser-tool.type.js';
import type { IWebSocketConfig } from './types.js';
import { useWebSocketEvents } from './use-websocket-events.js';

type RenewOracleAuth = IOraclesContextProps['renewOracleAuth'];

const ORACLE = 'did:ixo:oracle';

/** The parts of a socket.io client socket the hook uses. */
class FakeSocket {
  active = true;
  connected = false;
  handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  emit = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  onAny = vi.fn();
  on(event: string, handler: (...args: unknown[]) => unknown) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  async fire(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? [])
      await handler(...args);
  }
}

interface IoOptions {
  auth: ((cb: (data: object) => void) => void) | Record<string, unknown>;
}
const sockets: { socket: FakeSocket; options: IoOptions }[] = [];
vi.mock('socket.io-client', () => ({
  io: (_url: string, options: IoOptions) => {
    const socket = new FakeSocket();
    sockets.push({ socket, options });
    return socket;
  },
}));

let context: IOraclesContextProps;
vi.mock('../../providers/oracles-provider/oracles-context.js', () => ({
  useOraclesContext: () => context,
}));
vi.mock('../use-oracles-config.js', () => ({
  useOraclesConfig: () => ({
    config: { apiUrl: 'https://oracle.test', socketUrl: 'https://ws.test' },
    isReady: true,
  }),
}));

function makeContext(
  overrides: Partial<IOraclesContextProps> = {},
): IOraclesContextProps {
  return {
    wallet: {
      did: 'did:ixo:user-a',
      address: 'ixo1usera',
      matrix: { accessToken: 'mx', homeServer: 'hs' },
    },
    transactSignX: vi.fn(),
    authedRequest: vi.fn(),
    getDelegation: vi.fn(async () => 'delegation'),
    getInvocation: vi.fn(async () => 'inv-1'),
    renewOracleAuth: vi.fn(async () => true),
    agActions: [],
    registeredAgActions: [],
    registerAgAction: vi.fn(),
    unregisterAgAction: vi.fn(),
    executeAgAction: vi.fn(),
    getAgActionRender: vi.fn(),
    ...overrides,
  };
}

const authOf = (options: IoOptions) =>
  new Promise<object>((resolve) => {
    if (typeof options.auth !== 'function')
      throw new Error('the handshake auth is a fixed object');
    options.auth(resolve);
  });

const baseProps: IWebSocketConfig = {
  oracleDid: ORACLE,
  sessionId: 'sess',
  handleNewEvent: () => undefined,
};

describe('useWebSocketEvents', () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  it('builds the handshake credentials on every connect, so a reconnect sends a current invocation', async () => {
    let invocation = 'inv-1';
    context = makeContext({ getInvocation: vi.fn(async () => invocation) });
    renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { options } = sockets[0]!;

    expect(await authOf(options)).toEqual({
      ucanDelegation: 'delegation',
      invocation: 'inv-1',
    });
    // Minutes later the cached invocation was replaced; the socket dropped
    // and socket.io asks for the handshake payload again.
    invocation = 'inv-2';
    expect(await authOf(options)).toEqual({
      ucanDelegation: 'delegation',
      invocation: 'inv-2',
    });
  });

  it('a CONNECT refused for its credentials renews them in two stages, then stops', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
    context = makeContext({ renewOracleAuth });
    renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket, options } = sockets[0]!;
    await authOf(options); // the first CONNECT's credentials
    const refuse = () =>
      act(async () => {
        await socket.fire(
          'connect_error',
          new Error('Unauthorized: Invalid UCAN invocation: expired'),
        );
      });

    // socket.io destroys a socket whose CONNECT was refused: not active.
    socket.active = false;
    await refuse();
    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
    expect(renewOracleAuth).toHaveBeenLastCalledWith(ORACLE, 1, {
      delegation: 'delegation',
      invocation: 'inv-1',
    });

    // Refused again: the delegation stage, then one last CONNECT.
    await refuse();
    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(2));
    expect(renewOracleAuth).toHaveBeenLastCalledWith(
      ORACLE,
      2,
      expect.anything(),
    );

    // Refused a third time: no loop.
    await refuse();
    expect(renewOracleAuth).toHaveBeenCalledTimes(2);
    expect(socket.connect).toHaveBeenCalledTimes(2);

    // A transport failure (still active) is socket.io's own retry.
    socket.active = true;
    await act(async () => {
      await socket.fire('connect_error', new Error('xhr poll error'));
    });
    expect(socket.connect).toHaveBeenCalledTimes(2);
  });

  it('a CONNECT accepted after stage 1 never reaches the delegation stage, and earns the next refusal stage 1 again', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
    context = makeContext({ renewOracleAuth });
    renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket } = sockets[0]!;
    socket.active = false;
    const refuse = () =>
      act(async () => {
        await socket.fire(
          'connect_error',
          new Error('Unauthorized: Invalid UCAN invocation: expired'),
        );
      });

    await refuse();
    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
    await act(async () => {
      await socket.fire('connect');
    });
    await refuse();
    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(2));

    expect(renewOracleAuth.mock.calls.map((call) => call[1])).toEqual([1, 1]);
  });

  it('does not connect again when nothing could be renewed', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => false);
    context = makeContext({ renewOracleAuth });
    renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket } = sockets[0]!;
    socket.active = false;

    await act(async () => {
      await socket.fire(
        'connect_error',
        new Error('Unauthorized: Invalid UCAN invocation: expired'),
      );
    });
    await waitFor(() => expect(renewOracleAuth).toHaveBeenCalledTimes(1));
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('a CONNECT refused for a reason other than its credentials renews nothing', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
    context = makeContext({ renewOracleAuth });
    renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket } = sockets[0]!;

    socket.active = false;
    for (const message of [
      'Session sess not found',
      'Unauthorized: session check failed',
      'Unauthorized: token does not belong to the routed user',
    ]) {
      await act(async () => {
        await socket.fire('connect_error', new Error(message));
      });
    }

    expect(renewOracleAuth).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('answers browser tool calls for tools registered after the socket connected', async () => {
    context = makeContext();
    const fn = vi.fn(async (args: unknown) => ({ received: args }));
    const tools: IBrowserTools = {
      propose_topic: {
        toolName: 'propose_topic',
        description: 'Propose a topic',
        schema: z.object({ title: z.string() }),
        fn,
      },
    };
    const { rerender } = renderHook(
      (props: IWebSocketConfig) => useWebSocketEvents(props),
      { initialProps: baseProps },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket } = sockets[0]!;

    rerender({ ...baseProps, browserTools: tools });
    await act(async () => {
      await socket.fire('browser_tool_call', {
        sessionId: 'sess',
        toolCallId: 'call-1',
        toolName: 'propose_topic',
        args: { title: 'Hi' },
      });
    });

    expect(fn).toHaveBeenCalledWith({ title: 'Hi' });
    expect(socket.emit).toHaveBeenCalledWith('tool_result', {
      toolCallId: 'call-1',
      sessionId: 'sess',
      result: { received: { title: 'Hi' } },
    });
  });

  it('leaves a browser tool call unanswered while it has no browser tools (another client of the session may)', async () => {
    context = makeContext();
    renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket } = sockets[0]!;

    await act(async () => {
      await socket.fire('browser_tool_call', {
        sessionId: 'sess',
        toolCallId: 'call-1',
        toolName: 'propose_topic',
        args: {},
      });
    });
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
