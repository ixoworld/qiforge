import { describe, expect, it, vi } from 'vitest';
import type { EmitAdapter } from '../runtime-context/ambient.js';
import { createScopedEmitter, EVENT_NAMES } from './scoped-emitter.js';

describe('createScopedEmitter', () => {
  it('maps every emitter method to the canonical @ixo/oracles-events name', () => {
    const sink: EmitAdapter = { emit: vi.fn() };
    const emit = createScopedEmitter(
      { sessionId: 's-1', requestId: 'r-1' },
      sink,
    );

    emit.toolCall({ toolName: 'foo' });
    emit.actionCall({ toolCallId: 'c', toolName: 'a' });
    emit.renderComponent({ componentName: 'X' });
    emit.reasoning({ reasoning: 'why' });
    emit.browserToolCall({ toolCallId: 'c', toolName: 'b', args: {} });
    emit.router({ step: 'plan' });
    emit.messageCacheInvalidation({ status: 'done' });

    const calls = (sink.emit as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      'tool_call',
      'action_call',
      'render_component',
      'reasoning',
      'browser_tool_call',
      'router.update',
      'message_cache_invalidation',
    ]);
  });

  it('always sets sessionId and requestId on the emitted payload', () => {
    const sink: EmitAdapter = { emit: vi.fn() };
    const emit = createScopedEmitter(
      { sessionId: 'abc', requestId: 'xyz' },
      sink,
    );

    emit.toolCall({ toolName: 'foo', args: { x: 1 } });

    expect(sink.emit).toHaveBeenCalledWith(EVENT_NAMES.toolCall, {
      toolName: 'foo',
      args: { x: 1 },
      sessionId: 'abc',
      requestId: 'xyz',
    });
  });

  it('exposes the canonical event name table', () => {
    expect(EVENT_NAMES).toEqual({
      toolCall: 'tool_call',
      actionCall: 'action_call',
      renderComponent: 'render_component',
      reasoning: 'reasoning',
      browserToolCall: 'browser_tool_call',
      router: 'router.update',
      messageCacheInvalidation: 'message_cache_invalidation',
    });
  });
});
