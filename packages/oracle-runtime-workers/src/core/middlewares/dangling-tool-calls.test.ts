import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import {
  createDanglingToolCallRepairMiddleware,
  interruptedToolResult,
  repairDanglingToolCalls,
  withoutForwarded,
} from './dangling-tool-calls';
import { FORWARDED_FROM_KEY } from '../subagent-as-tool';

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

  /** What a sub-agent with `forwardTools` hands back: its forwarded pair, then the parent call's result. */
  const forwarded = (parent: string, result: string) => [
    new AIMessage({
      content: '',
      tool_calls: [call(`${parent}_inner`, 'submit_section')],
    }),
    new ToolMessage({
      tool_call_id: `${parent}_inner`,
      name: 'submit_section',
      content: '{"submitted":"role","stage":"evaluate"}',
    }),
    new ToolMessage({ tool_call_id: parent, content: result }),
  ];

  it("moves a forwarding sub-agent's result up to its call instead of calling it interrupted", () => {
    const messages = [
      new HumanMessage('evaluate'),
      new AIMessage({
        content: '',
        tool_calls: [call('p', 'call_risk_agent')],
      }),
      ...forwarded('p', 'PASS'),
      new AIMessage('done'),
    ];
    const result = repairDanglingToolCalls(messages);
    expect(result.repaired).toBe(0);
    expect(result.regrouped).toBe(1);
    expect(
      result.messages.map((m) =>
        ToolMessage.isInstance(m) ? `tool:${m.tool_call_id}` : m.type,
      ),
    ).toEqual(['human', 'ai', 'tool:p', 'ai', 'tool:p_inner', 'ai']);
    expect(result.messages[2]?.content).toBe('PASS');
    // Nothing interrupted is said about a call that returned.
    expect(JSON.stringify(result.messages)).not.toContain('interrupted');
  });

  it('regroups every result of parallel forwarding calls, each after its own call', () => {
    const messages = [
      new HumanMessage('evaluate all'),
      new AIMessage({
        content: '',
        tool_calls: [call('x', 'call_a_agent'), call('y', 'call_b_agent')],
      }),
      ...forwarded('x', 'A done'),
      ...forwarded('y', 'B done'),
      new AIMessage('both done'),
    ];
    const result = repairDanglingToolCalls(messages);
    expect(result).toMatchObject({ repaired: 0, regrouped: 2 });
    expect(
      result.messages.map((m) =>
        ToolMessage.isInstance(m) ? `tool:${m.tool_call_id}` : m.type,
      ),
    ).toEqual([
      'human',
      'ai',
      'tool:x',
      'tool:y',
      'ai',
      'tool:x_inner',
      'ai',
      'tool:y_inner',
      'ai',
    ]);
  });

  it('never takes a result from a later turn: that call is still interrupted', () => {
    const messages = [
      new HumanMessage('run it'),
      new AIMessage({ content: '', tool_calls: [call('a')] }),
      new HumanMessage('again'),
      new AIMessage({ content: '', tool_calls: [call('a')] }),
      new ToolMessage({ tool_call_id: 'a', name: 'sandbox_run', content: '1' }),
    ];
    const result = repairDanglingToolCalls(messages);
    expect(result).toMatchObject({ repaired: 1, regrouped: 0 });
    expect((result.messages[2] as ToolMessage).content).toBe(
      interruptedToolResult('sandbox_run'),
    );
    expect((result.messages[5] as ToolMessage).content).toBe('1');
  });
});

describe('withoutForwarded', () => {
  it('leaves out the messages a sub-agent forwarded, and only those', () => {
    const kept = [
      new HumanMessage('evaluate'),
      new AIMessage({ content: '', tool_calls: [call('p', 'call_x_agent')] }),
      new ToolMessage({ tool_call_id: 'p', content: 'recorded' }),
    ];
    const marked = { [FORWARDED_FROM_KEY]: 'p' };
    const messages = [
      kept[0]!,
      kept[1]!,
      new AIMessage({
        content: '',
        tool_calls: [call('p_inner', 'submit_section')],
        additional_kwargs: marked,
      }),
      new ToolMessage({
        tool_call_id: 'p_inner',
        content: 'ok',
        additional_kwargs: marked,
      }),
      kept[2]!,
    ];
    expect(withoutForwarded(messages)).toEqual(kept);
    // Nothing forwarded: the same array.
    expect(withoutForwarded(kept)).toBe(kept);
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

  it("hands the model the parent call and its result, not a sub-agent's forwarded messages", async () => {
    const marked = { [FORWARDED_FROM_KEY]: 'p' };
    const { handler, invoke, warn } = setup([
      new HumanMessage('evaluate'),
      new AIMessage({ content: '', tool_calls: [call('p', 'call_x_agent')] }),
      new AIMessage({
        content: '',
        tool_calls: [call('p_inner', 'submit_section')],
        additional_kwargs: marked,
      }),
      new ToolMessage({
        tool_call_id: 'p_inner',
        content: 'ok',
        additional_kwargs: marked,
      }),
      new ToolMessage({ tool_call_id: 'p', content: 'done' }),
    ]);
    await invoke();
    const sent = handler.mock.calls[0]?.[0].messages as ToolMessage[];
    expect(sent.map((m) => m.type)).toEqual(['human', 'ai', 'tool']);
    expect(sent[2]?.content).toBe('done');
    expect(warn).not.toHaveBeenCalled();
  });

  it('regroups a forwarded result without a warning (nothing was interrupted)', async () => {
    const { handler, invoke, warn } = setup([
      new HumanMessage('evaluate'),
      new AIMessage({ content: '', tool_calls: [call('p', 'call_x_agent')] }),
      new AIMessage({ content: '', tool_calls: [call('p_inner')] }),
      new ToolMessage({ tool_call_id: 'p_inner', content: 'ok' }),
      new ToolMessage({ tool_call_id: 'p', content: 'done' }),
    ]);
    await invoke();
    const sent = handler.mock.calls[0]?.[0].messages as ToolMessage[];
    expect(sent.map((m) => m.type)).toEqual([
      'human',
      'ai',
      'tool',
      'ai',
      'tool',
    ]);
    expect(sent[2]?.tool_call_id).toBe('p');
    expect(warn).not.toHaveBeenCalled();
  });
});
