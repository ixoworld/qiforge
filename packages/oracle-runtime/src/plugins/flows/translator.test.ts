import { describe, expect, it } from 'vitest';
import {
  actionToCan,
  buildConditionsProp,
  canToAction,
  flowSpecToBaseUcan,
  friendlyInputsToNb,
  nbToFriendlyInputs,
  parseConditionsProp,
  stepIdToBlockId,
} from './translator.js';
import { someActionType } from './test-support.js';
import type { Condition, FlowSpecInput } from './types.js';

describe('translator: action resolution', () => {
  it('resolves a friendly action to a can and back', () => {
    const action = someActionType();
    const can = actionToCan(action);
    expect(can).toBeTruthy();
    expect(canToAction(can)).toBe(action);
  });

  it('throws a friendly error for an unknown action', () => {
    expect(() => actionToCan('definitely/not-a-real-action')).toThrowError(
      /Unknown action/,
    );
  });
});

describe('translator: field references', () => {
  it('round-trips refs and literals through nb', () => {
    const inputs = {
      to: 'alice@example.com',
      batches: '{{load.output.harvestable}}',
      count: 3,
    };
    const nb = friendlyInputsToNb(inputs);
    expect(nb).toEqual({
      to: 'alice@example.com',
      batches: { $ref: 'load.output.harvestable' },
      count: 3,
    });
    expect(nbToFriendlyInputs(nb)).toEqual(inputs);
  });

  it('returns undefined for empty inputs', () => {
    expect(friendlyInputsToNb(undefined)).toBeUndefined();
    expect(nbToFriendlyInputs({})).toBeUndefined();
  });
});

describe('translator: conditions (the silent-failure guard)', () => {
  const cases: Array<[Condition['is'], string]> = [
    ['equals', 'equals'],
    ['notEquals', 'not_equals'],
    ['greaterThan', 'greater_than'],
    ['lessThan', 'less_than'],
    ['contains', 'contains'],
    ['isEmpty', 'is_empty'],
    ['isNotEmpty', 'is_not_empty'],
  ];

  it.each(cases)(
    'writes operator %s as the evaluator string %s',
    (friendly, evaluator) => {
      const condition: Condition = {
        fromStep: 'a',
        field: 'decision',
        is: friendly,
        value: 'x',
      };
      const raw = buildConditionsProp([condition]);
      const parsed = JSON.parse(raw);
      // Must be the evaluator's vocabulary — never the compiler's eq/neq/... which never evaluates.
      expect(parsed.conditions[0].rule.operator).toBe(evaluator);
      expect(['eq', 'neq', 'gt', 'lt', 'in', 'exists']).not.toContain(
        parsed.conditions[0].rule.operator,
      );
      expect(parsed.conditions[0].sourceBlockId).toBe(stepIdToBlockId('a'));
    },
  );

  it('round-trips a condition through build/parse', () => {
    const condition: Condition = {
      fromStep: 'approve',
      field: 'status',
      is: 'equals',
      value: 'approved',
    };
    const raw = buildConditionsProp([condition]);
    expect(parseConditionsProp(raw)).toEqual([condition]);
  });

  it('parses defensively: garbage -> []', () => {
    expect(parseConditionsProp('not json')).toEqual([]);
    expect(parseConditionsProp(undefined)).toEqual([]);
    expect(parseConditionsProp('{"conditions":[{"bogus":true}]}')).toEqual([]);
  });
});

describe('translator: flowSpecToBaseUcan', () => {
  it('builds a valid BaseUcanFlow with ordered capabilities (no condition leakage)', () => {
    const action = someActionType();
    const spec: FlowSpecInput = {
      title: 'Test flow',
      goal: 'do a thing',
      steps: [
        { id: 'one', action, inputs: { x: 1 } },
        {
          id: 'two',
          action,
          after: ['one'],
          runWhen: { fromStep: 'one', field: 'ok', is: 'equals', value: true },
        },
      ],
    };
    const plan = flowSpecToBaseUcan(spec, {
      flowId: 'test-flow',
      ownerDid: 'did:ixo:owner',
    });

    expect(plan.kind).toBe('qi.flow.base-ucan');
    expect(plan.version).toBe('1.0');
    expect(plan.flowId).toBe('test-flow');
    expect(plan.title).toBe('Test flow');
    expect(plan.goal).toBe('do a thing');
    expect(plan.meta?.rootIssuer).toBe('did:ixo:owner');
    expect(plan.capabilities.map((c) => c.id)).toEqual(['one', 'two']);
    expect(plan.capabilities[0]?.with).toBe('ixo:flow:test-flow:one');
    expect(plan.capabilities[0]?.nb).toEqual({ x: 1 });
    // Conditions are NEVER emitted onto the capability — they are written to props directly.
    expect(plan.capabilities[1]?.condition).toBeUndefined();
  });
});
