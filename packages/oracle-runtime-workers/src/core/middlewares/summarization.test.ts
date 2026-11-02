import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { countTokensApproximately } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import {
  countMessageTokensApproximately,
  createSummarizationMiddleware,
  isFailedSummary,
  isSummarizationMessage,
  SUMMARY_PREFIX,
} from './summarization';
import { turnCarryOf, turnStart } from './turn-boundary';
import { contextBudgetFor, DEFAULT_CONTEXT_KNOBS } from '../context-budget';
import { createContextGuardMiddleware } from './context-guard';

/** A model whose summary call fails the way a rejected provider request does. */
class FailingChatModel extends FakeListChatModel {
  calls = 0;
  override async _generate(): Promise<never> {
    this.calls += 1;
    throw new Error('400 Bad Request: {"detail":"Stream must be set to true"}');
  }
}

function longThread(turns: number) {
  const messages = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push(new HumanMessage({ id: `h${i}`, content: `question ${i}` }));
    messages.push(new AIMessage({ id: `a${i}`, content: `answer ${i}` }));
  }
  return messages;
}

const runtime = { context: {} } as never;

/** Run a middleware's beforeModel hook whichever shape LangChain gave it. */
async function beforeModel(
  mw: ReturnType<typeof createSummarizationMiddleware>,
  messages: unknown[],
): Promise<{ messages: Array<{ content: unknown }> } | undefined> {
  const hook = mw.beforeModel;
  if (!hook) throw new Error('beforeModel missing');
  const fn = typeof hook === 'function' ? hook : hook.hook;
  return (await fn({ messages } as never, runtime)) as
    | { messages: Array<{ content: unknown }> }
    | undefined;
}

describe('createSummarizationMiddleware', () => {
  it('condenses a long thread into a tagged summary message', async () => {
    const model = new FakeListChatModel({ responses: ['the gist'] });
    const mw = createSummarizationMiddleware({
      model,
      triggerMessages: 20,
      keepMessages: 4,
    });
    const update = await beforeModel(mw, longThread(12));
    expect(update).toBeDefined();
    const summary = update?.messages.find(
      (m) =>
        typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX),
    );
    expect(summary).toBeDefined();
    expect(String(summary?.content)).toContain('the gist');
    expect(isSummarizationMessage(summary as never)).toBe(true);
    expect(isFailedSummary(summary as never)).toBe(false);
  });

  it('keeps the full history when the summary call fails, instead of replacing it with the error', async () => {
    const warn = vi.fn();
    const mw = createSummarizationMiddleware({
      model: new FailingChatModel({ responses: [] }),
      triggerMessages: 20,
      keepMessages: 4,
      logger: { warn, log: () => undefined },
    });
    const update = await beforeModel(mw, longThread(12));
    expect(update).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Stream must be set to true',
    );
  });

  it('uses only the token trigger when a token budget is given, unless a message trigger is asked for', async () => {
    const model = new FakeListChatModel({ responses: ['gist'] });
    // 12 turns = 24 messages: over the legacy 20-message trigger, far under 50k tokens.
    const tokensOnly = createSummarizationMiddleware({
      model,
      triggerTokens: 50_000,
    });
    expect(await beforeModel(tokensOnly, longThread(12))).toBeUndefined();
    const both = createSummarizationMiddleware({
      model,
      triggerTokens: 50_000,
      triggerMessages: 20,
    });
    expect(await beforeModel(both, longThread(12))).toBeDefined();
    const legacy = createSummarizationMiddleware({ model });
    expect(await beforeModel(legacy, longThread(12))).toBeDefined();
  });

  it('does nothing below the trigger', async () => {
    const model = new FakeListChatModel({ responses: ['unused'] });
    const mw = createSummarizationMiddleware({ model, triggerMessages: 20 });
    const update = await beforeModel(mw, longThread(3));
    expect(update).toBeUndefined();
  });
});

