import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { describe, expect, it, vi } from 'vitest';
import { createToolRepetitionGuardMiddleware } from './tool-repetition-guard-middleware.js';

type FakeRequest = {
  toolCall: ToolCall;
  tool?: { name?: string };
  state: { messages: BaseMessage[] };
  runtime: Record<string, unknown>;
};

function makeRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    toolCall: {
      name: 'sandbox_write_file',
      args: { path: '/workspace/tmp/x.js', content: 'x' },
      id: 'tc-current',
    },
    tool: { name: 'sandbox_write_file' },
    state: { messages: [] },
    runtime: {},
    ...overrides,
  };
}

function makePriorFailedCall(
  args: Record<string, unknown>,
  opts: {
    toolName?: string;
    toolCallId?: string;
    errorText?: string;
  } = {},
): BaseMessage[] {
  const toolName = opts.toolName ?? 'sandbox_write_file';
  const callId = opts.toolCallId ?? 'tc-prior';
  return [
    new AIMessage({
      content: '',
      tool_calls: [{ name: toolName, args, id: callId, type: 'tool_call' }],
    }),
    new ToolMessage({
      content: opts.errorText ?? 'Path must be under /workspace/data/.',
      tool_call_id: callId,
      name: toolName,
      status: 'error',
    }),
  ];
}

describe('createToolRepetitionGuardMiddleware', () => {
  it('passes through when there is no prior matching call', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi
      .fn()
      .mockResolvedValue(
        new ToolMessage({ content: 'ok', tool_call_id: 'tc-current' }),
      );

    const result = await wrap(makeRequest() as never, handler as never);
    expect(handler).toHaveBeenCalledOnce();
    expect((result as ToolMessage).content).toBe('ok');
  });

  it('short-circuits when the exact (toolName, args) already failed', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi.fn();
    const req = makeRequest({
      state: {
        messages: [
          new HumanMessage('Write a temp file please'),
          ...makePriorFailedCall(
            { path: '/workspace/tmp/x.js', content: 'x' },
            { errorText: 'Path must be under /workspace/data/.' },
          ),
        ],
      },
    });

    const result = await wrap(req as never, handler as never);
    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(ToolMessage);
    const tm = result as ToolMessage;
    expect(tm.status).toBe('error');
    expect(String(tm.content)).toContain('You already called');
    expect(String(tm.content)).toContain('Path must be under /workspace/data/');
  });

  it('treats args as canonical (key order does not matter)', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi.fn();
    const req = makeRequest({
      toolCall: {
        name: 'sandbox_write_file',
        // Same logical args, different key order.
        args: { content: 'x', path: '/workspace/tmp/x.js' },
        id: 'tc-current',
      },
      state: {
        messages: makePriorFailedCall({
          path: '/workspace/tmp/x.js',
          content: 'x',
        }),
      },
    });

    const result = await wrap(req as never, handler as never);
    expect(handler).not.toHaveBeenCalled();
    expect((result as ToolMessage).status).toBe('error');
  });

  it('does not short-circuit if args differ', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi
      .fn()
      .mockResolvedValue(
        new ToolMessage({ content: 'ok', tool_call_id: 'tc-current' }),
      );
    const req = makeRequest({
      toolCall: {
        name: 'sandbox_write_file',
        args: { path: '/workspace/data/x.js', content: 'x' },
        id: 'tc-current',
      },
      state: {
        messages: makePriorFailedCall({
          path: '/workspace/tmp/x.js',
          content: 'x',
        }),
      },
    });

    const result = await wrap(req as never, handler as never);
    expect(handler).toHaveBeenCalledOnce();
    expect((result as ToolMessage).content).toBe('ok');
  });

  it('does not short-circuit if the prior call belonged to a different tool', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi
      .fn()
      .mockResolvedValue(
        new ToolMessage({ content: 'ok', tool_call_id: 'tc-current' }),
      );
    const req = makeRequest({
      state: {
        messages: makePriorFailedCall(
          { path: '/workspace/tmp/x.js', content: 'x' },
          { toolName: 'other_tool', toolCallId: 'tc-prior-other' },
        ),
      },
    });

    const result = await wrap(req as never, handler as never);
    expect(handler).toHaveBeenCalledOnce();
    expect((result as ToolMessage).content).toBe('ok');
  });

  it('does not short-circuit if the prior call succeeded', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi
      .fn()
      .mockResolvedValue(
        new ToolMessage({ content: 'ok', tool_call_id: 'tc-current' }),
      );
    const req = makeRequest({
      state: {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [
              {
                name: 'sandbox_write_file',
                args: { path: '/workspace/tmp/x.js', content: 'x' },
                id: 'tc-prior',
                type: 'tool_call',
              },
            ],
          }),
          // Same args, but the prior call returned success — should not block.
          new ToolMessage({
            content: 'wrote ok',
            tool_call_id: 'tc-prior',
            name: 'sandbox_write_file',
            status: 'success',
          }),
        ],
      },
    });

    const result = await wrap(req as never, handler as never);
    expect(handler).toHaveBeenCalledOnce();
    expect((result as ToolMessage).content).toBe('ok');
  });

  it('honours the lookback window — older failures outside the window are ignored', async () => {
    const mw = createToolRepetitionGuardMiddleware({ lookback: 2 });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi
      .fn()
      .mockResolvedValue(
        new ToolMessage({ content: 'ok', tool_call_id: 'tc-current' }),
      );

    // Failed call older than 2 messages back; should be outside the window.
    const req = makeRequest({
      state: {
        messages: [
          ...makePriorFailedCall({
            path: '/workspace/tmp/x.js',
            content: 'x',
          }),
          new HumanMessage('Filler 1'),
          new HumanMessage('Filler 2'),
          new HumanMessage('Filler 3'),
        ],
      },
    });

    const result = await wrap(req as never, handler as never);
    expect(handler).toHaveBeenCalledOnce();
    expect((result as ToolMessage).content).toBe('ok');
  });
});
