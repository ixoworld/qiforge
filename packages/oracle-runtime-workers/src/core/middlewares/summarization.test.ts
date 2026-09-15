import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  createSummarizationMiddleware,
  isFailedSummary,
  isSummarizationMessage,
  SUMMARY_PREFIX,
} from './summarization';

/** A model whose summary call fails the way a rejected provider request does. */
class FailingChatModel extends FakeListChatModel {
  override async _generate(): Promise<never> {
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
