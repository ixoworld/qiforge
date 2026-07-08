import { RootEventEmitter, rootEventEmitter } from './root-event-emitter.js';

describe('RootEventEmitter', () => {
  it('should return the same instance on multiple calls', () => {
    const instance1 = rootEventEmitter;
    const instance2 = RootEventEmitter.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should throw an error if used in the browser', () => {
    const originalWindow = global.window;
    global.window = {} as Window & typeof globalThis;
    expect(() => RootEventEmitter.getInstance()).toThrow(
      'RootEventEmitter should not be used in the browser.',
    );
    global.window = originalWindow;
  });

  it('should emit and listen to events', () => {
    const event = 'testEvent';
    const data = { key: 'value' };
    const listener = vi.fn();

    rootEventEmitter.on(event, listener);
    rootEventEmitter.emit(event, data);

    expect(listener).toHaveBeenCalledWith(data);
  });

  it('should remove event listeners', () => {
    const event = 'testEvent';
    const listener = vi.fn();

    rootEventEmitter.on(event, listener);
    rootEventEmitter.removeListener(event, listener);
    rootEventEmitter.emit(event, {});

    expect(listener).not.toHaveBeenCalled();
  });
});
