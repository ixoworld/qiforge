import { rootEventEmitter } from '../../root-event-emitter/root-event-emitter.js';
import { shouldRegisterEvent } from '../test-utils.js';
import { ToolCallEvent } from './tool-call.event.js';

describe('ToolCallEvent', () => {
  it('should have a default status of "isRunning" if not provided', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      toolName: 'testTool',
      eventId: '101112',
    };
    const event = new ToolCallEvent(payload);
    expect(event.payload.status).toBe('isRunning');
  });

  it('should retain the provided status', () => {
    const payload: ToolCallEvent['payload'] = {
      sessionId: '456',
      requestId: '789',
      toolName: 'testTool',
      status: 'done',
      eventId: '101112',
    };
    const event = new ToolCallEvent(payload);
    expect(event.payload.status).toBe('done');
  });

  it('should have the correct eventName', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      toolName: 'testTool',
      eventId: '101112',
    };
    const event = new ToolCallEvent(payload);
    expect(event.eventName).toBe('tool_call');
    expect(ToolCallEvent.eventName).toBe('tool_call');
  });

  it('should emit an event with the correct payload', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      toolName: 'testTool',
      eventId: '101112',
    };
    const event = new ToolCallEvent(payload);
    const emitSpy = vi.spyOn(rootEventEmitter, 'emit');
    event.emit();
    expect(emitSpy).toHaveBeenCalledWith(ToolCallEvent.eventName, payload);
  });

  it('should register event handlers correctly', () => {
    const payload = {
      connectionId: '123',
      sessionId: '456',
      requestId: '789',
      toolName: 'testTool',
      eventId: '101112',
    };
    expect(shouldRegisterEvent(ToolCallEvent, payload)).toBe(true);
  });
});
