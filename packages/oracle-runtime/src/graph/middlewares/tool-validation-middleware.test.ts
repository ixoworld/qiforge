import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createToolValidationMiddleware } from './tool-validation-middleware.js';

// Minimal ToolCallRequest shape — `wrapToolCall` only reads `toolCall` and
// (optionally) `tool.name`. We construct the object loosely because the
// middleware's hook is invoked directly by the test (not by the runtime).
type FakeRequest = {
  toolCall: ToolCall;
  tool?: { name?: string };
  state: { messages: BaseMessage[] };
  runtime: Record<string, unknown>;
};

function makeRequest(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    toolCall: { name: 'demo', args: { foo: 'bar' }, id: 'tc-1' },
    tool: { name: 'demo' },
    state: { messages: [] },
    runtime: {},
    ...overrides,
  };
}

describe('createToolValidationMiddleware', () => {
  it('passes through successful handler results untouched', async () => {
    const mw = createToolValidationMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi
      .fn()
      .mockResolvedValue(
        new ToolMessage({ content: 'ok', tool_call_id: 'tc-1' }),
      );

    const result = await wrap(makeRequest() as never, handler as never);
    expect(handler).toHaveBeenCalledOnce();
    expect((result as ToolMessage).content).toBe('ok');
  });

  it('catches "did not match expected schema" errors and returns a corrective ToolMessage', async () => {
    const mw = createToolValidationMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi
      .fn()
      .mockRejectedValue(
        new Error('Received tool input did not match expected schema'),
      );
    const req = makeRequest({
      toolCall: { name: 'broken', args: {}, id: 'tc-2' },
      tool: { name: 'broken' },
    });

    const result = await wrap(req as never, handler as never);
    expect(result).toBeInstanceOf(ToolMessage);
    const tm = result as ToolMessage;
    expect(tm.tool_call_id).toBe('tc-2');
    expect(String(tm.content)).toContain('broken');
    expect(String(tm.content)).toContain('invalid parameters');
  });

  it('catches ZodErrors as schema errors', async () => {
    const mw = createToolValidationMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    // Real ZodError so we exercise the `error.name === 'ZodError'` branch.
    const failingSchema = z.object({ a: z.string() });
    const handler = vi.fn().mockImplementation(() => {
      failingSchema.parse({ a: 123 });
    });

    const result = await wrap(makeRequest() as never, handler as never);
    expect(result).toBeInstanceOf(ToolMessage);
  });

  it('rethrows non-schema errors', async () => {
    const mw = createToolValidationMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const handler = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      wrap(makeRequest() as never, handler as never),
    ).rejects.toThrow('network down');
  });

  it('beforeModel: skips listed tool names by stripping ToolMessages', () => {
    const mw = createToolValidationMiddleware({
      skipToolNames: ['edit_block'],
    });
    const before = mw.beforeModel;
    if (typeof before !== 'function') throw new Error('beforeModel missing');

    const messages: BaseMessage[] = [
      new ToolMessage({
        content: 'noisy',
        tool_call_id: 'tc-1',
        name: 'edit_block',
      }),
    ];

    const result = before({ messages } as never, undefined as never);
    expect((result as { messages: BaseMessage[] }).messages).toHaveLength(0);
  });

  it('beforeModel: returns state unchanged when skipToolNames is empty', () => {
    const mw = createToolValidationMiddleware();
    const before = mw.beforeModel;
    if (typeof before !== 'function') throw new Error('beforeModel missing');

    const messages: BaseMessage[] = [
      new ToolMessage({
        content: 'keep',
        tool_call_id: 'tc-1',
        name: 'something',
      }),
    ];
    const state = { messages };
    const result = before(state as never, undefined as never);
    expect(result).toBe(state);
  });
});
