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
const ANCHOR_ID = '$anchor:ixo.world';

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

    it('carries the full envelope in m.new_content on an edit, with no nested relation', () => {
      const content = buildOracleComponentContent(
        makeInput({ replacesEventId: ANCHOR_ID }),
      );

      expect(content).toEqual({
        component: 'work_status',
        props: { phase: 'working', label: 'Reading your receipts…' },
        body: 'Working…',
        sessionId: THREAD_ID,
        requestId: 'req-1',
        'm.new_content': {
          component: 'work_status',
          props: { phase: 'working', label: 'Reading your receipts…' },
          body: 'Working…',
          sessionId: THREAD_ID,
          requestId: 'req-1',
        },
        'm.relates_to': { rel_type: 'm.replace', event_id: ANCHOR_ID },
      });
      expect(content['m.new_content']).not.toHaveProperty('m.relates_to');
      expect(content['m.new_content']).not.toHaveProperty('m.new_content');
    });

    it('prefers the edit relation over the thread relation and still builds m.new_content', () => {
      const content = buildOracleComponentContent(
        makeInput({ replacesEventId: ANCHOR_ID, threadId: THREAD_ID }),
      );

      expect(content['m.relates_to']).toEqual({
        rel_type: 'm.replace',
        event_id: ANCHOR_ID,
      });
      expect(content['m.new_content']).toEqual({
        component: 'work_status',
        props: { phase: 'working', label: 'Reading your receipts…' },
        body: 'Working…',
        sessionId: THREAD_ID,
        requestId: 'req-1',
      });
    });

    it('carries toolCallId into m.new_content when present', () => {
      const content = buildOracleComponentContent(
        makeInput({ replacesEventId: ANCHOR_ID, toolCallId: 'call-1' }),
      );

      expect(content['m.new_content']).toHaveProperty('toolCallId', 'call-1');
    });

    it('omits toolCallId from m.new_content when not provided', () => {
      const content = buildOracleComponentContent(
        makeInput({ replacesEventId: ANCHOR_ID }),
      );

      expect(content['m.new_content']).not.toHaveProperty('toolCallId');
    });

    it('omits m.new_content on a thread-relation event', () => {
      const content = buildOracleComponentContent(
        makeInput({ threadId: THREAD_ID }),
      );

      expect(content).not.toHaveProperty('m.new_content');
    });

    it('omits m.new_content on a relation-free event', () => {
      const content = buildOracleComponentContent(makeInput());

      expect(content).not.toHaveProperty('m.new_content');
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
