import { callBrowserTool } from '@ixo/common';
import {
  BrowserToolCallEvent,
  GraphEventEmitter,
  rootEventEmitter,
} from '@ixo/oracles-events';
import { Server } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import { FrontendInvocations } from './frontend-invocations.js';

describe('active frontend bridge', () => {
  it('routes a real call through the single-executor bridge and settles its correlated response', async () => {
    const server = new Server();
    const router = new FrontendInvocations();
    const foreground = {
      id: 'one',
      connected: true,
      data: { sessionId: 'session', userDid: 'did:ixo:alice' },
      emit: vi.fn((kind: string, value: unknown) => {
        if (
          !value ||
          typeof value !== 'object' ||
          !('toolCallId' in value) ||
          typeof value.toolCallId !== 'string'
        )
          throw new Error('Invalid call');
        if (
          router.accept(
            'browser_tool_result',
            foreground,
            'session',
            value.toolCallId,
          )
        )
          rootEventEmitter.emit('browser_tool_result', {
            sessionId: 'session',
            toolCallId: value.toolCallId,
            result: { commandId: 'original-command', status: 'completed' },
          });
      }),
    };
    const background = { ...foreground, id: 'two', emit: vi.fn() };
    const detach = GraphEventEmitter.registerEventHandlers(
      server,
      (kind, data) => {
        router.dispatch(kind, data, [foreground, background]);
      },
    );
    try {
      let invocationId: string | undefined;
      await expect(
        callBrowserTool({
          sessionId: 'session',
          toolCallId: 'turn',
          toolName: 'mutate_topic',
          args: {},
          onInvocation: (id) => {
            invocationId = id;
          },
        }),
      ).resolves.toEqual({
        commandId: 'original-command',
        status: 'completed',
      });
      expect(background.emit).not.toHaveBeenCalled();
      expect(foreground.emit).toHaveBeenCalledExactlyOnceWith(
        BrowserToolCallEvent.eventName,
        expect.objectContaining({ toolCallId: invocationId }),
      );
    } finally {
      detach();
    }
  });
});
