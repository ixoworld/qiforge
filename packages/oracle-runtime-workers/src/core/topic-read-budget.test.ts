import { describe, it, expect, vi } from 'vitest';
import { withTopicReadBudget } from '../action-proposals/topic-budget';
describe('topic read budget', () => {
  it('cannot resume journal writes after a timed-out Matrix RPC eventually resolves', async () => {
    vi.useFakeTimers();
    let deliver: (value: unknown) => void = () => {};
    let wrote = false;
    const pending = new Promise<unknown>((resolve) => {
      deliver = resolve;
    });
    const result = withTopicReadBudget(
      {
        state: async () => [],
        history: async () => [],
        event: async () => pending,
      },
      fetch,
      async (reader) => {
        await reader.event('!room:test', '$event');
        wrote = true;
      },
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10001);
    expect(await result).toBeInstanceOf(Error);
    deliver({ event_id: '$event' });
    await Promise.resolve();
    await Promise.resolve();
    expect(wrote).toBe(false);
    vi.useRealTimers();
  });
});
