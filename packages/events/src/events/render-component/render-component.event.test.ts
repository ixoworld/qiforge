import { rootEventEmitter } from '../../root-event-emitter/root-event-emitter.js';
import { shouldRegisterEvent } from '../test-utils.js';
import { RenderComponentEvent } from './render-component.event.js';

describe('RenderComponentEvent', () => {
  it('should have a default status of "isRunning" if not provided', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      componentName: 'testComponent',
      eventId: '101112',
    };
    const event = new RenderComponentEvent(payload);
    expect(event.payload.status).toBe('isRunning');
  });

  it('should retain the provided status', () => {
    const payload: RenderComponentEvent['payload'] = {
      sessionId: '456',
      requestId: '789',
      componentName: 'testComponent',
      status: 'done',
      eventId: '101112',
    };
    const event = new RenderComponentEvent(payload);
    expect(event.payload.status).toBe('done');
  });

  it('should have the correct eventName', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      componentName: 'testComponent',
      eventId: '101112',
    };
    const event = new RenderComponentEvent(payload);
    expect(event.eventName).toBe('render_component');
    expect(RenderComponentEvent.eventName).toBe('render_component');
  });

  it('should emit an event with the correct payload', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      componentName: 'testComponent',
      eventId: '101112',
    };
    const event = new RenderComponentEvent(payload);
    const emitSpy = vi.spyOn(rootEventEmitter, 'emit');
    event.emit();
    expect(emitSpy).toHaveBeenCalledWith(
      RenderComponentEvent.eventName,
      payload,
    );
  });

  it('should register event handlers correctly', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      componentName: 'testComponent',
      eventId: '101112',
    };
    expect(shouldRegisterEvent(RenderComponentEvent, payload)).toBe(true);
  });
});
