import { describe, expect, it } from 'vitest';
import { prefixSpeaker } from './speaker-prefix';

describe('prefixSpeaker', () => {
  it('prefixes a string once', () => {
    expect(prefixSpeaker('hello', 'Alice')).toBe('[Alice]: hello');
    expect(prefixSpeaker('[Alice]: hello', 'Alice')).toBe('[Alice]: hello');
  });

  it('prefixes the first text block of block content, or adds one', () => {
    expect(
      prefixSpeaker(
        [
          { type: 'image_url', image_url: { url: 'data:x' } },
          { type: 'text', text: 'what is this?' },
        ],
        'Bob',
      ),
    ).toEqual([
      { type: 'image_url', image_url: { url: 'data:x' } },
      { type: 'text', text: '[Bob]: what is this?' },
    ]);
    expect(
      prefixSpeaker(
        [{ type: 'image_url', image_url: { url: 'data:x' } }],
        'Bob',
      ),
    ).toEqual([
      { type: 'text', text: '[Bob]:' },
      { type: 'image_url', image_url: { url: 'data:x' } },
    ]);
  });
});
