import { describe, expect, it } from 'vitest';
import { flowSpecToBaseUcan } from './translator.js';
import { readFlowSpec, readStep } from './read.js';
import {
  removeStep,
  reorderStep,
  setStepAssignment,
  setStepConditions,
  setStepConfirmation,
  setStepInputs,
  setStepSchedule,
  setStepTrigger,
  updateFlowMeta,
} from './edit.js';
import {
  hydrateFlowDoc,
  setStepRuntime,
  someActionType,
} from './test-support.js';
import type { FlowSpecInput } from './types.js';

function threeStepDoc() {
  const action = someActionType();
  const spec: FlowSpecInput = {
    title: 'Edit flow',
    steps: [
      { id: 'a', action, inputs: { x: 'a-value' } },
      { id: 'b', action, inputs: { y: 'b-value' } },
      { id: 'c', action, inputs: { z: 'c-value' } },
    ],
  };
  return hydrateFlowDoc(flowSpecToBaseUcan(spec, { flowId: 'edit-flow' }));
}

describe('edit: per-block isolation (the core guarantee)', () => {
  it('setStepInputs changes only the target step', () => {
    const doc = threeStepDoc();
    setStepRuntime(doc, 'c', {
      state: 'completed',
      output: { claimId: 'xyz' },
    });

    setStepInputs(doc, 'b', { y: 'changed', extra: '{{a.output.value}}' });

    const flow = readFlowSpec(doc, 'r')!;
    const byId = Object.fromEntries(flow.steps.map((s) => [s.id, s]));
    expect(byId.a!.inputs).toEqual({ x: 'a-value' });
    expect(byId.b!.inputs).toEqual({
      y: 'changed',
      extra: '{{a.output.value}}',
    });
    expect(byId.c!.inputs).toEqual({ z: 'c-value' });
    // Sibling runtime status is untouched.
    expect(byId.c!.status?.state).toBe('completed');
  });
});

describe('edit: settings round-trip via read', () => {
  it('conditions are written in the evaluator vocabulary and round-trip', () => {
    const doc = threeStepDoc();
    setStepConditions(doc, 'b', [
      { fromStep: 'a', field: 'decision', is: 'equals', value: 'approved' },
    ]);

    const step = readStep(doc, 'r', 'b')!;
    expect(step.runWhen).toEqual({
      fromStep: 'a',
      field: 'decision',
      is: 'equals',
      value: 'approved',
    });
  });

  it('schedule, assignment, and confirmation round-trip', () => {
    const doc = threeStepDoc();
    setStepSchedule(doc, 'a', { at: '2026-07-01T00:00:00Z', within: 'PT1H' });
    setStepAssignment(doc, 'a', 'did:ixo:assignee');
    setStepConfirmation(doc, 'a', true);

    const step = readStep(doc, 'r', 'a')!;
    expect(step.due).toEqual({ at: '2026-07-01T00:00:00Z', within: 'PT1H' });
    expect(step.assignTo).toBe('did:ixo:assignee');
    expect(step.requireConfirmation).toBe(true);
  });

  it('trigger round-trips flow-start and clears back to the manual default', () => {
    const doc = threeStepDoc();
    setStepTrigger(doc, 'a', 'flow-start');
    expect(readStep(doc, 'r', 'a')!.trigger).toBe('flow-start');
    setStepTrigger(doc, 'a', 'manual');
    // manual is the default, so it is omitted from the friendly read.
    expect(readStep(doc, 'r', 'a')!.trigger).toBeUndefined();
  });

  it('clearing conditions removes them', () => {
    const doc = threeStepDoc();
    setStepConditions(doc, 'b', [
      { fromStep: 'a', field: 'x', is: 'isNotEmpty' },
    ]);
    expect(readStep(doc, 'r', 'b')!.runWhen).toBeDefined();
    setStepConditions(doc, 'b', []);
    expect(readStep(doc, 'r', 'b')!.runWhen).toBeUndefined();
  });

  it('updateFlowMeta changes title/goal only', () => {
    const doc = threeStepDoc();
    updateFlowMeta(doc, { title: 'Renamed', goal: 'new goal' });
    const flow = readFlowSpec(doc, 'r')!;
    expect(flow.title).toBe('Renamed');
    expect(flow.goal).toBe('new goal');
    expect(flow.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('edit: remove', () => {
  it('removes a leaf step and leaves siblings + their runtime intact', () => {
    const doc = threeStepDoc();
    setStepRuntime(doc, 'a', { state: 'completed', output: { claimId: 'k' } });

    removeStep(doc, 'r', 'c');

    const flow = readFlowSpec(doc, 'r')!;
    expect(flow.steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(flow.steps.find((s) => s.id === 'a')!.status?.state).toBe(
      'completed',
    );
    expect(flow.steps.find((s) => s.id === 'a')!.inputs).toEqual({
      x: 'a-value',
    });
  });

  it('rejects removing a referenced step, naming the referrers', () => {
    const doc = threeStepDoc();
    setStepInputs(doc, 'b', { y: '{{a.output.value}}' });
    expect(() => removeStep(doc, 'r', 'a')).toThrowError(/used by b/);
  });

  it('throws step_not_found for an unknown step', () => {
    const doc = threeStepDoc();
    expect(() => removeStep(doc, 'r', 'nope')).toThrowError(/No step "nope"/);
  });
});

describe('edit: reorder', () => {
  it('moves a step to a new index, preserving per-step state', () => {
    const doc = threeStepDoc();
    setStepRuntime(doc, 'c', { state: 'completed', output: { claimId: 'k' } });

    reorderStep(doc, 'c', 0);

    const flow = readFlowSpec(doc, 'r')!;
    expect(flow.steps.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(flow.steps[0]!.id).toBe('c');
    expect(flow.steps[0]!.status?.state).toBe('completed');
    expect(flow.steps[0]!.inputs).toEqual({ z: 'c-value' });
  });
});
