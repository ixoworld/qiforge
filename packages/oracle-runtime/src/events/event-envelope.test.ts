import { describe, expect, it } from 'vitest';
import { Emitter, WS_SERVICE_EVENT_NAME } from '../modules/ws/emitter.js';
import { toEventEnvelope, type EventEnvelope } from './event-envelope.js';
import { createScopedEmitter, EVENT_NAMES } from './scoped-emitter.js';

describe('toEventEnvelope', () => {
  it('wraps a routable payload in the canonical wire shape', () => {
    const envelope = toEventEnvelope('tool_call', {
      sessionId: 'sess-1',
      requestId: 'req-1',
      toolName: 'search',
    });

    expect(envelope).toEqual({
      eventName: 'tool_call',
      payload: {
        sessionId: 'sess-1',
        requestId: 'req-1',
        toolName: 'search',
      },
    });
  });

  it('returns null when sessionId is missing or empty', () => {
    expect(toEventEnvelope('tool_call', { requestId: 'req-1' })).toBeNull();
    expect(
      toEventEnvelope('tool_call', { sessionId: '', requestId: 'req-1' }),
    ).toBeNull();
  });

  it('returns null when requestId is missing or empty', () => {
    expect(toEventEnvelope('tool_call', { sessionId: 'sess-1' })).toBeNull();
    expect(
      toEventEnvelope('tool_call', { sessionId: 'sess-1', requestId: '' }),
    ).toBeNull();
  });
});

describe('scoped emitter → envelope → ws emitter round-trip', () => {
  it('delivers the same discriminated shape the client SDK guard accepts', () => {
    const received: EventEnvelope[] = [];
    const channel = new Emitter();
    channel.on(WS_SERVICE_EVENT_NAME, (event: EventEnvelope) => {
      received.push(event);
    });

    // Mirror the production EmitAdapter: scoped emitter stamps the ids,
    // the sink wraps into an envelope and forwards to the ws channel.
    const scoped = createScopedEmitter(
      { sessionId: 'sess-9', requestId: 'req-9' },
      {
        emit(eventName, payload) {
          const envelope = toEventEnvelope(eventName, payload);
          if (envelope) channel.emit(envelope.payload.sessionId, envelope);
        },
      },
    );

    scoped.router({ step: 'route.selected', route: 'research' });

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(event.eventName).toBe(EVENT_NAMES.router);
    expect(event.eventName).toBe('router.update');
    // The exact fields the SDK's `isWebSocketEvent` guard requires:
    expect(event.payload.sessionId).toBe('sess-9');
    expect(event.payload.requestId).toBe('req-9');
    expect(event.payload.step).toBe('route.selected');
  });
});
