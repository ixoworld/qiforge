import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OracleChatState } from './oracle-chat-state.js';
import type { IMessage } from './types.js';

const msg = (id: string, content = id): IMessage => ({
  id,
  type: 'ai',
  content,
});

describe('OracleChatState notifications', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('immediate mode notifies on every change and holds every message', () => {
    const state = new OracleChatState([], 'immediate');
    let notified = 0;
    state.subscribe(() => (notified += 1));
    for (let i = 0; i < 150; i += 1) state.pushMessage(msg(`m${i}`));
    expect(notified).toBe(150);
    expect(state.messages).toHaveLength(150); // no silent cap
  });

  it('throttled mode renders the first chunk at once and folds the rest of the window into one', () => {
    const state = new OracleChatState([], 'throttled', 50);
    let notified = 0;
    state.subscribe(() => (notified += 1));
    state.pushMessage(msg('ai', ''));
    expect(notified).toBe(1); // leading edge
    for (let i = 0; i < 40; i += 1)
      state.updateLastMessage((m) => ({ ...m, content: `${m.content}x` }));
    expect(notified).toBe(1); // held
    vi.advanceTimersByTime(49);
    expect(notified).toBe(1);
    vi.advanceTimersByTime(1);
    expect(notified).toBe(2); // one trailing render with everything
    expect(state.messages[0]?.content).toBe('x'.repeat(40));
    // Quiet window: nothing to flush, no spurious render.
    vi.advanceTimersByTime(100);
    expect(notified).toBe(2);
    // The next chunk after a quiet window is again immediate.
    state.updateLastMessage((m) => ({ ...m, content: `${m.content}y` }));
    expect(notified).toBe(3);
  });

  it('a status, error or run change is never held back', () => {
    const state = new OracleChatState([], 'throttled', 50);
    let notified = 0;
    state.subscribe(() => (notified += 1));
    state.pushMessage(msg('ai', ''));
    state.updateLastMessage((m) => ({ ...m, content: 'held' }));
    expect(notified).toBe(1);
    state.status = 'ready';
    expect(notified).toBe(2); // flushed at once, the held chunk with it
    vi.advanceTimersByTime(100);
    expect(notified).toBe(2); // the pending trailing render was consumed by the flush
  });

  it('a hidden tab gets every change at once, and a held render flushes when the tab is shown', () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible' as 'visible' | 'hidden',
      addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) =>
        listeners.delete(fn),
    };
    vi.stubGlobal('document', doc);
    try {
      const state = new OracleChatState([], 'throttled', 50);
      let notified = 0;
      state.subscribe(() => (notified += 1));
      state.pushMessage(msg('ai', ''));
      state.updateLastMessage((m) => ({ ...m, content: 'held' }));
      expect(notified).toBe(1);
      // The tab goes to the background with a render held: it is delivered
      // the moment the tab is shown again, not when a slowed timer fires.
      doc.visibilityState = 'hidden';
      listeners.forEach((fn) => fn());
      expect(notified).toBe(1);
      doc.visibilityState = 'visible';
      listeners.forEach((fn) => fn());
      expect(notified).toBe(2);
      // While hidden, chunks are not held at all.
      doc.visibilityState = 'hidden';
      state.updateLastMessage((m) => ({ ...m, content: `${m.content}!` }));
      state.updateLastMessage((m) => ({ ...m, content: `${m.content}!` }));
      expect(notified).toBe(4);
      state.cleanup();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cleanup cancels a pending trailing render', () => {
    const state = new OracleChatState([], 'throttled', 50);
    let notified = 0;
    state.subscribe(() => (notified += 1));
    state.pushMessage(msg('ai', ''));
    state.updateLastMessage((m) => ({ ...m, content: 'held' }));
    state.cleanup();
    vi.advanceTimersByTime(100);
    expect(notified).toBe(1);
  });
});
