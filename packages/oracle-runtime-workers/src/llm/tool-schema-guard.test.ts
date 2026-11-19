import { describe, expect, it } from 'vitest';
import { modelFacingParameters } from './tool-schema-guard';

const YO = "^[\\p{L}\\p{M}\\s'-]+$";

describe('modelFacingParameters', () => {
  it('removes refused patterns wherever a schema can hold one, and leaves the input alone', () => {
    const input = {
      type: 'object',
      properties: {
        language: { type: 'string', pattern: YO },
        // A parameter named `pattern` is a property, not the keyword.
        pattern: { type: 'string', pattern: '^[a-z]+$' },
        list: {
          type: 'array',
          items: { type: 'string', pattern: '^(?<y>\\d{4})$' },
        },
        either: {
          anyOf: [{ type: 'string', pattern: '\\p{Lu}' }, { type: 'number' }],
        },
        ref: { $ref: '#/$defs/name' },
      },
      $defs: { name: { type: 'string', pattern: '^\\P{N}+$' } },
    };
    const before = JSON.stringify(input);
    const { parameters, removed } = modelFacingParameters(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(removed.map((r) => r.path).sort()).toEqual([
      '$defs.name',
      'properties.either.anyOf.0',
      'properties.language',
      'properties.list.items',
    ]);
    expect(parameters).toEqual({
      type: 'object',
      properties: {
        language: { type: 'string' },
        pattern: { type: 'string', pattern: '^[a-z]+$' },
        list: { type: 'array', items: { type: 'string' } },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        ref: { $ref: '#/$defs/name' },
      },
      $defs: { name: { type: 'string' } },
    });
  });

  it('returns the very same object when every pattern is accepted', () => {
    const input = {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}$' },
      },
    };
    const { parameters, removed } = modelFacingParameters(input);
    expect(parameters).toBe(input);
    expect(removed).toEqual([]);
  });
});
