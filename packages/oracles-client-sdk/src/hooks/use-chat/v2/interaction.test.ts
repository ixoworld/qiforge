import { describe, expect, it } from 'vitest';
import type { OracleInteraction } from '@ixo/oracles-events/interactions';
import { OracleChat } from './oracle-chat';
const update: OracleInteraction = {
  sessionId: 's',
  requestId: 'r',
  oracleDid: 'did:qi',
  oracleUserId: '@qi:test',
  oracleName: 'Qi',
  state: 'working',
  revision: 2,
  updatedAt: '2026-10-05T00:00:00Z',
};
describe('personal message interactions', () => {
  it('correlates optimistic messages and rejects stale or cross-session updates', async () => {
    const chat = new OracleChat({ sessionId: 's' });
    await chat.addUserMessage({
      id: 'optimistic',
      type: 'human',
      content: 'hello',
    });
    await chat.associateRequest('optimistic', 'r');
    await chat.applyInteraction(update);
    await chat.applyInteraction({
      ...update,
      sessionId: 'other',
      revision: 3,
      state: 'failed',
    });
    await chat.applyInteraction({ ...update, revision: 1, state: 'seen' });
    expect(chat.messages[0]?.interaction?.state).toBe('working');
    await chat.applyInteraction({ ...update, revision: 3, state: 'completed' });
    await chat.applyInteraction({ ...update, revision: 4, state: 'working' });
    await chat.applyInteraction({
      ...update,
      revision: 5,
      state: 'completed',
      sourceEventId: '$mirror',
    });
    expect(chat.messages[0]?.matrixEventId).toBe('$mirror');
    expect(chat.messages).toHaveLength(1);
    chat.cleanup();
  });
  it('accepts metadata from history on reconnect and keeps legacy messages intact', async () => {
    const chat = new OracleChat({ sessionId: 's' });
    await chat.setHistory([
      {
        id: 'history',
        type: 'human',
        content: 'hello',
        requestId: 'r',
        interaction: update,
      },
    ]);
    await chat.applyInteraction({ ...update, revision: 3, state: 'achieved' });
    expect(chat.messages[0]?.interaction?.state).toBe('achieved');
    await chat.addUserMessage({ id: 'old', type: 'human', content: 'legacy' });
    expect(chat.messages[1]?.interaction).toBeUndefined();
    chat.cleanup();
  });
});
