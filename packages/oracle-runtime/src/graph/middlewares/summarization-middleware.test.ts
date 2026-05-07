import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it, vi } from 'vitest';
import { createSummarizationMiddleware } from './summarization-middleware.js';

function makeFakeModel(): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({ content: 'summary' }),
  } as unknown as BaseChatModel;
}

describe('createSummarizationMiddleware', () => {
  it('returns a middleware with a beforeModel hook (configured by langchain)', () => {
    const mw = createSummarizationMiddleware({ model: makeFakeModel() });
    expect(mw.name).toBeDefined();
    // langchain's summarizationMiddleware wires its work into the agent
    // lifecycle; we just verify the returned object is structurally a
    // middleware with at least one hook attached.
    const hasHook =
      typeof mw.beforeModel === 'function' ||
      typeof mw.wrapModelCall === 'function' ||
      typeof mw.beforeAgent === 'function';
    expect(hasHook).toBe(true);
  });

  it('accepts trigger and keep overrides', () => {
    const mw = createSummarizationMiddleware({
      model: makeFakeModel(),
      triggerMessages: 5,
      keepMessages: 2,
    });
    expect(mw).toBeDefined();
    expect(mw.name).toBeDefined();
  });
});
