import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import * as Y from 'yjs';
import { collectAllBlocks, extractBlockProperties } from './ydoc-helpers';
import { flowSpecToBaseUcan, stepIdToBlockId } from './translator';
import { readFlowSpec, readStep } from './read';
import {
  removeStep,
  reorderStep,
  setStepAssignment,
  setStepConditions,
  setStepSemanticGate,
  setStepConfirmation,
  setStepEventTrigger,
  setStepInputs,
  setStepPhase,
  setStepSchedule,
  setStepExecution,
  setStepSkills,
  setStepProps,
  setStepTrigger,
  updateFlowMeta,
} from './edit';
import { applyStepPatch, stepPatchSchema } from './tools/authoring';
import {
  hydrateFlowDoc,
  setStepRuntime,
  someActionType,
  someEventCapableActionType,
  someNonEventActionType,
} from './test-support';
import type { FlowSpecInput, FlowStepRead } from './types';

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

    const compiled = doc.getMap<Y.Map<unknown>>('qi.flow.nodes').get('b')!;
    expect(compiled.get('inputs')).toBe(
      JSON.stringify({
        y: 'changed',
        extra: { $ref: `${stepIdToBlockId('a')}.output.value` },
      }),
    );

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
  it('preserves a separate semantic gate without changing deterministic conditions', () => {
    const doc = threeStepDoc();
    const gate = {
      version: 1 as const,
      decision: 'flow.gate.semantic' as const,
      criterion: 'Meets requirements',
      rubric: 'Only supplied evidence',
      inputFields: ['evidence'],
    };
    setStepConditions(doc, 'b', [
      {
        source: 'configured_input',
        fromStep: 'a',
        field: 'x',
        is: 'equals',
        value: 'a-value',
      },
    ]);
    setStepSemanticGate(doc, 'b', gate);
    const compiled = doc.getMap<Y.Map<unknown>>('qi.flow.nodes').get('b')!;
    expect(compiled.get('semanticGate')).toBe(JSON.stringify(gate));
    const compiledProps = compiled.get('props');
    expect(
      compiledProps instanceof Y.Map ? compiledProps.toJSON() : compiledProps,
    ).toEqual(expect.objectContaining({ semanticGate: JSON.stringify(gate) }));
    expect(JSON.parse(String(compiled.get('conditions')))).toEqual(
      expect.objectContaining({
        conditions: expect.arrayContaining([
          expect.objectContaining({ source: 'configured_input' }),
        ]),
      }),
    );
    expect(readStep(doc, 'r', 'b')?.semanticGate).toEqual(gate);
    expect(readStep(doc, 'r', 'b')?.runWhen?.source).toBe('configured_input');
    setStepSemanticGate(doc, 'b', undefined);
    expect(compiled.get('semanticGate')).toBe('');
    expect(readStep(doc, 'r', 'b')?.semanticGate).toBeUndefined();
    expect(readStep(doc, 'r', 'b')?.runWhen?.source).toBe('configured_input');
  });
  it('conditions are written in the evaluator vocabulary and round-trip', () => {
    const doc = threeStepDoc();
    setStepConditions(doc, 'b', [
      {
        source: 'runtime_output',
        fromStep: 'a',
        field: 'decision',
        is: 'equals',
        value: 'approved',
      },
    ]);

    const step = readStep(doc, 'r', 'b')!;
    expect(step.runWhen).toEqual({
      source: 'runtime_output',
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

  it('phase edits round-trip without changing sibling steps', () => {
    const doc = threeStepDoc();
    setStepPhase(doc, 'b', 'validation');

    const flow = readFlowSpec(doc, 'r')!;
    expect(flow.steps.find((step) => step.id === 'b')?.phase).toBe(
      'validation',
    );
    expect(flow.steps.find((step) => step.id === 'a')?.phase).toBeUndefined();

    setStepPhase(doc, 'b', undefined);
    expect(readStep(doc, 'r', 'b')?.phase).toBeUndefined();
  });

  it('execution and governed skill metadata round-trip', () => {
    const doc = threeStepDoc();
    setStepExecution(doc, 'b', 'human-only');
    setStepSkills(doc, 'b', ['assessment-review', 'evidence-check']);

    const step = readStep(doc, 'r', 'b');
    expect(step?.execution).toBe('human-only');
    expect(step?.skills).toEqual(['assessment-review', 'evidence-check']);
  });

  it('trigger round-trips flow-start and clears back to the manual default', () => {
    const doc = threeStepDoc();
    setStepTrigger(doc, 'a', 'flow-start');
    expect(readStep(doc, 'r', 'a')!.trigger).toBe('flow-start');
    setStepTrigger(doc, 'a', 'manual');
    // manual is the default, so it is omitted from the friendly read.
    expect(readStep(doc, 'r', 'a')!.trigger).toBeUndefined();
  });

  it('event trigger stores the block id on the block but reads back as the short step id', () => {
    const action = someEventCapableActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'Event flow',
          steps: [
            { id: 'support-form', action },
            { id: 'notify', action },
          ],
        },
        { flowId: 'event-flow' },
      ),
    );

    setStepEventTrigger(doc, 'notify', {
      fromStep: 'support-form',
      event: 'form.submitted',
    });

    // Stored block props carry the PREFIXED block id — the FE reconciler
    // matches trigger.sourceBlockId against the source block's real `.id`.
    const block = collectAllBlocks(doc.getXmlFragment('document')).find(
      (b) => b.id === stepIdToBlockId('notify'),
    )!;
    const props = extractBlockProperties(block);
    expect(props.trigger).toBe(
      JSON.stringify({
        type: 'block.event',
        sourceBlockId: stepIdToBlockId('support-form'),
        eventName: 'form.submitted',
      }),
    );
    expect(props.triggerMode).toBe('block.event');

    // ...but the agent-facing read maps it back to the short step id.
    expect(readStep(doc, 'r', 'notify')!.onEvent).toEqual({
      fromStep: 'support-form',
      event: 'form.submitted',
    });

    // Resetting the trigger to manual clears the event trigger.
    setStepTrigger(doc, 'notify', 'manual');
    const cleared = readStep(doc, 'r', 'notify')!;
    expect(cleared.onEvent).toBeUndefined();
    expect(cleared.trigger).toBeUndefined();
  });

  it('event trigger rejects an unknown source step', () => {
    const doc = threeStepDoc();
    expect(() =>
      setStepEventTrigger(doc, 'b', { fromStep: 'nope', event: 'x' }),
    ).toThrowError(/No step "nope"/);
  });

  it('event trigger rejects an already-prefixed block id', () => {
    const doc = threeStepDoc();
    expect(() =>
      setStepEventTrigger(doc, 'b', {
        fromStep: 'flow_block_a',
        event: 'x',
      }),
    ).toThrowError(/short step id/);
  });

  it('event trigger rejects a non-event-capable source action', () => {
    const action = someNonEventActionType();
    if (!action) {
      // Every action is event-capable in this registry — nothing to assert.
      return;
    }
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'No events',
          steps: [
            { id: 'src', action },
            { id: 'dst', action },
          ],
        },
        { flowId: 'no-events' },
      ),
    );
    expect(() =>
      setStepEventTrigger(doc, 'dst', { fromStep: 'src', event: 'whatever' }),
    ).toThrowError(/cannot emit events/);
  });

  it('clearing conditions removes them', () => {
    const doc = threeStepDoc();
    setStepConditions(doc, 'b', [
      { source: 'runtime_output', fromStep: 'a', field: 'x', is: 'isNotEmpty' },
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

describe('edit: update_step patches', () => {
  const gate = {
    version: 1 as const,
    decision: 'flow.gate.semantic' as const,
    criterion: 'Meets requirements',
    rubric: 'Only supplied evidence',
    inputFields: ['evidence'],
  };

  it('clears a semantic gate with null on the block and the compiled node', () => {
    const doc = threeStepDoc();
    applyStepPatch(doc, 'b', stepPatchSchema.parse({ semanticGate: gate }));
    expect(readStep(doc, 'r', 'b')?.semanticGate).toEqual(gate);

    applyStepPatch(doc, 'b', stepPatchSchema.parse({ semanticGate: null }));

    const compiled = doc.getMap<Y.Map<unknown>>('qi.flow.nodes').get('b')!;
    expect(compiled.get('semanticGate')).toBe('');
    const compiledProps = compiled.get('props');
    expect(
      compiledProps instanceof Y.Map ? compiledProps.toJSON() : compiledProps,
    ).toEqual(expect.objectContaining({ semanticGate: '' }));
    expect(readStep(doc, 'r', 'b')?.semanticGate).toBeUndefined();
  });

  it('keeps a semantic gate when the patch omits it', () => {
    const doc = threeStepDoc();
    applyStepPatch(doc, 'b', stepPatchSchema.parse({ semanticGate: gate }));
    applyStepPatch(doc, 'b', stepPatchSchema.parse({ assignTo: 'did:ixo:x' }));
    expect(readStep(doc, 'r', 'b')?.semanticGate).toEqual(gate);
  });

  it('accepts a read step, including an untagged stored condition, as update input', () => {
    expectTypeOf<FlowStepRead>().toExtend<z.input<typeof stepPatchSchema>>();
    const doc = threeStepDoc();
    const legacy = JSON.stringify({
      enabled: true,
      mode: 'all_must_pass',
      conditions: [
        {
          id: 'cond_a_x',
          name: 'Condition from a',
          sourceBlockId: stepIdToBlockId('a'),
          sourceBlockType: 'action',
          rule: {
            type: 'property_value',
            property: 'x',
            operator: 'is_not_empty',
          },
          effect: { action: 'enable' },
        },
      ],
    });
    setStepProps(doc, 'b', { conditions: legacy });
    const read = readStep(doc, 'r', 'b');
    expect(read?.runWhen?.source).toBe('runtime_output');
    const patch = stepPatchSchema.safeParse(read);
    expect(patch.success).toBe(true);
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

function stepBlockOrder(doc: Y.Doc): string[] {
  return collectAllBlocks(doc.getXmlFragment('document'))
    .map((b) => b.id)
    .filter((id) => id.startsWith('flow_block_'))
    .map((id) => id.slice('flow_block_'.length));
}

function orderOf(doc: Y.Doc): string[] {
  return doc.getArray<string>('qi.flow.order').toArray();
}

describe('edit: remove_step edges and referrers', () => {
  it('deletes the removed step’s edges (stored as Y.Maps)', () => {
    // Both ends event-capable: the compiler requires it of a trigger target too.
    const action = someEventCapableActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'Edges',
          steps: [
            { id: 'src', action },
            {
              id: 'dst',
              action,
              onEvent: { fromStep: 'src', event: 'step.completed' },
            },
          ],
        },
        { flowId: 'edges' },
      ),
    );
    const edges = doc.getMap('qi.flow.edges');
    // Only meaningful if the compiler wrote a trigger edge for the onEvent.
    const before = [...edges.values()].filter(
      (e) => e instanceof Y.Map && e.get('source') === 'src',
    );
    expect(before.length).toBeGreaterThan(0);

    // `dst` references `src` through its trigger, so remove `dst` first.
    removeStep(doc, 'r', 'dst');
    expect(
      [...edges.values()].filter(
        (e) =>
          e instanceof Y.Map &&
          (e.get('source') === 'dst' || e.get('target') === 'dst'),
      ),
    ).toEqual([]);
  });

  it('blocks removal when the only reference is nested inside a map', () => {
    const doc = threeStepDoc();
    setStepInputs(doc, 'c', {
      variables: { name: 'Dear {{a.output.name}}' },
    });
    expect(() => removeStep(doc, 'r', 'a')).toThrowError(/used by c/);
    expect(readStep(doc, 'r', 'a')).not.toBeNull();
  });

  it('accepts a step id with regex metacharacters', () => {
    const action = someActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'Ids',
          steps: [
            { id: 'a(b', action },
            { id: 'aXb', action, inputs: { v: '{{aXb.output.z}}' } },
          ],
        },
        { flowId: 'ids' },
      ),
    );
    // "a.b"-style regex reading would treat other ids as matches; this must not throw.
    expect(() => removeStep(doc, 'r', 'a(b')).not.toThrow();
    expect(orderOf(doc)).toEqual(['aXb']);
  });

  it.each(['a', 'c'])('removes the %s (first/last) step cleanly', (id) => {
    const doc = threeStepDoc();
    removeStep(doc, 'r', id);
    expect(orderOf(doc)).toEqual(['a', 'b', 'c'].filter((s) => s !== id));
    expect(stepBlockOrder(doc)).toEqual(orderOf(doc));
    expect(doc.getMap('runtime').has(stepIdToBlockId(id))).toBe(false);
  });

  it('removes the only step, leaving an empty flow', () => {
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        { title: 'One', steps: [{ id: 'only', action: someActionType() }] },
        { flowId: 'one' },
      ),
    );
    removeStep(doc, 'r', 'only');
    expect(orderOf(doc)).toEqual([]);
    expect(stepBlockOrder(doc)).toEqual([]);
    expect(readFlowSpec(doc, 'r')).toBeNull();
  });
});