describe('createSummarizationMiddleware — failures and mid-turn summaries', () => {
  it('does not try a failed summary again on a later step of the same turn', async () => {
    const warn = vi.fn();
    const model = new FailingChatModel({ responses: [] });
    const mw = createSummarizationMiddleware({
      model,
      triggerMessages: 20,
      keepMessages: 4,
      logger: { warn, log: () => undefined },
    });
    const thread = longThread(12);
    expect(await beforeModel(mw, thread)).toBeUndefined();
    // Later steps of the same turn: the history only grew.
    const step2 = [...thread, new AIMessage({ id: 'x1', content: 'more' })];
    expect(await beforeModel(mw, step2)).toBeUndefined();
    expect(await beforeModel(mw, [...step2, new AIMessage('again')])).toBe(
      undefined,
    );
    expect(model.calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // The next turn opens with a new user message and tries again.
    await beforeModel(mw, [
      ...step2,
      new HumanMessage({ id: 'h-next', content: 'next' }),
    ]);
    expect(model.calls).toBe(2);
  });

  /** A turn: the user's message, then `calls` tool steps with their results. */
  function turnWithCalls(
    calls: Array<{
      name: string;
      args: Record<string, unknown>;
      result: string;
      status?: 'error';
    }>,
  ): BaseMessage[] {
    const out: BaseMessage[] = [
      new HumanMessage({ id: 'turn', content: 'do it' }),
    ];
    calls.forEach((call, i) => {
      out.push(
        new AIMessage({
          id: `ai-${i}`,
          content: '',
          tool_calls: [{ id: `c${i}`, name: call.name, args: call.args }],
        }),
        new ToolMessage({
          id: `tm-${i}`,
          tool_call_id: `c${i}`,
          name: call.name,
          content: call.result,
          ...(call.status ? { status: call.status } : {}),
        }),
      );
    });
    return out;
  }

  it("carries the turn's condensed tool calls on a summary written mid-turn", async () => {
    const mw = createSummarizationMiddleware({
      model: new FakeListChatModel({ responses: ['the gist'] }),
      triggerMessages: 6,
      keepMessages: 2,
    });
    const history = [
      ...longThread(1),
      ...turnWithCalls([
        { name: 'send_message', args: { to: 'a' }, result: 'sent m-1' },
        {
          name: 'write_file',
          args: { path: '/x' },
          result: 'denied',
          status: 'error',
        },
        { name: 'get_status', args: {}, result: 'pending' },
      ]),
    ];
    const update = await beforeModel(mw, history);
    const summary = update?.messages.find(
      (m): m is HumanMessage =>
        m instanceof HumanMessage && isSummarizationMessage(m),
    );
    if (!summary) throw new Error('no summary');
    // The last call and its result are kept; the two before it are carried.
    expect(turnCarryOf(summary)).toEqual([
      {
        name: 'send_message',
        args: { to: 'a' },
        status: 'success',
        result: 'sent m-1',
      },
      {
        name: 'write_file',
        args: { path: '/x' },
        status: 'error',
        result: 'denied',
      },
    ]);
    const after = (update?.messages ?? []).filter(
      (m): m is BaseMessage =>
        m instanceof HumanMessage ||
        m instanceof AIMessage ||
        m instanceof ToolMessage,
    );
    // The summary now opens the turn.
    expect(turnStart(after)).toBe(after.indexOf(summary));
  });

  it('carries nothing when the whole current turn is kept', async () => {
    const mw = createSummarizationMiddleware({
      model: new FakeListChatModel({ responses: ['the gist'] }),
      triggerMessages: 10,
      keepMessages: 3,
    });
    const history = [
      ...longThread(5),
      ...turnWithCalls([{ name: 'send_message', args: {}, result: 'ok' }]),
    ];
    const update = await beforeModel(mw, history);
    const summary = update?.messages.find(
      (m): m is HumanMessage =>
        m instanceof HumanMessage && isSummarizationMessage(m),
    );
    if (!summary) throw new Error('no summary');
    expect(turnCarryOf(summary)).toBeUndefined();
  });
});

describe('createSummarizationMiddleware — with a context budget', () => {
  /** A summarizer that records what it is asked to condense. */
  class RecordingModel extends FakeListChatModel {
    readonly inputs: string[] = [];
    override async _generate(
      ...args: Parameters<FakeListChatModel['_generate']>
    ): ReturnType<FakeListChatModel['_generate']> {
      this.inputs.push(args[0].map((m) => String(m.content)).join('\n'));
      return super._generate(...args);
    }
  }

  it('hands the summarizer the earlier summary along with the history after it', async () => {
    // A 64k model: summarizes at 38,400 tokens, reads at most 48,800.
    const budget = contextBudgetFor(
      { model: 'main', tokens: 64_000, origin: 'catalog' },
      DEFAULT_CONTEXT_KNOBS,
    );
    const model = new RecordingModel({ responses: ['the new gist'] });
    const mw = createSummarizationMiddleware({
      model,
      triggerTokens: budget.summarizeAtTokens,
      triggerMessages: null,
      keepMessages: budget.keepMessages,
      summaryInputTokens: budget.summaryInputTokens,
    });
    const history: BaseMessage[] = [
      new HumanMessage({
        id: 'earlier-summary',
        content: `${SUMMARY_PREFIX}\n\nEARLIER-GIST: the user is planning a trip to Lisbon.`,
        additional_kwargs: { lc_source: 'summarization' },
      }),
    ];
    // Grow the history one turn at a time, as a thread does, until the
    // summarizer runs.
    let update: Awaited<ReturnType<typeof beforeModel>>;
    for (let i = 0; i < 100 && !update; i += 1) {
      history.push(
        new HumanMessage({ id: `q${i}`, content: `question ${i}` }),
        new AIMessage({
          id: `a${i}`,
          content: `answer ${i} ${'x'.repeat(2_000)}`,
        }),
      );
      update = await beforeModel(mw, [...history]);
    }
    expect(update).toBeDefined();
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]).toContain('EARLIER-GIST');
  });
});

