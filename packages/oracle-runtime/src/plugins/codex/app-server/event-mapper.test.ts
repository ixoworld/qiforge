import { describe, expect, it, vi } from 'vitest';
import { classifyFrame } from './protocol.js';
import {
  CodexTurnTranscript,
  emitCodexEvent,
  mapNotification,
} from './event-mapper.js';

const mockEmit = () => ({
  toolCall: vi.fn(() => {}),
  actionCall: vi.fn(() => {}),
  renderComponent: vi.fn(() => {}),
  reasoning: vi.fn(() => {}),
  browserToolCall: vi.fn(() => {}),
  router: vi.fn(() => {}),
  messageCacheInvalidation: vi.fn(() => {}),
});

describe('classifyFrame', () => {
  it('reads a response by its id without a jsonrpc version field', () => {
    expect(classifyFrame({ id: 1, result: { ok: true } })).toEqual({
      kind: 'response',
      id: 1,
      result: { ok: true },
    });
  });

  it('reads a server-initiated request as a request, not a response', () => {
    const frame = classifyFrame({ id: 7, method: 'x', params: { a: 1 } });
    expect(frame?.kind).toBe('request');
  });

  it('reads a notification as one', () => {
    const frame = classifyFrame({ method: 'turn/started', params: {} });
    expect(frame?.kind).toBe('notification');
  });

  it('preserves an error response', () => {
    const frame = classifyFrame({
      id: 2,
      error: { code: -32001, message: 'overloaded' },
    });
    expect(frame).toMatchObject({
      kind: 'response',
      error: { code: -32001, message: 'overloaded' },
    });
  });

  it('ignores junk rather than throwing', () => {
    expect(classifyFrame({ nonsense: true })).toBeNull();
    expect(classifyFrame('a string')).toBeNull();
    expect(classifyFrame(null)).toBeNull();
  });
});

describe('mapNotification', () => {
  it('maps a turn start', () => {
    expect(mapNotification('turn/started', { turn: { id: 'turn_1' } })).toEqual(
      { type: 'turn.started', turnId: 'turn_1' },
    );
  });

  it('accepts the explicit null error the server sends on success', () => {
    expect(
      mapNotification('turn/completed', {
        turn: { id: 'turn_1', status: 'completed', error: null },
      }),
    ).toEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      status: 'completed',
    });
  });

  it('preserves the failure reason on a failed turn', () => {
    expect(
      mapNotification('turn/completed', {
        turn: { id: 'turn_1', status: 'failed', error: { message: 'boom' } },
      }),
    ).toEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      status: 'failed',
      error: 'boom',
    });
  });

  it('preserves the command on a command-execution item', () => {
    expect(
      mapNotification('item/started', {
        item: { id: 'item_1', type: 'commandExecution', command: 'pnpm test' },
      }),
    ).toEqual({
      type: 'item.started',
      itemId: 'item_1',
      itemType: 'commandExecution',
      command: 'pnpm test',
    });
  });

  it('maps agent-message and reasoning deltas distinctly', () => {
    expect(
      mapNotification('item/agentMessage/delta', {
        itemId: 'i1',
        delta: 'hello',
      }),
    ).toEqual({ type: 'message.delta', itemId: 'i1', delta: 'hello' });

    expect(
      mapNotification('item/reasoning/textDelta', { delta: 'thinking' }),
    ).toEqual({ type: 'reasoning.delta', delta: 'thinking' });
  });

  it('ignores an unmodelled notification instead of throwing', () => {
    expect(mapNotification('thread/name/set', { any: 'thing' })).toBeNull();
  });

  it('ignores a malformed payload for a known method', () => {
    expect(mapNotification('turn/started', { turn: {} })).toBeNull();
  });
});

describe('emitCodexEvent', () => {
  it('routes reasoning to the reasoning channel', () => {
    const emit = mockEmit();
    emitCodexEvent(
      { type: 'reasoning.delta', delta: 'why' },
      { emit },
      'thr_1',
    );
    expect(emit.reasoning).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        threadId: 'thr_1',
        text: 'why',
      }),
    );
  });

  it('routes item lifecycle to the tool-call channel with its status', () => {
    const emit = mockEmit();
    emitCodexEvent(
      {
        type: 'item.started',
        itemId: 'i1',
        itemType: 'commandExecution',
        command: 'ls',
      },
      { emit },
      'thr_1',
    );
    expect(emit.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'codex.commandExecution',
        status: 'started',
        command: 'ls',
      }),
    );
  });

  it('routes turn lifecycle to the router channel', () => {
    const emit = mockEmit();
    emitCodexEvent(
      { type: 'turn.completed', turnId: 't1', status: 'interrupted' },
      { emit },
      'thr_1',
    );
    expect(emit.router).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'completed', status: 'interrupted' }),
    );
  });
});

describe('CodexTurnTranscript', () => {
  it('prefers the completed item text over accumulated deltas', () => {
    const transcript = new CodexTurnTranscript();
    transcript.record({ type: 'message.delta', delta: 'par' });
    transcript.record({ type: 'message.delta', delta: 'tial' });
    transcript.record({
      type: 'item.completed',
      itemId: 'i1',
      itemType: 'agentMessage',
      text: 'the final answer',
    });

    expect(transcript.text()).toBe('the final answer');
  });

  it('falls back to deltas when no terminal item arrives', () => {
    const transcript = new CodexTurnTranscript();
    transcript.record({ type: 'message.delta', delta: 'strea' });
    transcript.record({ type: 'message.delta', delta: 'med' });

    expect(transcript.text()).toBe('streamed');
  });

  it('ignores non-message items', () => {
    const transcript = new CodexTurnTranscript();
    transcript.record({
      type: 'item.completed',
      itemId: 'i1',
      itemType: 'commandExecution',
      text: 'exit 0',
    });

    expect(transcript.text()).toBe('');
  });
});
