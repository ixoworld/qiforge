import { describe, expect, it } from 'vitest';
import { evictIdleWorkingCopy, type IdleEvictionSteps } from './idle-eviction';

/** Steps over a fake object; `during` runs while the owner copy is checked. */
function object(opts: { current?: boolean; during?: () => void } = {}) {
  const state = { active: false, handles: true, wiped: false };
  const order: string[] = [];
  const steps: IdleEvictionSteps = {
    ownerCopyIsCurrent: async () => {
      order.push('check');
      // An awaited check: a request may be delivered in the meantime.
      await Promise.resolve();
      opts.during?.();
      return opts.current ?? true;
    },
    stillIdle: async () => {
      order.push('recheck');
      return !state.active;
    },
    dropHandles: () => {
      order.push('drop');
      state.handles = false;
    },
    wipe: async () => {
      order.push('wipe');
      expect(state.handles).toBe(false);
      state.wiped = true;
    },
  };
  return { steps, state, order };
}

describe('evictIdleWorkingCopy', () => {
  it('drops the handles, then wipes, once the owner copy is current and nothing happened meanwhile', async () => {
    const { steps, state, order } = object();
    expect(await evictIdleWorkingCopy(steps)).toBe('evicted');
    expect(state.wiped).toBe(true);
    expect(order).toEqual(['check', 'recheck', 'drop', 'wipe']);
  });

  it('keeps the working copy when a request arrives while the owner copy is checked', async () => {
    const { steps, state, order } = object({
      during: () => {
        state.active = true;
      },
    });
    expect(await evictIdleWorkingCopy(steps)).toBe('active');
    expect(state.wiped).toBe(false);
    expect(state.handles).toBe(true);
    expect(order).toEqual(['check', 'recheck']);
  });

  it('keeps the working copy when the owner copy is not verified current', async () => {
    const { steps, state, order } = object({ current: false });
    expect(await evictIdleWorkingCopy(steps)).toBe('not-current');
    expect(state.wiped).toBe(false);
    expect(order).toEqual(['check']);
  });
});
