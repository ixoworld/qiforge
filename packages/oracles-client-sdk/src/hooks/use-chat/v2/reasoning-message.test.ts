import { describe, expect, it } from 'vitest';
import { OracleChat } from './oracle-chat.js';
import { reasoningMessageId, reasoningMessageOf } from './reasoning-message.js';

const chat = () =>
  new OracleChat({
    oracleDid: 'did:ixo:oracle',
    sessionId: 'sess',
    onPaymentRequiredError: () => undefined,
    streamingMode: 'immediate',
  });

describe('streamed reasoning next to the answer', () => {
  it('a model that thinks first keeps its answer visible while it streams', async () => {
    const c = chat();
    // The ChatGPT lane: reasoning summary frames arrive before any answer text.
    await c.upsertEventMessage(
      reasoningMessageOf({
        sessionId: 's',
        requestId: 'req-1',
        reasoning: 'Planning ',
        reasoningDetails: [
          { type: 'summary', text: 'Plan the story', format: 'text', index: 0 },
        ],
      }),
    );
    await c.upsertEventMessage(
      reasoningMessageOf({
        sessionId: 's',
        requestId: 'req-1',
        reasoning: 'the plot.',
        reasoningDetails: [
          { type: 'summary', text: 'Pick a genre', format: 'text', index: 1 },
        ],
        isComplete: true,
      }),
    );
    await c.upsertAIMessage('req-1', 'Once upon ');
    await c.upsertAIMessage('req-1', 'a time…');

    expect(c.messages.map((m) => m.id)).toEqual([
      reasoningMessageId('req-1'),
      'req-1',
    ]);
    const [thoughts, answer] = c.messages;
    expect(thoughts).toMatchObject({
      isReasoning: true,
      content: 'Planning the plot.',
      reasoning: 'Plan the storyPick a genre',
    });
    expect(answer).toMatchObject({
      id: 'req-1',
      type: 'ai',
      content: 'Once upon a time…',
    });
    expect(answer?.isReasoning).toBeFalsy();
  });

  it('reasoning that arrives after the answer never hides it either', async () => {
    const c = chat();
    await c.upsertAIMessage('req-2', 'The end.');
    await c.upsertEventMessage(
      reasoningMessageOf({
        sessionId: 's',
        requestId: 'req-2',
        reasoning: 'Wrapped up.',
        isComplete: true,
      }),
    );
    expect(c.messages.find((m) => m.id === 'req-2')).toMatchObject({
      content: 'The end.',
    });
    expect(c.messages.find((m) => m.id === 'req-2')?.isReasoning).toBeFalsy();
    expect(
      c.messages.find((m) => m.id === reasoningMessageId('req-2')),
    ).toMatchObject({ isReasoning: true });
  });
});
