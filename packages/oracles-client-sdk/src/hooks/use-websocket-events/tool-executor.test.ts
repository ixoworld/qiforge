import { describe, expect, it, vi } from 'vitest';

import { executeBrowserToolCall } from './tool-executor.js';

describe('executeBrowserToolCall', () => {
  it('emits a browser tool result with the originating session ID', async () => {
    const socket = { emit: vi.fn() };
    const result = { success: true, draftId: 'draft-1' };

    await executeBrowserToolCall(
      socket,
      {
        propose_topic: {
          fn: async () => result,
        },
      },
      {
        sessionId: 'session-123',
        toolCallId: 'tool-123',
        toolName: 'propose_topic',
        args: { title: 'Support request' },
      },
    );

    expect(socket.emit).toHaveBeenCalledWith('tool_result', {
      toolCallId: 'tool-123',
      sessionId: 'session-123',
      result,
    });
  });

  it('keeps the originating session ID when a browser tool cannot run', async () => {
    const socket = { emit: vi.fn() };

    await executeBrowserToolCall(
      socket,
      {},
      {
        sessionId: 'session-456',
        toolCallId: 'tool-456',
        toolName: 'missing_tool',
        args: {},
      },
    );

    expect(socket.emit).toHaveBeenCalledWith('tool_result', {
      toolCallId: 'tool-456',
      sessionId: 'session-456',
      result: null,
      error: 'Tool missing_tool not found',
    });
  });
});
