import { describe, expect, it, vi } from 'vitest';
import type { ChannelEventResult } from '../plugin-api/channel-events';
import { routeChannelEvent } from './channel-events';
import { makePlugin, makeRuntimeContext } from './test-fixtures';

const event = {
  kind: 'permission_answered' as const,
  permissionId: 'card_1',
  status: 'allowed' as const,
  requestId: 'permission:card_1:allowed',
};

function plugin(name: string, answer?: () => Promise<ChannelEventResult>) {
  const p = makePlugin({ name });
  if (answer) p.handleChannelEvent = vi.fn(answer);
  return p;
}

describe('routeChannelEvent', () => {
  it('asks the plugins in order; the first that claims the card decides', async () => {
    const first = plugin('first', async () => ({ kind: 'pass' }));
    const second = plugin('second', async () => ({
      kind: 'reply',
      text: 'No problem.',
      note: '[note]',
    }));
    const third = plugin('third', async () => ({ kind: 'ignore' }));
    await expect(
      routeChannelEvent(
        [plugin('none'), first, second, third],
        event,
        makeRuntimeContext(),
        () => undefined,
      ),
    ).resolves.toEqual({ kind: 'reply', text: 'No problem.', note: '[note]' });
    expect(third.handleChannelEvent).not.toHaveBeenCalled();
  });

  it('ignores a card no plugin claims', async () => {
    await expect(
      routeChannelEvent(
        [plugin('a', async () => ({ kind: 'pass' }))],
        event,
        makeRuntimeContext(),
        () => undefined,
      ),
    ).resolves.toEqual({ kind: 'ignore' });
  });

  it('ignores, and logs, a plugin that throws or answers an empty or oversized text', async () => {
    for (const answer of [
      async (): Promise<ChannelEventResult> => {
        throw new Error('boom');
      },
      async (): Promise<ChannelEventResult> => ({
        kind: 'agent',
        note: ' ',
      }),
      async (): Promise<ChannelEventResult> => ({
        kind: 'reply',
        text: 'x'.repeat(4001),
        note: '[note]',
      }),
    ]) {
      const warn = vi.fn();
      await expect(
        routeChannelEvent(
          [plugin('bad', answer)],
          event,
          makeRuntimeContext(),
          warn,
        ),
      ).resolves.toEqual({ kind: 'ignore' });
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});
