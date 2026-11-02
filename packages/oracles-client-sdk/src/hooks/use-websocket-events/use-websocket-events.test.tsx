// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { IOraclesContextProps } from '../../providers/oracles-provider/types.js';
import type { IBrowserTools } from '../../types/browser-tool.type.js';
import {
  BACKGROUND_EXECUTOR_UNSUPPORTED,
  BACKGROUND_SOCKET_UNAVAILABLE,
} from '../../utils/auth-renewal.js';
import type { IWebSocketConfig } from './types.js';
import { useWebSocketEvents } from './use-websocket-events.js';

type RenewOracleAuth = IOraclesContextProps['renewOracleAuth'];
type GetDelegation = IOraclesContextProps['getDelegation'];
type GetInvocation = IOraclesContextProps['getInvocation'];

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

  it('a foreground socket sends exactly the credentials, by default and when asked for', async () => {
    context = makeContext();
    const tools: IBrowserTools = {
      propose_topic: {
        toolName: 'propose_topic',
        description: 'Propose a topic',
        schema: z.object({ title: z.string() }),
        fn: vi.fn(),
      },
    };
    renderHook(() => useWebSocketEvents({ ...baseProps, browserTools: tools }));
    renderHook(() =>
      useWebSocketEvents({
        ...baseProps,
        browserTools: tools,
        executor: 'foreground',
      }),
    );
    await waitFor(() => expect(sockets).toHaveLength(2));
    for (const { options } of sockets)
      expect(JSON.stringify(await authOf(options))).toBe(
        '{"ucanDelegation":"delegation","invocation":"inv-1"}',
      );
    // Credentials are read as before: no options, so a mint may run.
    expect(vi.mocked(context.getDelegation).mock.calls).toEqual(
      Array.from({ length: 4 }, () => [ORACLE]),
    );
    expect(vi.mocked(context.getInvocation).mock.calls).toEqual([
      [ORACLE],
      [ORACLE],
    ]);
  });

  it('a foreground socket renews a refused CONNECT without the background option', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
    context = makeContext({ renewOracleAuth });
    renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket, options } = sockets[0]!;
    await authOf(options);
    socket.active = false;
    await act(async () => {
      await socket.fire(
        'connect_error',
        new Error('Unauthorized: Invalid UCAN invocation: expired'),
      );
    });
    await waitFor(() => expect(renewOracleAuth).toHaveBeenCalledTimes(1));
    expect(renewOracleAuth.mock.calls[0]).toEqual([
      ORACLE,
      1,
      { delegation: 'delegation', invocation: 'inv-1' },
    ]);
  });

  it('a background socket declares itself and its browser tools, read again at every CONNECT', async () => {
    context = makeContext();
    const tool = (toolName: string) => ({
      toolName,
      description: toolName,
      schema: z.object({}),
      fn: vi.fn(),
    });
    const { rerender } = renderHook(
      (props: IWebSocketConfig) => useWebSocketEvents(props),
      {
        initialProps: {
          ...baseProps,
          executor: 'background',
          browserTools: { vault_list: tool('vault_list') },
        },
      },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { options } = sockets[0]!;
    expect(await authOf(options)).toEqual({
      ucanDelegation: 'delegation',
      invocation: 'inv-1',
      executor: 'background',
      tools: ['vault_list'],
    });

    // A tool registered since: the next CONNECT (a reconnect) declares it,
    // on the same socket.
    rerender({
      ...baseProps,
      executor: 'background',
      browserTools: {
        vault_list: tool('vault_list'),
        find_entity: tool('find_entity'),
      },
    });
    expect(await authOf(options)).toEqual({
      ucanDelegation: 'delegation',
      invocation: 'inv-1',
      executor: 'background',
      tools: ['vault_list', 'find_entity'],
    });
    expect(sockets).toHaveLength(1);
    // Never a read that could mint interactively.
    expect(vi.mocked(context.getDelegation).mock.calls).toEqual(
      Array.from({ length: 3 }, () => [ORACLE, { background: true }]),
    );
    expect(vi.mocked(context.getInvocation).mock.calls).toEqual([
      [ORACLE, { background: true }],
      [ORACLE, { background: true }],
    ]);
  });

  it('a background socket without a cached delegation opens nothing and reports why', async () => {
    const getDelegation = vi.fn<GetDelegation>(async (_oracle, options) =>
      options?.background ? null : 'minted-delegation',
    );
    const getInvocation = vi.fn<GetInvocation>(async () => 'inv-1');
    context = makeContext({ getDelegation, getInvocation });
    const { result } = renderHook(() =>
      useWebSocketEvents({ ...baseProps, executor: 'background' }),
    );

    await waitFor(() => expect(result.current.connectionStatus).toBe('error'));
    expect(sockets).toHaveLength(0);
    expect(result.current.error).toMatchObject({
      code: BACKGROUND_SOCKET_UNAVAILABLE,
    });
    expect(result.current.error?.message).toContain('cached delegation');
    expect(getDelegation.mock.calls).toEqual([[ORACLE, { background: true }]]);
    expect(getInvocation).not.toHaveBeenCalled();
  });

  it('a background socket renews a refused CONNECT with a background stage 1 only, never stage 2', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
    context = makeContext({ renewOracleAuth });
    const { result } = renderHook(() =>
      useWebSocketEvents({ ...baseProps, executor: 'background' }),
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket, options } = sockets[0]!;
    await authOf(options);
    const refuse = () =>
      act(async () => {
        await socket.fire(
          'connect_error',
          new Error('Unauthorized: Invalid UCAN invocation: expired'),
        );
      });

    socket.active = false;
    await refuse();
    await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
    expect(renewOracleAuth.mock.calls).toEqual([
      [
        ORACLE,
        1,
        { delegation: 'delegation', invocation: 'inv-1' },
        { background: true },
      ],
    ]);

    // Refused again: no delegation stage, the socket stays down.
    await refuse();
    expect(renewOracleAuth).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(result.current.connectionStatus).toBe('error');
  });

  it('a background socket whose stage 1 renews nothing stays disconnected with the refusal', async () => {
    const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => false);
    context = makeContext({ renewOracleAuth });
    const { result } = renderHook(() =>
      useWebSocketEvents({ ...baseProps, executor: 'background' }),
    );
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
    expect(renewOracleAuth.mock.calls[0]?.[3]).toEqual({ background: true });
    expect(socket.connect).not.toHaveBeenCalled();
    expect(result.current.connectionStatus).toBe('error');
    expect(result.current.error?.message).toBe(
      'Unauthorized: Invalid UCAN invocation: expired',
    );
  });

  it('a background socket without browser tools declares none', async () => {
    context = makeContext();
    renderHook(() =>
      useWebSocketEvents({ ...baseProps, executor: 'background' }),
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(await authOf(sockets[0]!.options)).toEqual({
      ucanDelegation: 'delegation',
      invocation: 'inv-1',
      executor: 'background',
      tools: [],
    });
  });

  it('a background socket never sends a bare delegation: without a silent invocation it closes and reports why', async () => {
    for (const getInvocation of [
      vi.fn<GetInvocation>(async () => null),
      vi.fn<GetInvocation>(async () => {
        throw new Error('signer locked');
      }),
    ]) {
      sockets.length = 0;
      context = makeContext({ getInvocation });
      const { result, unmount } = renderHook(() =>
        useWebSocketEvents({ ...baseProps, executor: 'background' }),
      );
      await waitFor(() => expect(sockets).toHaveLength(1));
      const { socket, options } = sockets[0]!;
      const { auth } = options;
      if (typeof auth !== 'function')
        throw new Error('the handshake auth is a fixed object');
      const send = vi.fn();
      await act(async () => {
        auth(send);
      });

      await waitFor(() => expect(socket.disconnect).toHaveBeenCalledTimes(1));
      expect(send).not.toHaveBeenCalled();
      expect(getInvocation.mock.calls).toEqual([
        [ORACLE, { background: true }],
      ]);
      expect(result.current.connectionStatus).toBe('error');
      expect(result.current.error).toMatchObject({
        code: BACKGROUND_SOCKET_UNAVAILABLE,
      });
      expect(result.current.error?.message).toContain('invocation');
      unmount();
    }
  });

  it('changing the executor kind reconnects the socket', async () => {
    context = makeContext();
    const { rerender } = renderHook(
      (props: IWebSocketConfig) => useWebSocketEvents(props),
      { initialProps: { ...baseProps, executor: 'background' } },
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    rerender({ ...baseProps, executor: 'foreground' });
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0]!.socket.disconnect).toHaveBeenCalled();
    expect(await authOf(sockets[1]!.options)).toEqual({
      ucanDelegation: 'delegation',
      invocation: 'inv-1',
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

  it('answers a definite error to a browser tool call while it has no browser tools', async () => {
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
      // Another session's call is still not this socket's to answer.
      await socket.fire('browser_tool_call', {
        sessionId: 'other',
        toolCallId: 'call-2',
        toolName: 'propose_topic',
        args: {},
      });
    });
    expect(socket.emit.mock.calls).toEqual([
      [
        'tool_result',
        {
          toolCallId: 'call-1',
          sessionId: 'sess',
          result: null,
          error: 'Tool propose_topic not found: no browser tools registered',
        },
      ],
    ]);
  });

  it('a foreground socket listens for AG-UI action calls and ignores the executor echo', async () => {
    context = makeContext();
    const { result } = renderHook(() => useWebSocketEvents(baseProps));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const { socket } = sockets[0]!;
    expect(socket.handlers.has('action_call')).toBe(true);
    expect(socket.handlers.has('connected')).toBe(false);

    await act(async () => {
      await socket.fire('connect');
      await socket.fire('connected', { sessionId: 'sess' });
    });
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(result.current.connectionStatus).toBe('connected');
  });

  describe('a background socket', () => {
    const tool = (
      toolName: string,
      fn: (args: unknown) => Promise<unknown> = vi.fn(async () => undefined),
    ) => ({
      toolName,
      description: toolName,
      schema: z.object({}),
      fn,
    });
    const call = (toolName: string, toolCallId = `call-${toolName}`) => ({
      sessionId: 'sess',
      toolCallId,
      toolName,
      args: {},
    });

    it('never listens for AG-UI action calls', async () => {
      context = makeContext();
      renderHook(() =>
        useWebSocketEvents({
          ...baseProps,
          executor: 'background',
          actionTools: {
            sign_transaction: { handler: vi.fn() },
          } as unknown as IWebSocketConfig['actionTools'],
        }),
      );
      await waitFor(() => expect(sockets).toHaveLength(1));
      const { socket } = sockets[0]!;
      expect(socket.handlers.has('action_call')).toBe(false);
      await act(async () => {
        await socket.fire('action_call', {
          sessionId: 'sess',
          requestId: 'r',
          toolName: 'sign_transaction',
          toolCallId: 'a-1',
          args: {},
          status: 'isRunning',
        });
      });
      expect(socket.emit).not.toHaveBeenCalled();
    });

    it('runs declared tools once the runtime confirmed the executor, and refuses any tool its last CONNECT did not declare', async () => {
      context = makeContext();
      const vaultList = vi.fn(async () => ({ items: [] }));
      const findEntity = vi.fn(async () => ({ found: true }));
      const { rerender, result } = renderHook(
        (props: IWebSocketConfig) => useWebSocketEvents(props),
        {
          initialProps: {
            ...baseProps,
            executor: 'background',
            browserTools: { vault_list: tool('vault_list', vaultList) },
          },
        },
      );
      await waitFor(() => expect(sockets).toHaveLength(1));
      const { socket, options } = sockets[0]!;
      await authOf(options); // the CONNECT declares ['vault_list']

      // Before the runtime confirmed the executor, nothing is answered.
      await act(async () => {
        await socket.fire('browser_tool_call', call('vault_list', 'early'));
      });
      expect(vaultList).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();

      await act(async () => {
        await socket.fire('connect');
        await socket.fire('connected', {
          sessionId: 'sess',
          executor: 'background',
        });
      });
      expect(result.current.connectionStatus).toBe('connected');

      // A tool registered after the CONNECT is not declared yet.
      rerender({
        ...baseProps,
        executor: 'background',
        browserTools: {
          vault_list: tool('vault_list', vaultList),
          find_entity: tool('find_entity', findEntity),
        },
      });
      await act(async () => {
        await socket.fire('browser_tool_call', call('vault_list'));
        await socket.fire('browser_tool_call', call('find_entity'));
        await socket.fire('browser_tool_call', call('sign_transaction'));
      });
      expect(vaultList).toHaveBeenCalledTimes(1);
      expect(findEntity).not.toHaveBeenCalled();
      expect(socket.emit.mock.calls).toEqual([
        [
          'tool_result',
          {
            toolCallId: 'call-vault_list',
            sessionId: 'sess',
            result: { items: [] },
          },
        ],
        [
          'tool_result',
          {
            toolCallId: 'call-find_entity',
            sessionId: 'sess',
            result: null,
            error:
              'Tool find_entity not found: not declared by this background executor',
          },
        ],
        [
          'tool_result',
          {
            toolCallId: 'call-sign_transaction',
            sessionId: 'sess',
            result: null,
            error:
              'Tool sign_transaction not found: not declared by this background executor',
          },
        ],
      ]);

      // The next CONNECT declares it, and the confirmation is needed again.
      await act(async () => {
        await socket.fire('disconnect');
      });
      await authOf(options);
      socket.emit.mockClear();
      await act(async () => {
        await socket.fire('browser_tool_call', call('find_entity', 'early-2'));
      });
      expect(socket.emit).not.toHaveBeenCalled();
      await act(async () => {
        await socket.fire('connect');
        await socket.fire('connected', { executor: 'background' });
        await socket.fire('browser_tool_call', call('find_entity'));
      });
      expect(findEntity).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('tool_result', {
        toolCallId: 'call-find_entity',
        sessionId: 'sess',
        result: { found: true },
      });
    });

    it('closes without reconnecting when the runtime does not confirm a background executor', async () => {
      for (const payload of [
        { message: 'Connected successfully', sessionId: 'sess' },
        { sessionId: 'sess', executor: 'foreground' },
        undefined,
      ]) {
        sockets.length = 0;
        const renewOracleAuth = vi.fn<RenewOracleAuth>(async () => true);
        context = makeContext({ renewOracleAuth });
        const fn = vi.fn();
        const { result, unmount } = renderHook(() =>
          useWebSocketEvents({
            ...baseProps,
            executor: 'background',
            browserTools: { vault_list: tool('vault_list', fn) },
          }),
        );
        await waitFor(() => expect(sockets).toHaveLength(1));
        const { socket, options } = sockets[0]!;
        await authOf(options);

        await act(async () => {
          await socket.fire('connect');
          await socket.fire('connected', payload);
        });
        expect(socket.disconnect).toHaveBeenCalledTimes(1);
        expect(result.current.connectionStatus).toBe('error');
        expect(result.current.isConnected).toBe(false);
        expect(result.current.error).toMatchObject({
          code: BACKGROUND_EXECUTOR_UNSUPPORTED,
        });
        expect(result.current.error?.message).toContain(
          'does not support background executors',
        );

        // Nothing runs on it, and nothing reconnects it.
        await act(async () => {
          await socket.fire('browser_tool_call', call('vault_list'));
        });
        expect(fn).not.toHaveBeenCalled();
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.connect).not.toHaveBeenCalled();
        expect(renewOracleAuth).not.toHaveBeenCalled();
        expect(sockets).toHaveLength(1);
        unmount();
      }
    });
  });
});
