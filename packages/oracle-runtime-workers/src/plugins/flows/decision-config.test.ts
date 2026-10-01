import { describe, expect, it } from 'vitest';
import { conditionSchema, semanticGateSchema } from './types';
import { buildConditionsProp, parseConditionsProp } from './translator';

describe('explicit condition configuration', () => {
  it('requires a source for newly authored conditions and round-trips both sources', () => {
    const condition = {
      fromStep: 'a',
      field: 'answer',
      is: 'equals' as const,
      value: true,
    };
    expect(conditionSchema.safeParse(condition).success).toBe(false);
    for (const source of ['configured_input', 'runtime_output'] as const) {
      const authored = conditionSchema.parse({ ...condition, source });
      expect(parseConditionsProp(buildConditionsProp([authored]))).toEqual([
        authored,
      ]);
    }
  });
  it('reads an untagged stored condition with the runtime-output interpretation', () => {
    const legacy = {
      fromStep: 'a',
      field: 'answer',
      is: 'equals' as const,
      value: true,
    };
    const tagged = buildConditionsProp([
      { ...legacy, source: 'runtime_output' },
    ]);
    const stored = tagged.replace('"source":"runtime_output",', '');
    expect(stored).not.toContain('"source"');
    expect(parseConditionsProp(stored)).toEqual([
      { ...legacy, source: 'runtime_output' },
    ]);
  });
  it('keeps semantic gates separate and versioned', () => {
    const gate = {
      version: 1,
      decision: 'flow.gate.semantic',
      criterion: 'Evidence meets the criterion',
      rubric: 'Evaluate the supplied evidence',
      inputFields: ['evidence'],
    };
    expect(semanticGateSchema.safeParse(gate).success).toBe(true);
    expect(semanticGateSchema.safeParse({ ...gate, version: 2 }).success).toBe(
      false,
    );
    expect(
      semanticGateSchema.safeParse({ ...gate, inputFields: [] }).success,
    ).toBe(false);
  });
});
