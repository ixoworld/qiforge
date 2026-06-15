import { describe, expect, it } from 'vitest';
import { acquireToolLock } from './tool-lock.js';

describe('acquireToolLock', () => {
  it('returns a release function when the key is free', () => {
    const release = acquireToolLock('test:free-key');
    expect(typeof release).toBe('function');
    release();
  });

  it('throws immediately when the key is already locked', () => {
    const release = acquireToolLock('test:contended-key');
    try {
      expect(() => acquireToolLock('test:contended-key')).toThrow(
        /in progress/i,
      );
    } finally {
      release();
    }
  });

  it('allows re-acquisition after the lock is released', () => {
    const release = acquireToolLock('test:reacquire-key');
    release();
    // Should not throw — lock was released
    const release2 = acquireToolLock('test:reacquire-key');
    expect(() => release2()).not.toThrow();
  });

  it('isolates locks by key — different keys do not block each other', () => {
    const releaseA = acquireToolLock('test:key-a');
    try {
      // key-b is independent; should not throw
      const releaseB = acquireToolLock('test:key-b');
      expect(() => releaseB()).not.toThrow();

      releaseB();
    } finally {
      releaseA();
    }
  });

  it('releases the lock even when the holder throws', () => {
    try {
      const release = acquireToolLock('test:throw-key');
      try {
        throw new Error('simulated failure');
      } finally {
        release();
      }
    } catch {
      // expected
    }
    // Lock must be free now
    const release = acquireToolLock('test:throw-key');
    expect(() => release()).not.toThrow();
  });
});
