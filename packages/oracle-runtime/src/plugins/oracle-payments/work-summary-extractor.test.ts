import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  WorkSummaryExtractor,
  type ExtractorModelFactory,
} from './work-summary-extractor.js';

interface Recorder {
  factory: ExtractorModelFactory;
  calls: { messages: BaseMessage[] }[];
}

/** A factory whose model returns `result` (or throws it, when it's an Error). */
function recordingFactory(result: unknown): Recorder {
  const calls: Recorder['calls'] = [];
  const factory: ExtractorModelFactory = () => ({
    withStructuredOutput: () => ({
      invoke: async (messages: BaseMessage[]) => {
        calls.push({ messages });
        if (result instanceof Error) throw result;
        return result;
      },
    }),
  });
  return { factory, calls };
}

const THREAD: BaseMessage[] = [
  new HumanMessage('Summarize my Q2 spending in USD.'),
  new AIMessage('Reading the five receipts you shared.'),
  new AIMessage('Built the categorized report with a grand total.'),
];

function extractorFor(result: unknown) {
  const recorder = recordingFactory(result);
  return {
    recorder,
    extractor: new WorkSummaryExtractor({ getModel: recorder.factory }),
  };
}

const GOOD = {
  request: 'Summarize my Q2 spending in USD.',
  workSummary: 'Categorized 5 receipts into a Q2 report with a grand total.',
};

describe('WorkSummaryExtractor', () => {
  it('returns the structured request + workSummary from the thread', async () => {
    const { extractor, recorder } = extractorFor(GOOD);

    const result = await extractor.extract({
      messages: THREAD,
      serviceId: 'tax-report',
      serviceName: 'Tax report',
    });

    expect(result).toEqual(GOOD);
    // System prompt + the rendered transcript.
    const call = recorder.calls[0];
    expect(call?.messages).toHaveLength(2);
    const prompt = String(call?.messages[0]?.content);
    expect(prompt).toContain('Tax report');
    expect(prompt).toMatch(/never invent outcomes/i);
    const transcript = String(call?.messages[1]?.content);
    expect(transcript).toContain('Summarize my Q2 spending in USD.');
    expect(transcript).toContain('grand total');
  });

  it('keeps the newest messages when the thread exceeds the budget', async () => {
    const { extractor, recorder } = extractorFor(GOOD);
    const filler = Array.from(
      { length: 40 },
      (_, i) => new AIMessage(`${i}-${'x'.repeat(1500)}`),
    );
    await extractor.extract({
      messages: [new HumanMessage('OLDEST-MARKER'), ...filler],
      serviceId: 'tax-report',
      serviceName: 'Tax report',
    });

    const transcript = String(recorder.calls[0]?.messages[1]?.content);
    expect(transcript).toContain('39-');
    expect(transcript).not.toContain('OLDEST-MARKER');
  });

  it('throws rather than guessing when the thread has no content', async () => {
    const { extractor } = extractorFor(GOOD);
    await expect(
      extractor.extract({
        messages: [],
        serviceId: 'tax-report',
        serviceName: 'Tax report',
      }),
    ).rejects.toThrow(/no recorded activity/i);
  });

  it('throws — never falls back to agent text — when the model fails', async () => {
    const { extractor } = extractorFor(new Error('model exploded'));
    await expect(
      extractor.extract({
        messages: THREAD,
        serviceId: 'tax-report',
        serviceName: 'Tax report',
      }),
    ).rejects.toThrow(/model exploded/);
  });

  it('throws when the model returns an unusable shape', async () => {
    const { extractor } = extractorFor({ request: 'only half of it' });
    await expect(
      extractor.extract({
        messages: THREAD,
        serviceId: 'tax-report',
        serviceName: 'Tax report',
      }),
    ).rejects.toThrow(/unusable result/i);
  });
});
