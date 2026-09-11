import { describe, expect, it } from 'vitest';
import { MAX_TURN_BODY_BYTES, turnBodyTooLarge } from './turn-body-cap';

describe('turn body cap', () => {
  it('is 256 KiB', () => {
    expect(MAX_TURN_BODY_BYTES).toBe(262_144);
  });

  it('accepts a body exactly at the cap and refuses one byte more', () => {
    expect(turnBodyTooLarge('x'.repeat(MAX_TURN_BODY_BYTES))).toBe(false);
    expect(turnBodyTooLarge('x'.repeat(MAX_TURN_BODY_BYTES + 1))).toBe(true);
  });

  it('lets a Portal-sized turn through where the old 100 KiB cap refused it', () => {
    // The measured devnet rejections: 102,514 and 114,697 bytes.
    expect(turnBodyTooLarge('x'.repeat(102_514))).toBe(false);
    expect(turnBodyTooLarge('x'.repeat(114_697))).toBe(false);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 'é' is two bytes: half the cap in characters is exactly the cap in bytes.
    const half = MAX_TURN_BODY_BYTES / 2;
    expect(turnBodyTooLarge('é'.repeat(half))).toBe(false);
    expect(turnBodyTooLarge('é'.repeat(half) + 'x')).toBe(true);
  });
});
