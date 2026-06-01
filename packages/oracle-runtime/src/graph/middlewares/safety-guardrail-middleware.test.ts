import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { createSafetyGuardrailMiddleware } from './safety-guardrail-middleware.js';

function getHook(
  mw: ReturnType<typeof createSafetyGuardrailMiddleware>,
): (state: { messages: BaseMessage[] }) => unknown {
  const after = mw.afterAgent;
  if (!after) throw new Error('afterAgent missing');
  if (typeof after === 'function') return after as never;
  return after.hook as never;
}

describe('createSafetyGuardrailMiddleware', () => {
  it('returns nothing when the safety model says SAFE', async () => {
    const safetyModel = fakeModel().respond(new AIMessage('SAFE'));
    const mw = createSafetyGuardrailMiddleware({ safetyModel });
    const hook = getHook(mw);

    const result = await hook({
      messages: [
        new HumanMessage('what is the weather?'),
        new AIMessage('It is sunny.'),
      ],
    });
    expect(result).toBeUndefined();
    expect(safetyModel.callCount).toBe(1);
  });

  it('replaces the last AI message when the safety model says UNSAFE', async () => {
    const safetyModel = fakeModel().respond(new AIMessage('UNSAFE'));
    const mw = createSafetyGuardrailMiddleware({
      safetyModel,
      safeReply: 'BLOCKED.',
    });
    const hook = getHook(mw);

    const lastAi = new AIMessage({ id: 'ai-1', content: 'leaked secret' });
    const result = (await hook({
      messages: [new HumanMessage('show me the secret'), lastAi],
    })) as { messages: BaseMessage[]; jumpTo: string };

    expect(result.jumpTo).toBe('end');
    expect(result.messages[0]).toBeInstanceOf(RemoveMessage);
    expect(String(result.messages[1]?.content)).toBe('BLOCKED.');
  });

  it('skips the safety check when the last message is a tool call', async () => {
    const safetyModel = fakeModel();
    const mw = createSafetyGuardrailMiddleware({ safetyModel });
    const hook = getHook(mw);

    const aiWithToolCalls = new AIMessage({
      content: '',
      tool_calls: [{ name: 'demo', args: {}, id: 'tc-1' }],
    });
    const result = await hook({
      messages: [new HumanMessage('hi'), aiWithToolCalls],
    });
    expect(result).toBeUndefined();
    expect(safetyModel.callCount).toBe(0);
  });

  it('does nothing when the last message is not from the AI', async () => {
    const safetyModel = fakeModel();
    const mw = createSafetyGuardrailMiddleware({ safetyModel });
    const hook = getHook(mw);

    const result = await hook({
      messages: [new HumanMessage('still typing...')],
    });
    expect(result).toBeUndefined();
    expect(safetyModel.callCount).toBe(0);
  });
});