describe('a thread that grew far past the memory window', () => {
  /** A summarizer that records the prompt it is sent. */
  class RecordingModel extends FakeListChatModel {
    readonly inputs: string[] = [];
    override async _generate(
      ...args: Parameters<FakeListChatModel['_generate']>
    ): ReturnType<FakeListChatModel['_generate']> {
      this.inputs.push(args[0].map((m) => String(m.content)).join('\n'));
      return super._generate(...args);
    }
  }

  /**
   * ~300k tokens (chars/4) of turns with tool calls, as a thread on a
   * 1,050,000-token model could reach before the memory window existed
   * (its summarizer only fired at 630,000).
   */
  function overLongThread(): BaseMessage[] {
    const messages: BaseMessage[] = [];
    for (let i = 0; i < 150; i += 1) {
      messages.push(
        new HumanMessage({
          id: `h${i}`,
          content: `${i === 0 ? 'OLDEST-MARK ' : ''}question ${i}`,
        }),
        new AIMessage({
          id: `c${i}`,
          content: '',
          tool_calls: [{ id: `t${i}`, name: 'lookup', args: { q: `q${i}` } }],
        }),
        new ToolMessage({
          id: `r${i}`,
          tool_call_id: `t${i}`,
          name: 'lookup',
          content: `result ${i} ${'y'.repeat(6_000)}`,
        }),
        new AIMessage({
          id: `a${i}`,
          content: `answer ${i} ${'x'.repeat(2_000)}`,
        }),
      );
    }
    messages.push(new HumanMessage({ id: 'next', content: 'NEWEST-MARK' }));
    return messages;
  }

  it('is condensed on its next turn by one summary that reads no more than a request of the budget window, and the turn then fits', async () => {
    const thread = overLongThread();
    const threadTokens = countMessageTokensApproximately(thread);
    expect(threadTokens).toBeGreaterThan(290_000);
    const window = {
      model: 'main',
      tokens: 1_050_000,
      origin: 'catalog',
    } as const;

    // Before: a 1.05M window summarized at 630,000, so this thread was sent
    // whole on every model call.
    const uncapped = contextBudgetFor(window, {
      ...DEFAULT_CONTEXT_KNOBS,
      memoryWindowTokens: 20_000_000,
    });
    expect(uncapped.summarizeAtTokens).toBe(630_000);
    const idle = new RecordingModel({ responses: ['unused'] });
    expect(
      await beforeModel(
        createSummarizationMiddleware({
          model: idle,
          triggerTokens: uncapped.summarizeAtTokens,
          triggerMessages: null,
          keepMessages: uncapped.keepMessages,
          summaryInputTokens: uncapped.summaryInputTokens,
        }),
        thread,
      ),
    ).toBeUndefined();
    expect(idle.inputs).toHaveLength(0);

    // Now: the budget window is 100,000 tokens whatever the model's.
    const budget = contextBudgetFor(window, DEFAULT_CONTEXT_KNOBS);
    expect(budget).toMatchObject({
      summarizeAtTokens: 60_000,
      summaryInputTokens: 83_000,
      requestCapTokens: 87_000,
    });
    const model = new RecordingModel({ responses: ['the gist'] });
    const update = await beforeModel(
      createSummarizationMiddleware({
        model,
        triggerTokens: budget.summarizeAtTokens,
        triggerMessages: null,
        keepMessages: budget.keepMessages,
        summaryInputTokens: budget.summaryInputTokens,
      }),
      thread,
    );
    // One summary call, whose prompt holds at most the summary input (plus
    // the prompt template and one role label per message), never the
    // thread a second time.
    expect(model.inputs).toHaveLength(1);
    const prompt = model.inputs[0]!;
    expect(prompt.length).toBeLessThanOrEqual(
      budget.summaryInputTokens * 4 + 12_000,
    );
    expect(prompt.length).toBeLessThan((threadTokens * 4) / 3);
    // It reads the newest part of what it condenses; the oldest part of a
    // thread this far over is dropped unread (the transcript keeps it).
    expect(prompt).toContain('answer 140 ');
    expect(prompt).not.toContain('OLDEST-MARK');

    // The new working context: the summary and the kept tail, under the
    // trigger, with the new message last.
    const next = (update?.messages ?? []).slice(1) as BaseMessage[];
    expect(next).toHaveLength(1 + budget.keepMessages);
    expect(isSummarizationMessage(next[0]!)).toBe(true);
    expect(next.at(-1)?.content).toBe('NEWEST-MARK');
    expect(countMessageTokensApproximately(next)).toBeLessThan(
      budget.summarizeAtTokens,
    );

    // The turn's model call then goes out under the request cap, unrefused.
    const guard = createContextGuardMiddleware({ budget });
    const wrap = guard.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');
    const call = (
      typeof wrap === 'function' ? wrap : (wrap as { hook: typeof wrap }).hook
    ) as (r: never, h: never) => Promise<unknown>;
    const sent: BaseMessage[][] = [];
    await call(
      {
        messages: next,
        systemMessage: { content: 's'.repeat(80_000) },
        tools: [],
        runtime: {},
      } as never,
      (async (req: { messages: BaseMessage[] }) => {
        sent.push(req.messages);
        return new AIMessage('ok');
      }) as never,
    );
    expect(sent).toHaveLength(1);
    expect(countMessageTokensApproximately(sent[0]!) + 20_000).toBeLessThan(
      budget.requestCapTokens,
    );
  });
});

