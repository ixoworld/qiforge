import { describe, expect, it, vi } from 'vitest';
import { WorkStatusProducer } from './work-status';
describe('truthful work status outcomes', () => {
  it.each(['waiting', 'failed', 'cancelled', 'superseded'] as const)(
    'keeps %s visible and rejects later Done',
    async (phase) => {
      const postEvent = vi.fn(
        async (_roomId: string, _type: string, _content: object) => '$anchor',
      );
      const producer = new WorkStatusProducer({ postEvent });
      producer.beginTurn({
        requestId: 'r',
        roomId: '!room',
        threadId: '$thread',
        sessionId: 's',
        forEventId: '$user',
      });
      producer.emit('r', 'working');
      await Promise.resolve();
      await Promise.resolve();
      producer.finish('r', phase);
      producer.emit('r', 'done');
      await vi.waitFor(() =>
        expect(postEvent.mock.calls.at(-1)?.[2]).toMatchObject({
          props: { phase },
        }),
      );
      expect(producer.has('r')).toBe(false);
    },
  );
});
