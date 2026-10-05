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
import {
  FRONTEND_OUTCOME_UNKNOWN,
  FRONTEND_OUTCOME_UNKNOWN_MESSAGE,
} from '../frontend-bridge/index.js';
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
    const invoke = (onInvocation?: (id: string) => void) =>
      callFrontendTool({
        sessionId: 'session-a',
        toolId: 'turn-one',
        toolName: 'edit',
        args: {},
        toolType,
        onInvocation,
      });
    /** How a call settled, so one assertion covers both call kinds. */
    const settled = (outcome: Promise<unknown>) =>
      outcome.then(
        (value) => ({ status: 'resolved', value }),
        (error: unknown) => ({
          status: 'rejected',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    /**
     * An explicit refusal rejects an AG-UI call and resolves a browser-tool
     * call with the refused result (the ordinary behaviour of each kind).
     */
    const explicitRefusal =
      toolType === 'agui'
        ? { status: 'rejected', message: 'Permission denied' }
        : {
            status: 'resolved',
            value: { success: false, error: 'Permission denied' },
          };

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

    it('ignores results from a different session and gives every invocation its own id', async () => {
      const reported: string[] = [];
      const first = invoke((id) => reported.push(id));
      const second = invoke((id) => reported.push(id));
      const [a, b] = transport.send.mock.calls.map(
        ([payload]) => payload as { toolCallId: string; requestId: string },
      );
      expect(a!.toolCallId).not.toBe(b!.toolCallId);
      expect(a!.toolCallId.startsWith('turn-one:')).toBe(true);
      expect(a!.requestId).toBe('turn-one');
      expect(reported).toEqual([a!.toolCallId, b!.toolCallId]);
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      rootEventEmitter.emit(event, {
        sessionId: 'session-b',
        toolCallId: a!.toolCallId,
        result: 'wrong',
      });
      // A turn-level id alone no longer matches an invocation.
      rootEventEmitter.emit(event, {
        sessionId: 'session-a',
        toolCallId: 'turn-one',
        result: 'stale',
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      rootEventEmitter.emit(event, {
        sessionId: 'session-a',
        toolCallId: a!.toolCallId,
        result: 'first',
      });
      rootEventEmitter.emit(event, {
        sessionId: 'session-a',
        toolCallId: b!.toolCallId,
        result: 'second',
      });
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');
    });

    it('reports an unknown outcome when the transport deadline expires', async () => {
      vi.useFakeTimers();
      let invocationId = '';
      const result = invoke((id) => {
        invocationId = id;
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).resolves.toEqual({
        success: false,
        code: FRONTEND_OUTCOME_UNKNOWN,
        outcome: 'unknown',
        invocationId,
        message: FRONTEND_OUTCOME_UNKNOWN_MESSAGE,
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
      await expect(settled(invoke())).resolves.toEqual(explicitRefusal);
    });

    it('returns a client-reported unknown outcome instead of rejecting it', async () => {
      const unknown = { success: false, outcome: 'unknown', commandId: 'c' };
      transport.send.mockImplementation(
        ({ toolCallId }: { toolCallId: string }) => {
          rootEventEmitter.emit(event, {
            sessionId: 'session-a',
            toolCallId,
            result: unknown,
          });
        },
      );
      await expect(invoke()).resolves.toEqual(unknown);
    });

    it('rejects and stops listening when the dispatch itself throws', async () => {
      transport.send.mockImplementation(() => {
        throw new Error('emitter down');
      });
      await expect(invoke()).rejects.toThrow('emitter down');
      expect(rootEventEmitter.listenerCount(event)).toBe(0);
    });
  },
);
