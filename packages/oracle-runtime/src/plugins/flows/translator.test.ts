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
    // The stored $ref carries the BLOCK id (`flow_block_<stepId>`) — that is the
    // key the flow engine resolves against (runtime.get(<ref id>)). The agent
    // still works in friendly step ids, restored on the way back out.
    expect(nb).toEqual({
      to: 'alice@example.com',
      batches: { $ref: 'flow_block_load.output.harvestable' },
      count: 3,
    });
    expect(nbToFriendlyInputs(nb)).toEqual(inputs);
  });

  it('converts refs nested inside objects and arrays so the engine resolves them', () => {
    // Regression: a "{{...}}" inside a nested map (e.g. an email `variables`
    // block) used to pass through verbatim, so the engine — which only resolves
    // `$ref` — shipped the literal "{{...}}" to the recipient.
    const inputs = {
      to: '{{submit-request.output.answers.requesterEmail}}',
      variables: {
        CLAIM_ID: '{{submit-request.output.answers.requestTitle}}',
        LINK: 'https://portal.ixo.earth/flows/static',
      },
      recipients: ['{{submit-request.output.answers.cc}}', 'ops@example.com'],
    };
    const nb = friendlyInputsToNb(inputs);
    expect(nb).toEqual({
      to: { $ref: 'flow_block_submit-request.output.answers.requesterEmail' },
      variables: {
        CLAIM_ID: {
          $ref: 'flow_block_submit-request.output.answers.requestTitle',
        },
        LINK: 'https://portal.ixo.earth/flows/static',
      },
      recipients: [
        { $ref: 'flow_block_submit-request.output.answers.cc' },
        'ops@example.com',
      ],
    });
    expect(nbToFriendlyInputs(nb)).toEqual(inputs);
  });

  it('rewrites embedded refs inside a template string to block ids', () => {
    // Regression: an oracle `prompt` embeds refs in a larger string. These are
    // not a standalone `{{...}}`, so they never became a `$ref`; they shipped
    // with STEP ids while the downstream renderer keys on BLOCK ids, so every
    // placeholder resolved to an empty string.
    const inputs = {
      prompt:
        'Employee {{expense-request.output.answers.name}} submitted ' +
        '{{expense-request.output.answers.amount}}. ' +
        'Manager decided: {{manager-review.output.answers.decision}}.',
    };
    const nb = friendlyInputsToNb(inputs);
    expect(nb).toEqual({
      prompt:
        'Employee {{flow_block_expense-request.output.answers.name}} submitted ' +
        '{{flow_block_expense-request.output.answers.amount}}. ' +
        'Manager decided: {{flow_block_manager-review.output.answers.decision}}.',
    });
    expect(nbToFriendlyInputs(nb)).toEqual(inputs);
  });

  it('leaves non-output placeholders untouched while rewriting embedded refs', () => {
    // Handlebars helpers and trigger.payload.* carry no ".output." and must
    // pass through both directions verbatim.
    const inputs = {
      prompt:
        '{{#if approved}}Approved by {{review.output.answers.decision}}.{{/if}} ' +
        'Ticket {{trigger.payload.id}}.',
    };
    const nb = friendlyInputsToNb(inputs);
    expect(nb).toEqual({
      prompt:
        '{{#if approved}}Approved by {{flow_block_review.output.answers.decision}}.{{/if}} ' +
        'Ticket {{trigger.payload.id}}.',
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
