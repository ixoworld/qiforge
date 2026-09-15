import { describe, expect, it } from 'vitest';
import { OracleChat } from './oracle-chat.js';
import { IDLE_RUN_STATE } from './types.js';

const chat = () =>
  new OracleChat({
    oracleDid: 'did:ixo:oracle',
    sessionId: 'sess',
    onPaymentRequiredError: () => undefined,
    streamingMode: 'immediate',
  });

describe('OracleChat durable-run state', () => {
  it('starts idle and merges run patches, notifying subscribers', () => {
    const c = chat();
    expect(c.run).toEqual(IDLE_RUN_STATE);
    let notified = 0;
    c.subscribe(() => {
      notified += 1;
    });
    c.setRun({ runId: 'run-1', requestId: 'req-1' });
    c.setRun({ reconnecting: true });
    expect(c.run).toEqual({
      runId: 'run-1',
      requestId: 'req-1',
      reconnecting: true,
      resumed: 0,
      ended: null,
    });
    expect(notified).toBe(2);
    c.cleanup();
    expect(c.run).toEqual(IDLE_RUN_STATE);
  });

  it('setAIMessageContent replaces the streamed text in place, or creates the message', async () => {
    const c = chat();
    await c.addUserMessage({ id: 'u1', type: 'human', content: 'hi' });
    await c.upsertAIMessage('req-1', 'Hello ');
    await c.upsertAIMessage('req-1', 'world');
    expect(c.lastMessage?.content).toBe('Hello world');
    // A resumed attempt: the runtime kept only "Hello ".
    await c.setAIMessageContent('req-1', 'Hello ');
    expect(c.messages.map((m) => m.id)).toEqual(['u1', 'req-1']);
    expect(c.lastMessage?.content).toBe('Hello ');
    await c.upsertAIMessage('req-1', 'there');
    expect(c.lastMessage?.content).toBe('Hello there');
    // A re-join after a reload: the message is not there yet.
    await c.setAIMessageContent('req-2', 'kept text');
    expect(c.messages.at(-1)).toEqual({
      id: 'req-2',
      type: 'ai',
      content: 'kept text',
    });
  });

  it('setAIMessageContent finds the message when it is not the last one', async () => {
    const c = chat();
    await c.upsertAIMessage('req-1', 'partial');
    await c.upsertEventMessage({
      id: 'req-1-ToolCall-1',
      type: 'ai',
      content: 'tool',
    });
    await c.setAIMessageContent('req-1', 'replaced');
    expect(c.messages.map((m) => [m.id, m.content])).toEqual([
      ['req-1', 'replaced'],
      ['req-1-ToolCall-1', 'tool'],
    ]);
  });
});

describe('OracleChat history merge', () => {
  const history = [
    { id: 'h1', type: 'human' as const, content: 'q1' },
    { id: 'a1', type: 'ai' as const, content: 'r1' },
  ];

  it('idle, the loaded history replaces what is shown', async () => {
    const c = chat();
    await c.setInitialMessages([
      { id: 'req-1', type: 'human', content: 'q1' },
      { id: 'req-1-ai', type: 'ai', content: 'r1' },
    ]);
    await c.setHistory(history);
    expect(c.messages.map((m) => m.id)).toEqual(['h1', 'a1']);
  });

  it('while streaming, the turn in flight stays on top of the history', async () => {
    const c = chat();
    await c.setInitialMessages([
      { id: 'h1', type: 'human', content: 'q1' },
      { id: 'a1', type: 'ai', content: 'r1' },
    ]);
    c.setStatus('streaming');
    await c.upsertAIMessage('req-2', 'partial');
    await c.setHistory([
      { id: 'h0', type: 'human', content: 'q0' },
      { id: 'a0', type: 'ai', content: 'r0' },
      ...history,
    ]);
    expect(c.messages.map((m) => m.id)).toEqual([
      'h0',
      'a0',
      'h1',
      'a1',
      'req-2',
    ]);
    expect(c.messages.at(-1)?.content).toBe('partial');
  });
});