describe('edit: reorder_step keeps the document in step with the order', () => {
  function withLeadingParagraph(): Y.Doc {
    const doc = threeStepDoc();
    const group = doc.getXmlFragment('document').get(0);
    if (!(group instanceof Y.XmlElement)) throw new Error('no block group');
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', 'intro');
    container.insert(0, [new Y.XmlElement('paragraph')]);
    group.insert(0, [container]);
    return doc;
  }

  it.each([
    ['a', 2, ['b', 'c', 'a']],
    ['c', 0, ['c', 'a', 'b']],
    ['b', 0, ['b', 'a', 'c']],
    ['a', 1, ['b', 'a', 'c']],
  ] as const)(
    'moves %s to %i with a leading paragraph',
    (id, toIndex, expected) => {
      const doc = withLeadingParagraph();
      reorderStep(doc, id, toIndex);
      expect(orderOf(doc)).toEqual(expected);
      expect(stepBlockOrder(doc)).toEqual(expected);
      // The paragraph stays first.
      expect(collectAllBlocks(doc.getXmlFragment('document'))[0]?.id).toBe(
        'intro',
      );
    },
  );

  it('keeps a moved step’s props', () => {
    const doc = threeStepDoc();
    reorderStep(doc, 'b', 2);
    expect(readStep(doc, 'r', 'b')?.inputs).toEqual({ y: 'b-value' });
  });

  it('is a no-op for the only step', () => {
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        { title: 'One', steps: [{ id: 'only', action: someActionType() }] },
        { flowId: 'one' },
      ),
    );
    reorderStep(doc, 'only', 5);
    expect(orderOf(doc)).toEqual(['only']);
  });
});

