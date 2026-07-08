import { type Server } from 'socket.io';
import { rootEventEmitter } from '../../root-event-emitter/root-event-emitter.js';
import {
  BaseEvent,
  shouldHaveSessionId,
  type WithRequiredEventProps,
} from './base-event.js';

describe('BaseEvent', () => {
  class TestEvent extends BaseEvent<unknown> {
    public payload: WithRequiredEventProps<unknown>;
    public static readonly eventName = 'testEvent';
    public readonly eventName = TestEvent.eventName;

    constructor(payload: WithRequiredEventProps<unknown>) {
      super();
      this.payload = payload;
    }
  }

  it('should throw an error if used in the browser', () => {
    const originalWindow = global.window;
    global.window = {} as Window & typeof globalThis;
    expect(
      () =>
        new TestEvent({
          sessionId: '456',
          requestId: '789',
        }),
    ).toThrow('Events should not be used in the browser.');
    global.window = originalWindow;
  });

  it('should throw an error if eventName is not defined', () => {
    class InvalidEvent extends BaseEvent<unknown> {
      public payload: WithRequiredEventProps<unknown>;
      public readonly eventName = '';

      constructor(payload: WithRequiredEventProps<unknown>) {
        super();
        this.payload = payload;
      }
    }

    expect(
      () =>
        new InvalidEvent({
          sessionId: '456',
          requestId: '789',
        }),
    ).toThrow(
      'Derived classes must define a static eventName property of type string.',
    );
  });

  it('should emit an event with the correct payload', () => {
    const payload = { sessionId: '456', requestId: '789' };
    const event = new TestEvent(payload);
    const emitSpy = vi.spyOn(rootEventEmitter, 'emit');
    event.emit();
    expect(emitSpy).toHaveBeenCalledWith(TestEvent.eventName, payload);
  });

  it('should register event handlers correctly', () => {
    const payload = { sessionId: '456', requestId: '789' };
    const server = {
      to: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    } as unknown as Server;
    const logSpy = vi.spyOn(console, 'log');
    TestEvent.registerEventHandlers(server);
    rootEventEmitter.emit(TestEvent.eventName, payload);
    expect(logSpy).toHaveBeenCalled();
    expect(server.to).toHaveBeenCalledWith(payload.sessionId);
    expect(server.emit).toHaveBeenCalledWith(TestEvent.eventName, payload);
  });
});

describe('shouldHaveSessionId', () => {
  it('should throw an error if payload is null or undefined', () => {
    expect(() => shouldHaveSessionId(null)).toThrow(
      'Payload must be provided and cannot be null or undefined.',
    );
    expect(() => shouldHaveSessionId(undefined)).toThrow(
      'Payload must be provided and cannot be null or undefined.',
    );
  });

  it('should throw an error if payload is not an object', () => {
    expect(() => shouldHaveSessionId(123)).toThrow(
      'Payload must be an object. Received: number',
    );
    expect(() => shouldHaveSessionId('string')).toThrow(
      'Payload must be an object. Received: string',
    );
  });

  it('should throw an error if payload does not include sessionId', () => {
    expect(() => shouldHaveSessionId({})).toThrow(
      'Payload must include a sessionId property.',
    );
  });

  it('should return the payload if it includes connectionId', () => {
    const payload = { connectionId: '123', sessionId: '456', requestId: '789' };
    expect(shouldHaveSessionId(payload)).toBe(payload);
  });
});
