import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  createDanglingToolCallRepairMiddleware,
  interruptedToolResult,
  repairDanglingToolCalls,
} from './dangling-tool-calls';

const call = (id: string, name = 'sandbox_run') => ({
  id,
  name,
  args: { code: 'print(1)' },
  type: 'tool_call' as const,
});

describe('repairDanglingToolCalls', () => {
  it('leaves a fully answered history untouched (same array)', () => {
    const messages = [
      new HumanMessage('run it'),
      new AIMessage({ content: '', tool_calls: [call('a')] }),
      new ToolMessage({ tool_call_id: 'a', name: 'sandbox_run', content: '1' }),
      new AIMessage('done'),
    ];
    const result = repairDanglingToolCalls(messages);
    expect(result.repaired).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('answers a trailing unanswered call before the next human message', () => {
    const messages = [
      new HumanMessage('run it'),
      new AIMessage({ content: '', tool_calls: [call('a')] }),
      new HumanMessage('are you there?'),
    ];
    const { messages: repaired, repaired: count } =
      repairDanglingToolCalls(messages);
    expect(count).toBe(1);
    expect(repaired.map((m) => m.type)).toEqual([
      'human',
      'ai',
      'tool',
      'human',
    ]);
    const synthetic = repaired[2] as ToolMessage;
    expect(synthetic.tool_call_id).toBe('a');
    expect(synthetic.name).toBe('sandbox_run');
    expect(synthetic.status).toBe('error');
    expect(synthetic.content).toBe(interruptedToolResult('sandbox_run'));
  });

  it('answers only the missing call of a partially answered batch, after the real results', () => {
    const messages = [
      new AIMessage({
        content: '',
        tool_calls: [call('a'), call('b', 'vfs_read')],
      }),
      new ToolMessage({ tool_call_id: 'a', name: 'sandbox_run', content: '1' }),
      new HumanMessage('next'),
    ];
    const { messages: repaired, repaired: count } =
      repairDanglingToolCalls(messages);
    expect(count).toBe(1);
    expect(repaired.map((m) => m.type)).toEqual([
      'ai',
      'tool',
      'tool',
      'human',
    ]);
    expect((repaired[1] as ToolMessage).tool_call_id).toBe('a');
    expect((repaired[2] as ToolMessage).tool_call_id).toBe('b');
    expect((repaired[2] as ToolMessage).name).toBe('vfs_read');
  });

  it('repairs a dangling call in the middle of a longer thread', () => {
    const messages = [
      new HumanMessage('one'),
      new AIMessage({ content: '', tool_calls: [call('a')] }),
      new HumanMessage('two'),
      new AIMessage({ content: '', tool_calls: [call('b')] }),
      new ToolMessage({ tool_call_id: 'b', name: 'sandbox_run', content: '2' }),
      new AIMessage('2'),
    ];
    const { messages: repaired, repaired: count } =
      repairDanglingToolCalls(messages);
    expect(count).toBe(1);
    expect(repaired.map((m) => m.type)).toEqual([
      'human',
      'ai',
      'tool',
      'human',
      'ai',
      'tool',
      'ai',
    ]);
    expect((repaired[2] as ToolMessage).tool_call_id).toBe('a');
  });

  it('ignores tool calls without an id (nothing to answer)', () => {
    const messages = [
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'x', args: {}, type: 'tool_call' as const }],
      }),
    ];
    expect(repairDanglingToolCalls(messages).repaired).toBe(0);
  });
});

describe('createDanglingToolCallRepairMiddleware', () => {
  function setup(messages: Array<AIMessage | HumanMessage | ToolMessage>) {
    const warn = vi.fn();
    const mw = createDanglingToolCallRepairMiddleware({
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });
    const wrap = mw.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');
    const handler = vi.fn().mockResolvedValue({ ok: true });
    return {
      warn,
      handler,
      invoke: () =>
        wrap({ messages, runtime: { context: {} } } as never, handler as never),
    };
  }

  it('passes an intact request through by reference', async () => {
    const messages = [new HumanMessage('hi'), new AIMessage('hello')];
    const { handler, invoke, warn } = setup(messages);
    await invoke();
    expect(handler.mock.calls[0]?.[0].messages).toBe(messages);
    expect(warn).not.toHaveBeenCalled();
  });

  it('hands the model a repaired history and warns once', async () => {
    const { handler, invoke, warn } = setup([
      new HumanMessage('run it'),
      new AIMessage({ content: '', tool_calls: [call('a')] }),
      new HumanMessage('OK?'),
    ]);
    await invoke();
    const sent = handler.mock.calls[0]?.[0].messages as ToolMessage[];
    expect(sent.map((m) => m.type)).toEqual(['human', 'ai', 'tool', 'human']);
    expect(warn).toHaveBeenCalledOnce();
  });
});
