import { describe, expect, it } from 'vitest';
import { isSyntheticSessionId } from './synthetic-session.js';

describe('synthetic-session', () => {
  it('recognizes throwaway task session ids by prefix', () => {
    expect(
      isSyntheticSessionId('$task-66c937ff-b0d5-4ed5-bc9a-11d9abb9c330'),
    ).toBe(true);
    expect(isSyntheticSessionId('$realEventId:server')).toBe(false);
    expect(isSyntheticSessionId('sess-1')).toBe(false);
  });
});