describe('countMessageTokensApproximately', () => {
  it("counts exactly what LangChain's countTokensApproximately counts", () => {
    const messages: BaseMessage[] = [
      new HumanMessage('q'.repeat(101)),
      new HumanMessage({
        content: [
          { type: 'text', text: 'abc' },
          { type: 'image_url', image_url: { url: 'data:x' } },
          { type: 'text', text: 'de' },
        ],
      }),
      new AIMessage({
        content: 'thinking',
        tool_calls: [{ id: 'c1', name: 'get_x', args: { q: 'é'.repeat(7) } }],
      }),
      new AIMessage({ content: '', tool_calls: [] }),
      new ToolMessage({ tool_call_id: 'c1', content: 'result' }),
    ];
    for (let n = 0; n <= messages.length; n += 1) {
      const slice = messages.slice(0, n);
      expect(countMessageTokensApproximately(slice)).toBe(
        countTokensApproximately(slice),
      );
    }
    // Again, from the memo.
    expect(countMessageTokensApproximately(messages)).toBe(
      countTokensApproximately(messages),
    );
  });
});

describe('isFailedSummary', () => {
  it('recognises the summarizer’s error text with and without the prefix', () => {
    const failed = new HumanMessage({
      content: `${SUMMARY_PREFIX}\n\nError generating summary: Error: 400`,
      additional_kwargs: { lc_source: 'summarization' },
    });
    expect(isFailedSummary(failed)).toBe(true);
    const fine = new HumanMessage({
      content: `${SUMMARY_PREFIX}\n\nThe user asked about lighthouses.`,
      additional_kwargs: { lc_source: 'summarization' },
    });
    expect(isFailedSummary(fine)).toBe(false);
    expect(
      isFailedSummary(new HumanMessage('Error generating summary: x')),
    ).toBe(false);
  });
});
