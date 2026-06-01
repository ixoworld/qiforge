import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '../plugin-api/types.js';
import {
  pluginManifestSchema,
  validateExamplesAgainstTools,
  validateManifest,
} from './index.js';

const PLUGIN = 'climate';

function baseManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    title: 'Climate Data',
    summary: 'Facility emissions and carbon footprint analysis.',
    whenToUse: ['User asks about emissions for a facility'],
    visibility: 'always',
    ...overrides,
  };
}

describe('pluginManifestSchema', () => {
  it('parses a valid manifest into the PluginManifest shape', () => {
    const m: PluginManifest = baseManifest({
      whenNotToUse: ['General weather questions'],
      examples: [
        {
          user: 'Emissions for Plant 42',
          tool: 'get_emissions',
          args: { facilityId: 'plant-42' },
        },
      ],
      tags: ['climate', 'emissions'],
      category: 'data',
      stability: 'stable',
    });
    const parsed = pluginManifestSchema.parse(m);
    expect(parsed).toEqual(m);
  });
});

describe('validateManifest', () => {
  it('returns valid for a well-formed manifest', () => {
    const result = validateManifest(baseManifest(), PLUGIN);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('reports missing summary with field path and plugin name', () => {
    const { summary: _summary, ...rest } = baseManifest();
    const result = validateManifest(rest, PLUGIN);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes(`[${PLUGIN}]`))).toBe(true);
    expect(result.errors.some((e) => e.includes('summary'))).toBe(true);
  });

  it('reports empty summary as invalid', () => {
    const result = validateManifest(baseManifest({ summary: '   ' }), PLUGIN);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes('summary') && e.includes('non-empty'),
      ),
    ).toBe(true);
  });

  it('errors when visibility is "always" and whenToUse is empty', () => {
    const result = validateManifest(
      baseManifest({ visibility: 'always', whenToUse: [] }),
      PLUGIN,
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes('whenToUse') && e.includes("'always'"),
      ),
    ).toBe(true);
  });

  it('errors when visibility is "on-demand" (default) and whenToUse is empty', () => {
    const result = validateManifest(
      baseManifest({ visibility: undefined, whenToUse: [] }),
      PLUGIN,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('whenToUse'))).toBe(true);
  });

  it('allows empty whenToUse for "silent" plugins', () => {
    const result = validateManifest(
      baseManifest({ visibility: 'silent', whenToUse: [] }),
      PLUGIN,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('errors on uppercase tags', () => {
    const result = validateManifest(
      baseManifest({ tags: ['climate', 'Emissions'] }),
      PLUGIN,
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes('tags[1]') && e.includes('lowercase'),
      ),
    ).toBe(true);
  });

  it('warns (without failing) on summary > 120 chars', () => {
    const longSummary = 'x'.repeat(121);
    const result = validateManifest(
      baseManifest({ summary: longSummary }),
      PLUGIN,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('summary'))).toBe(true);
  });

  it('warns when whenToUse exceeds 8 items or any item > 100 chars', () => {
    const result = validateManifest(
      baseManifest({
        whenToUse: [
          ...Array.from({ length: 8 }, (_, i) => `trigger ${i}`),
          'x'.repeat(101),
        ],
      }),
      PLUGIN,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(
      result.warnings.some(
        (w) =>
          /whenToUse$/.test(w.split(' ')[1] ?? '') || w.includes('whenToUse'),
      ),
    ).toBe(true);
  });

  it('warns when whenNotToUse exceeds 4 items or any item > 80 chars', () => {
    const result = validateManifest(
      baseManifest({
        whenNotToUse: ['a', 'b', 'c', 'd', 'e', 'x'.repeat(81)],
      }),
      PLUGIN,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('whenNotToUse'))).toBe(true);
  });

  it('warns when examples exceed 3 items', () => {
    const result = validateManifest(
      baseManifest({
        examples: [
          { user: 'a', tool: 't' },
          { user: 'b', tool: 't' },
          { user: 'c', tool: 't' },
          { user: 'd', tool: 't' },
        ],
      }),
      PLUGIN,
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('examples'))).toBe(true);
  });

  it('returns invalid for a non-object input', () => {
    const result = validateManifest(null, PLUGIN);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('validateExamplesAgainstTools', () => {
  it('returns no errors when every example tool is registered', () => {
    const manifest = baseManifest({
      examples: [
        { user: 'q', tool: 'get_emissions' },
        { user: 'q2', tool: 'compare_emissions' },
      ],
    });
    const result = validateExamplesAgainstTools(
      manifest,
      ['get_emissions', 'compare_emissions'],
      PLUGIN,
    );
    expect(result.errors).toEqual([]);
  });

  it('returns an error for each unknown tool name', () => {
    const manifest = baseManifest({
      examples: [
        { user: 'q', tool: 'get_emissions' },
        { user: 'q2', tool: 'mystery_tool' },
      ],
    });
    const result = validateExamplesAgainstTools(
      manifest,
      ['get_emissions'],
      PLUGIN,
    );
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('mystery_tool');
    expect(result.errors[0]).toContain(`[${PLUGIN}]`);
    expect(result.errors[0]).toContain('examples[1].tool');
  });

  it('returns no errors when manifest has no examples', () => {
    const manifest = baseManifest();
    const result = validateExamplesAgainstTools(manifest, ['x'], PLUGIN);
    expect(result.errors).toEqual([]);
  });
});
