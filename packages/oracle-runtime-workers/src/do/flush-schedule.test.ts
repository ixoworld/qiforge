import { describe, expect, it } from 'vitest';
import { decideFlush, FLUSH_DUE_SLACK_MS } from './flush-schedule';

describe('decideFlush', () => {
  const now = 1_700_000_000_000;
  const day = 24 * 60 * 60_000;
  const base = { dirty: true, flushAt: now + day, now, idle: false };

  it('leaves a clean copy alone whatever the deadline says', () => {
    expect(decideFlush({ ...base, dirty: false })).toEqual({
      action: 'skip',
      reason: 'clean',
    });
    expect(decideFlush({ ...base, dirty: false, flushAt: now - 1 })).toEqual({
      action: 'skip',
      reason: 'clean',
    });
    expect(decideFlush({ ...base, dirty: false, idle: true })).toEqual({
      action: 'skip',
      reason: 'clean',
    });
  });

  it('waits for a deadline in the future (a keep-alive or heartbeat wake never uploads)', () => {
    expect(decideFlush(base)).toEqual({ action: 'wait', at: now + day });
    expect(
      decideFlush({ ...base, flushAt: now + FLUSH_DUE_SLACK_MS + 1 }),
    ).toEqual({
      action: 'wait',
      at: now + FLUSH_DUE_SLACK_MS + 1,
    });
  });

  it('uploads once the deadline is due, with a little slack for an early alarm', () => {
    expect(decideFlush({ ...base, flushAt: now })).toEqual({
      action: 'flush',
      reason: 'due',
    });
    expect(decideFlush({ ...base, flushAt: now - day })).toEqual({
      action: 'flush',
      reason: 'due',
    });
    expect(decideFlush({ ...base, flushAt: now + FLUSH_DUE_SLACK_MS })).toEqual(
      { action: 'flush', reason: 'due' },
    );
  });

  it('uploads before an idle eviction regardless of the deadline', () => {
    expect(decideFlush({ ...base, idle: true })).toEqual({
      action: 'flush',
      reason: 'idle',
    });
  });

  it('uploads a copy that was dirtied before a deadline was recorded', () => {
    expect(decideFlush({ ...base, flushAt: undefined })).toEqual({
      action: 'flush',
      reason: 'no-deadline',
    });
    expect(decideFlush({ ...base, flushAt: 'junk' })).toEqual({
      action: 'flush',
      reason: 'no-deadline',
    });
    expect(decideFlush({ ...base, flushAt: Number.NaN })).toEqual({
      action: 'flush',
      reason: 'no-deadline',
    });
  });
});
