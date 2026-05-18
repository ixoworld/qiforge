import { AIMessage } from '@langchain/core/messages';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { createSummarizationMiddleware } from './summarization-middleware.js';

describe('createSummarizationMiddleware', () => {
  it('returns a middleware with a beforeModel hook (configured by langchain)', () => {
    const model = fakeModel().respond(new AIMessage('summary'));
    const mw = createSummarizationMiddleware({ model });
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
    const model = fakeModel().respond(new AIMessage('summary'));
    const mw = createSummarizationMiddleware({
      model,
      triggerMessages: 5,
      keepMessages: 2,
    });
    expect(mw).toBeDefined();
    expect(mw.name).toBeDefined();
  });
});
