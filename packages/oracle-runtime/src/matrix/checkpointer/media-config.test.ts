import { describe, expect, it } from 'vitest';
import { parseUploadSizeLimit } from './media-config.js';

describe('parseUploadSizeLimit', () => {
  it('reads m.upload.size from a media config response', () => {
    expect(parseUploadSizeLimit({ 'm.upload.size': 104857600 })).toBe(
      104857600,
    );
  });

  it.each([
    [null],
    [undefined],
    ['50M'],
    [{}],
    [{ 'm.upload.size': '104857600' }],
    [{ 'm.upload.size': -1 }],
    [{ 'm.upload.size': 0 }],
    [{ 'm.upload.size': Number.NaN }],
  ])('returns undefined for malformed response %s', (response) => {
    expect(parseUploadSizeLimit(response)).toBeUndefined();
  });
});
