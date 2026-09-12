import { describe, expect, it, vi } from 'vitest';
import { createMatrixAdapter } from './ambient';

describe('createMatrixAdapter', () => {
  it('forwards a caller-pinned transaction id to the gateway, and an empty options object without one', async () => {
    const sendEvent = vi.fn().mockResolvedValue('$ev');
    const matrix = createMatrixAdapter({ sendEvent } as never);

    await matrix.postEvent(
      '!room',
      'ixo.action.log',
      { a: 1 },
      { txnId: 'action-log-1' },
    );
    expect(sendEvent).toHaveBeenLastCalledWith(
      '!room',
      'ixo.action.log',
      '{"a":1}',
      { txnId: 'action-log-1' },
    );

    await matrix.postToRoom('!room', { body: 'hi' });
    expect(sendEvent).toHaveBeenLastCalledWith(
      '!room',
      'm.room.message',
      '{"body":"hi"}',
      {},
    );
  });
});
