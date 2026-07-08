import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { flowSpecToBaseUcan } from './translator.js';
import { readFlowSpec } from './read.js';
import {
  hydrateFlowDoc,
  setStepRuntime,
  someActionType,
  someEventCapableActionType,
} from './test-support.js';
import type { FlowSpecInput } from './types.js';

function buildDoc(spec: FlowSpecInput) {
  const plan = flowSpecToBaseUcan(spec, {
    flowId: 'rt-flow',
    ownerDid: 'did:ixo:owner',
  });
  return hydrateFlowDoc(plan);
}

describe('readFlowSpec: multi-source round-trip', () => {
  it('recovers structure, inputs (incl. refs), and order from a hydrated doc', () => {
    const action = someActionType();
    const spec: FlowSpecInput = {
      title: 'Round trip',
      goal: 'prove the read recovers props the node map drops',
      steps: [
        { id: 'one', action, title: 'First', inputs: { name: 'alice' } },
        {
          id: 'two',
          action,
          inputs: { batches: '{{one.output.items}}', limit: 5 },
        },
      ],
    };
    const doc = buildDoc(spec);

    const flow = readFlowSpec(doc, 'room-123');
    expect(flow).not.toBeNull();
    expect(flow?.ref).toBe('room-123');
    expect(flow?.title).toBe('Round trip');
    expect(flow?.goal).toBe(spec.goal);
    expect(flow?.steps.map((s) => s.id)).toEqual(['one', 'two']);

    const [one, two] = flow!.steps;
    expect(one?.action).toBe(action);
    expect(one?.inputs).toEqual({ name: 'alice' });
    expect(two?.inputs).toEqual({ batches: '{{one.output.items}}', limit: 5 });

    // Status defaults to idle on a freshly-built flow.
    expect(one?.status?.state).toBe('idle');
    expect(two?.status?.state).toBe('idle');
  });

  it('reflects runtime status and computes blockedBy for a downstream referencing step', () => {
    const action = someActionType();
    const spec: FlowSpecInput = {
      title: 'Status flow',
      steps: [
        { id: 'one', action },
        { id: 'two', action, inputs: { ref: '{{one.output.value}}' } },
      ],
    };
    const doc = buildDoc(spec);

    setStepRuntime(doc, 'one', {
      state: 'failed',
      error: { message: 'boom', at: 123 },
    });

    const flow = readFlowSpec(doc, 'room-xyz');
    const one = flow?.steps.find((s) => s.id === 'one');
    const two = flow?.steps.find((s) => s.id === 'two');

    expect(one?.status?.state).toBe('failed');
    expect(one?.status?.error?.message).toBe('boom');
    // `two` references `one`, which failed -> blocked by `one`.
    expect(two?.status?.blockedBy).toContain('one');
  });

  it('reads onEvent back with the short step id however the compiler stored the source', () => {
    // The compiled `props.trigger` may carry the short step id (older editor)
    // or the prefixed block id (current editor remaps on compile); the
    // agent-facing read must return the short step id either way.
    const action = someEventCapableActionType();
    const doc = buildDoc({
      title: 'Event read',
      steps: [
        { id: 'support-form', action },
        {
          id: 'notify',
          action,
          onEvent: { fromStep: 'support-form', event: 'form.submitted' },
        },
      ],
    });

    const notify = readFlowSpec(doc, 'room-ev')?.steps.find(
      (s) => s.id === 'notify',
    );
    expect(notify?.onEvent).toEqual({
      fromStep: 'support-form',
      event: 'form.submitted',
    });
  });

  it('returns null for an empty doc', () => {
    expect(readFlowSpec(new Y.Doc(), 'room-empty')).toBeNull();
  });
});
