// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const state = vi.hoisted(() => ({
  sockets: [] as Array<{
    listeners: Map<string, (data: unknown) => unknown>;
    connected: boolean;
    disconnect: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    onAny: ReturnType<typeof vi.fn>;
    on(event: string, listener: (data: unknown) => unknown): void;
  }>,
  execute: vi.fn(async () => undefined),
  action: vi.fn(async () => undefined),
  wallet: {
    did: 'did:ixo:alice',
    address: 'alice',
    matrix: { accessToken: 'test-token' },
  },
  delegation: vi.fn(async () => 'test-delegation'),
  invocation: vi.fn(async () => 'test-invocation'),
}));
vi.mock('socket.io-client', () => ({
  io: () => {
    const listeners = new Map<string, (data: unknown) => unknown>();
    const socket = {
      listeners,
      connected: false,
      disconnect: vi.fn(),
      emit: vi.fn(),
      onAny: vi.fn(),
      on(event: string, listener: (data: unknown) => unknown) {
        listeners.set(event, listener);
      },
    };
    state.sockets.push(socket);
    return socket;
  },
}));
vi.mock('../../providers/oracles-provider/oracles-context.js', () => ({
  useOraclesContext: () => ({
    wallet: state.wallet,
    getDelegation: state.delegation,
    getInvocation: state.invocation,
  }),
}));
vi.mock('../use-oracles-config.js', () => ({
  useOraclesConfig: () => ({
    isReady: true,
    config: { socketUrl: 'http://local.test' },
  }),
}));
vi.mock('./tool-executor.js', () => ({
  executeBrowserToolCall: state.execute,
  executeToolAndEmitResult: state.action,
}));
import { useWebSocketEvents } from './use-websocket-events.js';
import type { IBrowserTools } from '../../types/browser-tool.type.js';

afterEach(() => {
  state.sockets.length = 0;
  vi.clearAllMocks();
});
const tools: IBrowserTools = {
  read_topic: {
    toolName: 'read_topic',
    description: 'Read',
    schema: z.object({}),
    fn: async () => ({}),
  },
};
const props = { oracleDid: 'did:ixo:oracle', handleNewEvent: vi.fn() };

describe('scoped frontend listeners', () => {
  it('registers tools that arrive after the socket connects without reconnecting', async () => {
    const hook = renderHook(
      ({ browserTools }: { browserTools: IBrowserTools | undefined }) =>
        useWebSocketEvents({ ...props, sessionId: 'topic-one', browserTools }),
      { initialProps: { browserTools: undefined } },
    );
    await waitFor(() => expect(state.sockets).toHaveLength(1));
    hook.rerender({ browserTools: tools });
    await act(async () => {
      await state.sockets[0].listeners.get('browser_tool_call')?.({
        sessionId: 'topic-one',
        toolCallId: 'call',
        toolName: 'read_topic',
        args: {},
      });
    });
    expect(state.execute).toHaveBeenCalledWith(
      state.sockets[0],
      tools,
      expect.objectContaining({ sessionId: 'topic-one' }),
    );
    expect(state.sockets).toHaveLength(1);
    hook.unmount();
  });

  it('rejects another Topic session and late calls after switching sessions', async () => {
    const hook = renderHook(
      ({ sessionId }) =>
        useWebSocketEvents({ ...props, sessionId, browserTools: tools }),
      { initialProps: { sessionId: 'topic-one' } },
    );
    await waitFor(() => expect(state.sockets).toHaveLength(1));
    const original = state.sockets[0];
    await act(async () => {
      await original.listeners.get('browser_tool_call')?.({
        sessionId: 'topic-two',
        toolCallId: 'wrong',
        toolName: 'read_topic',
        args: {},
      });
    });
    hook.rerender({ sessionId: 'topic-two' });
    await waitFor(() => expect(state.sockets).toHaveLength(2));
    await act(async () => {
      await original.listeners.get('browser_tool_call')?.({
        sessionId: 'topic-one',
        toolCallId: 'late',
        toolName: 'read_topic',
        args: {},
      });
    });
    expect(original.disconnect).toHaveBeenCalledOnce();
    expect(state.execute).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('rejects AG-UI calls from a different session and completed event replays', async () => {
    const hook = renderHook(() =>
      useWebSocketEvents({ ...props, sessionId: 'home', actionTools: {} }),
    );
    await waitFor(() => expect(state.sockets).toHaveLength(1));
    await act(async () => {
      await state.sockets[0].listeners.get('action_call')?.({
        sessionId: 'other',
        status: 'isRunning',
        toolName: 'action',
        toolCallId: 'wrong',
        args: {},
      });
      await state.sockets[0].listeners.get('action_call')?.({
        sessionId: 'home',
        status: 'completed',
        toolName: 'action',
        toolCallId: 'old',
        args: {},
      });
    });
    expect(state.action).not.toHaveBeenCalled();
    expect(state.sockets[0].emit).not.toHaveBeenCalled();
    hook.unmount();
  });
});
