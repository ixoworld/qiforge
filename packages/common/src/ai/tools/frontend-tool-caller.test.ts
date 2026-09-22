import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@ixo/oracles-events', async () => ({
  rootEventEmitter: new (await import('node:events')).EventEmitter(),
  BrowserToolCallEvent: class {
    constructor(private payload: unknown) {}
    emit() {
      transport.send(this.payload);
    }
  },
  ActionCallEvent: class {
    constructor(private payload: unknown) {}
    emit() {
      transport.send(this.payload);
    }
  },
}));
import { rootEventEmitter } from '@ixo/oracles-events';
import { callFrontendTool } from './frontend-tool-caller.js';

afterEach(() => {
  vi.useRealTimers();
  transport.send.mockReset();
  rootEventEmitter.removeAllListeners();
});

describe.each(['browser', 'agui'] as const)(
  '%s invocation correlation',
  (toolType) => {
    const event =
      toolType === 'browser' ? 'browser_tool_result' : 'action_call_result';
    const invoke = () =>
      callFrontendTool({
        sessionId: 'session-a',
        toolId: 'turn-one',
        toolName: 'edit',
        args: {},
        toolType,
      });

    it('listens before dispatch and accepts an immediate result', async () => {
      transport.send.mockImplementation(
        ({ toolCallId }: { toolCallId: string }) => {
          rootEventEmitter.emit(event, {
            sessionId: 'session-a',
            toolCallId,
            result: 'saved',
          });
        },
      );
      await expect(invoke()).resolves.toBe('saved');
    });

    it('ignores results from a different session and gives every invocation its own ID', async () => {
      const first = invoke();
      const second = invoke();
      const [a, b] = transport.send.mock.calls.map(
        ([payload]) => payload as { toolCallId: string },
      );
      expect(a.toolCallId).not.toBe(b.toolCallId);
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      rootEventEmitter.emit(event, {
        sessionId: 'session-b',
        toolCallId: a.toolCallId,
        result: 'wrong',
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      rootEventEmitter.emit(event, {
        sessionId: 'session-a',
        toolCallId: a.toolCallId,
        result: 'first',
      });
      rootEventEmitter.emit(event, {
        sessionId: 'session-a',
        toolCallId: b.toolCallId,
        result: 'second',
      });
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');
    });

    it('reports an unknown outcome when the transport deadline expires', async () => {
      vi.useFakeTimers();
      const result = invoke();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).resolves.toMatchObject({
        code: 'FRONTEND_OUTCOME_UNKNOWN',
        outcome: 'unknown',
      });
      expect(rootEventEmitter.listenerCount(event)).toBe(0);
    });

    it('preserves the existing explicit-failure contract for ordinary tools', async () => {
      transport.send.mockImplementation(
        ({ toolCallId }: { toolCallId: string }) => {
          rootEventEmitter.emit(event, {
            sessionId: 'session-a',
            toolCallId,
            result: { success: false, error: 'Permission denied' },
          });
        },
      );
      if (toolType === 'agui')
        await expect(invoke()).rejects.toThrow('Permission denied');
      else
        await expect(invoke()).resolves.toEqual({
          success: false,
          error: 'Permission denied',
        });
    });
  },
);
