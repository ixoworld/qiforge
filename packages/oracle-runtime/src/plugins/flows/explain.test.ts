import { describe, expect, it } from 'vitest';
import { flowSpecToBaseUcan } from './translator.js';
import { explainStep } from './explain.js';
import { hydrateFlowDoc, someActionType } from './test-support.js';

describe('explainStep', () => {
  it('describes a step, its inputs, and its status', () => {
    const action = someActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'X',
          steps: [
            { id: 'one', action, inputs: { a: 1, ref: '{{x.output.y}}' } },
          ],
        },
        { flowId: 'f' },
      ),
    );
    const explanation = explainStep(doc, 'r', 'one');
    expect(explanation).not.toBeNull();
    expect(explanation!.action).toBe(action);
    expect(explanation!.inputs).toEqual({ a: 1, ref: '{{x.output.y}}' });
    expect(typeof explanation!.willDo).toBe('string');
    expect(explanation!.willDo.length).toBeGreaterThan(0);
    expect(explanation!.status?.state).toBe('idle');
  });

  it('returns null for an unknown step', () => {
    const action = someActionType();
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        { title: 'X', steps: [{ id: 'one', action }] },
        { flowId: 'f' },
      ),
    );
    expect(explainStep(doc, 'r', 'nope')).toBeNull();
  });
});