describe('edit: input and assignment rules', () => {
  it('refuses literal PIN and mnemonic values at any depth', () => {
    const doc = threeStepDoc();
    for (const inputs of [
      { pin: '1234' },
      { Mnemonic: 'abandon abandon' },
      { nested: { pin: 1234 } },
      { list: [{ mnemonic: 'x' }] },
    ]) {
      expect(() => setStepInputs(doc, 'a', inputs)).toThrowError(
        /Refusing to store a secret/,
      );
    }
    expect(readStep(doc, 'r', 'a')?.inputs).toEqual({ x: 'a-value' });
    setStepInputs(doc, 'a', { pin: '{{b.output.pin}}', mnemonic: '' });
    expect(readStep(doc, 'r', 'a')?.inputs).toEqual({
      pin: '{{b.output.pin}}',
      mnemonic: '',
    });
  });

  it('refuses inputs over the size cap', () => {
    const doc = threeStepDoc();
    expect(() =>
      setStepInputs(doc, 'a', { big: 'x'.repeat(9_000) }),
    ).toThrowError(/at most 8000 bytes/);
  });

  it('refuses an assignee that is not a DID', () => {
    const doc = threeStepDoc();
    expect(() => setStepAssignment(doc, 'a', 'bob')).toThrowError(/not a DID/);
    setStepAssignment(doc, 'a', 'did:ixo:ixo1bob');
    expect(readStep(doc, 'r', 'a')?.assignTo).toBe('did:ixo:ixo1bob');
  });

  it('refuses a condition on a step the flow does not have', () => {
    const doc = threeStepDoc();
    expect(() =>
      setStepConditions(doc, 'b', [
        {
          source: 'runtime_output',
          fromStep: 'ghost',
          field: 'x',
          is: 'isEmpty',
        },
      ]),
    ).toThrowError(/No step "ghost"/);
  });
});

