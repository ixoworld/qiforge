import { describe, expect, it, vi } from 'vitest';
import { baseEnvSchema, TURN_RECURSION_LIMIT_DEFAULT } from '../core/env';
import { turnRecursionLimit } from './turn-config';

describe('turnRecursionLimit', () => {
  it('defaults to 600 when the var is unset', () => {
    expect(TURN_RECURSION_LIMIT_DEFAULT).toBe(600);
    expect(turnRecursionLimit({})).toBe(600);
    expect(turnRecursionLimit({ TURN_RECURSION_LIMIT: undefined })).toBe(600);
  });

  it('picks up the Worker var as an integer', () => {
    expect(turnRecursionLimit({ TURN_RECURSION_LIMIT: '350' })).toBe(350);
    expect(turnRecursionLimit({ TURN_RECURSION_LIMIT: '1' })).toBe(1);
  });

  it('falls back to the default, with a warning, on a malformed value', () => {
    for (const bad of ['0', '-5', '2.5', 'abc', '']) {
      const warn = vi.fn();
      expect(turnRecursionLimit({ TURN_RECURSION_LIMIT: bad }, { warn })).toBe(
        600,
      );
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('TURN_RECURSION_LIMIT');
    }
  });

  it('is the same rule the base env schema enforces at boot', () => {
    const field = baseEnvSchema.shape.TURN_RECURSION_LIMIT;
    expect(field.parse(undefined)).toBe(600);
    expect(field.parse('120')).toBe(120);
    expect(field.safeParse('0').success).toBe(false);
    expect(field.safeParse('abc').success).toBe(false);
  });
});
