import {
  HumanMessage,
  isAIMessage,
  isToolMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent, FakeToolCallingModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createReturnDirectFirstMiddleware } from './return-direct-first';

function tools() {
  const note = tool(async () => 'noted', {
    name: 'note',
    description: 'Take a note.',
    schema: z.object({}),
  });
  const send = tool(async () => 'sent', {
    name: 'send_document',
    description: 'Send the document.',
    schema: z.object({}),
    returnDirect: true,
  });
  return [note, send];
}

function agent(
  withMiddleware: boolean,
  calls: Array<{ name: string; id: string }>,
) {
  return createAgent({
    model: new FakeToolCallingModel({
      toolCalls: [calls.map((c) => ({ ...c, args: {} })), []],
    }),
    tools: tools(),
    middleware: withMiddleware
      ? [createReturnDirectFirstMiddleware(new Set(['send_document']))]
      : [],
  });
}

describe('ReturnDirectFirstMiddleware', () => {
  const both = [
    { name: 'note', id: 'c1' },
    { name: 'send_document', id: 'c2' },
  ];

  it('without it, a return-direct call in last place ends the run before the other result is read', async () => {
    const result = await agent(false, both).invoke({
      messages: [new HumanMessage('go')],
    });
    expect(isToolMessage(result.messages.at(-1)!)).toBe(true);
  });

  it('moves the return-direct call first so the model reads every result', async () => {
    const result = await agent(true, both).invoke({
      messages: [new HumanMessage('go')],
    });
    const last = result.messages.at(-1)!;
    expect(isAIMessage(last)).toBe(true);
    const step = result.messages.find(
      (m) => isAIMessage(m) && (m.tool_calls?.length ?? 0) > 0,
    );
    expect(
      step && isAIMessage(step) ? step.tool_calls?.map((c) => c.name) : [],
    ).toEqual(['send_document', 'note']);
  });

  it('leaves a lone return-direct call alone: the run ends after it', async () => {
    const result = await agent(true, [
      { name: 'send_document', id: 'c1' },
    ]).invoke({
      messages: [new HumanMessage('go')],
    });
    expect(isToolMessage(result.messages.at(-1)!)).toBe(true);
  });
});
