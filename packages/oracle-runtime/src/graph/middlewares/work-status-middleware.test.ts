import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent, fakeModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWorkStatusMiddleware } from './work-status-middleware.js';

const searchSkills = tool(
  ({ query }: { query: string }) => `results for ${query}`,
  {
    name: 'search_skills',
    description: 'Search the skill registry.',
    schema: z.object({ query: z.string() }),
  },
);

const RUN_CONTEXT = {
  user: {
    did: 'did:ixo:user1',
    matrixUserId: '@did-ixo-user1:ixo.world',
    ucanDelegation: { raw: 'eyJ-test', capabilities: [] },
  },
  session: {
    id: 'thr-1',
    client: 'matrix',
    requestId: 'req-1',
    roomId: '!room:ixo.world',
  },
};

function makeAgent(model: ReturnType<typeof fakeModel>, step: () => void) {
  return createAgent({
    model,
    tools: [searchSkills],
    middleware: [createWorkStatusMiddleware({ producer: { step } })],
  });
}

describe('createWorkStatusMiddleware', () => {
  it('posts a Thinking… step before the model call', async () => {
    const step = vi.fn();
    const agent = makeAgent(
      fakeModel().respond(new AIMessage('All done')),
      step,
    );

    await agent.invoke(
      { messages: [new HumanMessage('hi')] },
      { context: RUN_CONTEXT },
    );

    expect(step.mock.calls).toEqual([['req-1', 'Thinking…']]);
  });

  it('posts the humanized tool label before a tool call', async () => {
    const step = vi.fn();
    const agent = makeAgent(
      fakeModel()
        .respondWithTools([
          { name: 'search_skills', args: { query: 'tax' }, id: 'c1' },
        ])
        .respond(new AIMessage('Found it')),
      step,
    );

    await agent.invoke(
      { messages: [new HumanMessage('find me a skill')] },
      { context: RUN_CONTEXT },
    );

    // One beat per model call, one per tool call, in the order the graph runs.
    expect(step.mock.calls).toEqual([
      ['req-1', 'Thinking…'],
      ['req-1', 'Search skills…'],
      ['req-1', 'Thinking…'],
    ]);
  });

  it('is a no-op when the runtime context carries no requestId', async () => {
    const step = vi.fn();
    const agent = makeAgent(
      fakeModel()
        .respondWithTools([
          { name: 'search_skills', args: { query: 'tax' }, id: 'c1' },
        ])
        .respond(new AIMessage('Found it')),
      step,
    );

    // HTTP/WS turns invoke without the Matrix session channel.
    const result = await agent.invoke({
      messages: [new HumanMessage('find me a skill')],
    });

    expect(step).not.toHaveBeenCalled();
    // The turn still runs to completion — the card is a side effect, never a gate.
    expect(result.messages.at(-1)?.text).toBe('Found it');
  });

  it('returns the model and tool results unchanged', async () => {
    const step = vi.fn();
    const reply = new AIMessage('Found it');
    const agent = makeAgent(
      fakeModel()
        .respondWithTools([
          { name: 'search_skills', args: { query: 'tax' }, id: 'c1' },
        ])
        .respond(reply),
      step,
    );

    const result = await agent.invoke(
      { messages: [new HumanMessage('find me a skill')] },
      { context: RUN_CONTEXT },
    );

    const toolMessage = result.messages.find((m) => m instanceof ToolMessage);
    expect(toolMessage?.text).toBe('results for tax');
    expect(result.messages.at(-1)?.text).toBe('Found it');
    // Pure side effect: the middleware writes no state channel of its own.
    expect(result.messages).toHaveLength(4);
  });
});
