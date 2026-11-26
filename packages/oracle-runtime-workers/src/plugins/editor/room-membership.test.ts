import { describe, expect, it } from 'vitest';
import { DOC_UPDATE_EVENT_TYPE } from './provider';
import { canUserSendEventInState } from './room-membership';

const REQUESTER = '@requester:test.example';
const ORACLE = '@oracle:test.example';

function authorityState(
  requesterLevel: number,
  oracleLevel: number,
  required: number,
): ReadonlyArray<unknown> {
  return [
    {
      type: 'm.room.member',
      state_key: REQUESTER,
      content: { membership: 'join' },
    },
    {
      type: 'm.room.power_levels',
      state_key: '',
      content: {
        users: { [REQUESTER]: requesterLevel, [ORACLE]: oracleLevel },
        users_default: 0,
        events: { [DOC_UPDATE_EVENT_TYPE]: required },
        events_default: 0,
      },
    },
  ];
}

describe('Matrix requester write authority', () => {
  it('does not let oracle power elevate a low-power requester', () => {
    expect(
      canUserSendEventInState(
        authorityState(0, 100, 50),
        REQUESTER,
        DOC_UPDATE_EVENT_TYPE,
      ),
    ).toBe(false);
  });

  it('allows a joined requester who meets the event threshold', () => {
    expect(
      canUserSendEventInState(
        authorityState(50, 0, 50),
        REQUESTER,
        DOC_UPDATE_EVENT_TYPE,
      ),
    ).toBe(true);
  });

  it('preserves Matrix defaults when no power-level event exists', () => {
    expect(
      canUserSendEventInState(
        [
          {
            type: 'm.room.member',
            state_key: REQUESTER,
            content: { membership: 'join' },
          },
        ],
        REQUESTER,
        DOC_UPDATE_EVENT_TYPE,
      ),
    ).toBe(true);
  });

  it('fails closed on malformed authority state', () => {
    const state = authorityState(50, 100, 50).map((event) => {
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'm.room.power_levels'
      ) {
        return { ...event, content: { users_default: 'admin' } };
      }
      return event;
    });
    expect(
      canUserSendEventInState(state, REQUESTER, DOC_UPDATE_EVENT_TYPE),
    ).toBe(false);
  });
});
