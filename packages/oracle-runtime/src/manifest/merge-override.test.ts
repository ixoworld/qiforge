import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '../plugin-api/types.js';
import { mergeManifestOverride } from './merge-override.js';

const base: PluginManifest = {
  title: 'Weather',
  summary: 'Current conditions and forecasts.',
  whenToUse: ['user asks about weather'],
  visibility: 'always',
  tags: ['data'],
};

describe('mergeManifestOverride', () => {
  it('returns the same reference when no override is given', () => {
    expect(mergeManifestOverride(base)).toBe(base);
  });

  it('returns the same reference when the override is empty', () => {
    expect(mergeManifestOverride(base, {})).toBe(base);
  });

  it('overrides visibility while leaving other fields intact', () => {
    const merged = mergeManifestOverride(base, { visibility: 'on-demand' });
    expect(merged.visibility).toBe('on-demand');
    expect(merged.title).toBe('Weather');
    expect(merged.whenToUse).toEqual(['user asks about weather']);
  });

  it('replaces array fields wholesale rather than concatenating', () => {
    const merged = mergeManifestOverride(base, { tags: ['ui', 'beta'] });
    expect(merged.tags).toEqual(['ui', 'beta']);
  });

  it('ignores undefined override values so a sparse override never blanks a field', () => {
    const merged = mergeManifestOverride(base, {
      visibility: undefined,
      summary: 'New summary.',
    });
    expect(merged.visibility).toBe('always');
    expect(merged.summary).toBe('New summary.');
  });

  it('does not mutate the base manifest', () => {
    mergeManifestOverride(base, { visibility: 'silent' });
    expect(base.visibility).toBe('always');
  });
});
