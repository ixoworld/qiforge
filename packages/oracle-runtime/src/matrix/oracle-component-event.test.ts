import { describe, expect, it, vi } from 'vitest';
import {
  buildOracleComponentContent,
  ORACLE_COMPONENT_EVENT_TYPE,
  ORACLE_CONTRACTED_EVENT_TYPE,
  postOracleComponent,
  type OracleComponentInput,
} from './oracle-component-event.js';

const ROOM_ID = '!room:ixo.world';
const THREAD_ID = '$thread-root:ixo.world';

function makeInput(
  overrides: Partial<OracleComponentInput> = {},
): OracleComponentInput {
  return {
    component: 'work_status',
    props: { phase: 'working', label: 'Reading your receipts…' },
    body: 'Working…',
    sessionId: THREAD_ID,
    requestId: 'req-1',
    ...overrides,
  };
}

describe('oracle-component-event', () => {
  it('pins the protocol event types', () => {
    expect(ORACLE_COMPONENT_EVENT_TYPE).toBe('ixo.oracle.component');
    expect(ORACLE_CONTRACTED_EVENT_TYPE).toBe('ixo.oracle.contracted');
  });

  describe('buildOracleComponentContent', () => {
    it('builds the full envelope with a thread relation when threadId is set', () => {
      const content = buildOracleComponentContent(
        makeInput({ toolCallId: 'call-1', threadId: THREAD_ID }),
      );

      expect(content).toEqual({
        component: 'work_status',
        props: { phase: 'working', label: 'Reading your receipts…' },
        body: 'Working…',
        sessionId: THREAD_ID,
        requestId: 'req-1',
        toolCallId: 'call-1',
        'm.relates_to': { rel_type: 'm.thread', event_id: THREAD_ID },
      });
    });

    it('omits the thread relation when no threadId is provided', () => {
      const content = buildOracleComponentContent(makeInput());

      expect(content).not.toHaveProperty('m.relates_to');
    });

    it('omits toolCallId when not provided', () => {
      const content = buildOracleComponentContent(makeInput());

      expect(content).not.toHaveProperty('toolCallId');
    });
  });

  describe('postOracleComponent', () => {
    it('posts the built content as an ixo.oracle.component event and returns the event id', async () => {
      const postEvent = vi.fn(async () => '$new-event:ixo.world');

      const eventId = await postOracleComponent(
        { postEvent },
        ROOM_ID,
        makeInput({ threadId: THREAD_ID }),
      );

      expect(eventId).toBe('$new-event:ixo.world');
      expect(postEvent).toHaveBeenCalledWith(
        ROOM_ID,
        ORACLE_COMPONENT_EVENT_TYPE,
        buildOracleComponentContent(makeInput({ threadId: THREAD_ID })),
      );
    });
  });
});
