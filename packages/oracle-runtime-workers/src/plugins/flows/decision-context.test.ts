import { describe, expect, it, vi } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { readFlowDecisionContext } from './decision-context';

describe('readFlowDecisionContext authorization', () => {
  it.each(['nonmember', 'membership-outage'])(
    'denies %s before opening the privileged document',
    async (scenario) => {
      const ctx = makeRuntimeContext();
      const getRoomState = vi.fn(async (roomId: string) => {
        if (scenario === 'membership-outage')
          throw new Error('Matrix unavailable');
        return {
          roomId,
          state: [
            {
              type: 'm.room.member',
              state_key: '@someone-else:example.com',
              content: { membership: 'join' },
            },
          ],
        };
      });
      const botCredentials = vi.fn(ctx.matrix.botCredentials);
      await expect(
        readFlowDecisionContext(
          {
            ...ctx,
            user: { ...ctx.user, matrixUserId: '@requester:example.com' },
            matrix: { ...ctx.matrix, getRoomState, botCredentials },
          },
          `!decision-${scenario}:example.com`,
        ),
      ).rejects.toMatchObject({ code: 'not_in_room' });
      expect(getRoomState).toHaveBeenCalledOnce();
      expect(botCredentials).not.toHaveBeenCalled();
    },
  );

  it('does not open a flow for an already cancelled request', async () => {
    const ctx = makeRuntimeContext({
      abortSignal: AbortSignal.abort(new Error('cancelled')),
    });
    const getRoomState = vi.fn(ctx.matrix.getRoomState);
    await expect(
      readFlowDecisionContext(
        { ...ctx, matrix: { ...ctx.matrix, getRoomState } },
        '!cancelled:example.com',
      ),
    ).rejects.toThrow('cancelled');
    expect(getRoomState).not.toHaveBeenCalled();
  });
});
