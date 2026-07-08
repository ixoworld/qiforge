import { rootEventEmitter } from '../../root-event-emitter/root-event-emitter.js';
import { shouldRegisterEvent } from '../test-utils.js';
import { RouterEvent } from './router.event.js';

describe('RouterEvent', () => {
  it('should initialize with the correct payload and eventName', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      step: 'initial',
    };
    const event = new RouterEvent(payload);
    expect(event.payload).toEqual(payload);
    expect(event.eventName).toBe(RouterEvent.eventName);
  });

  it('should update the step in the payload', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      step: 'initial',
    };
    const event = new RouterEvent(payload);
    event.updateStep('nextStep');
    expect(event.payload.step).toBe('nextStep');
  });

  it('should emit an event with the correct payload', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      step: 'initial',
    };
    const event = new RouterEvent(payload);
    const emitSpy = vi.spyOn(rootEventEmitter, 'emit');
    event.emit();
    expect(emitSpy).toHaveBeenCalledWith(RouterEvent.eventName, payload);
  });

  it('should register event handlers correctly', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      step: 'initial',
    };
    expect(shouldRegisterEvent(RouterEvent, payload)).toBe(true);
  });
});