describe('edit: concurrent edits to the same step', () => {
  function sync(from: Y.Doc, to: Y.Doc): void {
    Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
  }

  it('merges different settings made on two replicas', () => {
    const left = threeStepDoc();
    const right = new Y.Doc();
    sync(left, right);

    setStepInputs(left, 'b', { y: 'from-left' });
    setStepSchedule(right, 'b', { at: '2030-01-01' });
    setStepAssignment(right, 'b', 'did:ixo:ixo1right');
    sync(left, right);
    sync(right, left);

    for (const doc of [left, right]) {
      expect(readStep(doc, 'r', 'b')).toMatchObject({
        inputs: { y: 'from-left' },
        due: { at: '2030-01-01' },
        assignTo: 'did:ixo:ixo1right',
      });
    }
  });

  it('converges on one value when both replicas set the same setting', () => {
    const left = threeStepDoc();
    const right = new Y.Doc();
    sync(left, right);

    setStepInputs(left, 'b', { y: 'left' });
    setStepInputs(right, 'b', { y: 'right' });
    sync(left, right);
    sync(right, left);

    const l = readStep(left, 'r', 'b')?.inputs;
    expect(readStep(right, 'r', 'b')?.inputs).toEqual(l);
    expect(['left', 'right']).toContain(l?.y);
  });
});
