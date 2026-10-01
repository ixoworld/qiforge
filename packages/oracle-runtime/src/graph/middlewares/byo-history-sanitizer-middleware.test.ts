import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { createByoHistorySanitizerMiddleware } from './byo-history-sanitizer-middleware.js';

function setup(opts?: {
  context?: unknown;
  messages?: Array<AIMessage | HumanMessage>;
}) {
  const mw = createByoHistorySanitizerMiddleware();
  const wrap = mw.wrapModelCall;
  if (!wrap) throw new Error('wrapModelCall missing');

  const handler = vi.fn().mockResolvedValue({ ok: true });
  const messages = opts?.messages ?? [];
  const context = opts?.context ?? {
    byo: { provider: 'chatgpt', active: true },
  };

  return {
    handler,
    invoke: () =>
      wrap({ messages, runtime: { context } } as never, handler as never),
  };
}

function passedMessages(handler: ReturnType<typeof vi.fn>): AIMessage[] {
  const call = handler.mock.calls[0][0] as { messages: AIMessage[] };
  return call.messages;
}

describe('createByoHistorySanitizerMiddleware', () => {
  it('leaves platform turns alone when only reasoning kwargs are present', async () => {
    const contaminated = new AIMessage({
      content: 'hi',
      additional_kwargs: { reasoning: 'openrouter free-text reasoning' },
    });
    const { handler, invoke } = setup({
      context: {},
      messages: [contaminated],
    });
    await invoke();
    expect(passedMessages(handler)[0]).toBe(contaminated);
  });

  it('leaves non-chatgpt BYO turns alone when only reasoning kwargs are present', async () => {
    const contaminated = new AIMessage({
      content: 'hi',
      additional_kwargs: { reasoning: { effort: 'high' } },
    });
    const { handler, invoke } = setup({
      context: { byo: { provider: 'anthropic', active: true } },
      messages: [contaminated],
    });
    await invoke();
    expect(passedMessages(handler)[0]).toBe(contaminated);
  });

  it('strips reasoning content blocks on every turn, keeping text blocks', async () => {
    const withBlocks = new AIMessage({
      content: [
        { type: 'reasoning', reasoning: 'thinking...' },
        { type: 'text', text: 'the answer' },
      ],
    });
    const { handler, invoke } = setup({
      context: {},
      messages: [withBlocks],
    });
    await invoke();
    const sent = passedMessages(handler)[0];
    expect(sent).not.toBe(withBlocks);
    expect(sent?.content).toEqual([{ type: 'text', text: 'the answer' }]);
    expect(withBlocks.content).toHaveLength(2);
  });

  it('collapses content to an empty string when only reasoning blocks existed', async () => {
    const onlyReasoning = new AIMessage({
      content: [{ type: 'reasoning', reasoning: 'thinking...' }],
    });
    const { handler, invoke } = setup({
      context: { byo: { provider: 'gemini', active: true } },
      messages: [onlyReasoning],
    });
    await invoke();
    expect(passedMessages(handler)[0]?.content).toBe('');
  });

  it('drops foreign-shape reasoning kwargs on chatgpt turns', async () => {
    const contaminated = new AIMessage({
      content: 'earlier platform answer',
      additional_kwargs: {
        reasoning: { content: 'openrouter shape, no summary' },
        other: 'kept',
      },
    });
    const { handler, invoke } = setup({ messages: [contaminated] });
    await invoke();
    const sent = passedMessages(handler)[0];
    expect(sent).not.toBe(contaminated);
    expect(sent?.additional_kwargs.reasoning).toBeUndefined();
    expect(sent?.additional_kwargs.other).toBe('kept');
    expect(contaminated.additional_kwargs.reasoning).toBeDefined();
  });

  it('drops string reasoning kwargs on chatgpt turns', async () => {
    const contaminated = new AIMessage({
      content: 'x',
      additional_kwargs: { reasoning: 'free text' },
    });
    const { handler, invoke } = setup({ messages: [contaminated] });
    await invoke();
    expect(passedMessages(handler)[0]?.additional_kwargs.reasoning).toBe(
      undefined,
    );
  });

  it('backfills an empty summary when encrypted content is present', async () => {
    const encrypted = new AIMessage({
      content: 'prior chatgpt answer',
      additional_kwargs: {
        reasoning: {
          id: 'rs_1',
          type: 'reasoning',
          encrypted_content: 'gAAAA...',
        },
      },
    });
    const { handler, invoke } = setup({ messages: [encrypted] });
    await invoke();
    const reasoning = passedMessages(handler)[0]?.additional_kwargs.reasoning;
    expect(reasoning).toEqual({
      id: 'rs_1',
      type: 'reasoning',
      encrypted_content: 'gAAAA...',
      summary: [],
    });
  });

  it('strips blocks and normalizes kwargs together on chatgpt turns', async () => {
    const mixed = new AIMessage({
      content: [
        { type: 'reasoning', reasoning: 'thoughts' },
        { type: 'text', text: 'answer' },
      ],
      additional_kwargs: {
        reasoning: { id: 'rs_3', type: 'reasoning', encrypted_content: 'enc' },
      },
    });
    const { handler, invoke } = setup({ messages: [mixed] });
    await invoke();
    const sent = passedMessages(handler)[0];
    expect(sent?.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(sent?.additional_kwargs.reasoning).toEqual({
      id: 'rs_3',
      type: 'reasoning',
      encrypted_content: 'enc',
      summary: [],
    });
  });

  it('leaves well-formed reasoning items untouched', async () => {
    const wellFormed = new AIMessage({
      content: 'x',
      additional_kwargs: {
        reasoning: {
          id: 'rs_2',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thought' }],
        },
      },
    });
    const { handler, invoke } = setup({ messages: [wellFormed] });
    await invoke();
    expect(passedMessages(handler)[0]).toBe(wellFormed);
  });

  it('ignores human messages and preserves tool calls on rebuilt messages', async () => {
    const human = new HumanMessage('hi');
    const withTools = new AIMessage({
      content: '',
      tool_calls: [{ name: 'do_thing', args: { a: 1 }, id: 'call_1' }],
      additional_kwargs: { reasoning: 'drop me' },
    });
    const { handler, invoke } = setup({ messages: [human, withTools] });
    await invoke();
    const sent = passedMessages(handler);
    expect(sent[0]).toBe(human);
    expect(sent[1]?.tool_calls).toEqual([
      { name: 'do_thing', args: { a: 1 }, id: 'call_1' },
    ]);
    expect(sent[1]?.additional_kwargs.reasoning).toBeUndefined();
  });
});
