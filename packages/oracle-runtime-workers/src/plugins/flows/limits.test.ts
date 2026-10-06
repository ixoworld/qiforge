/**
 * The authoring size caps keep every single write well under the 64 KiB
 * Matrix event limit (matrix-crdt sends one batch as one base64 event).
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { toToolError } from './errors';
import { setStepInputs } from './edit';
import {
  MAX_FLOW_SPEC_BYTES,
  MAX_FLOW_STEPS,
  MAX_STEP_INPUTS_BYTES,
  jsonByteLength,
} from './input-policy';
import { hydrateFlowDoc, someActionType } from './test-support';
import { flowSpecToBaseUcan } from './translator';
import { flowSpecSchema, flowStepSchema, type FlowSpecInput } from './types';

/** Well under the homeserver's 65 536-byte event limit, leaving room for the envelope. */
const EVENT_BUDGET_BYTES = 48 * 1024;

function base64Length(bytes: Uint8Array): number {
  return Math.ceil(bytes.length / 3) * 4;
}

/** A flow at the step cap whose JSON is as close to the size cap as it gets. */
function largestFlow(): FlowSpecInput {
  const action = someActionType();
  const steps = Array.from({ length: MAX_FLOW_STEPS }, (_, i) => ({
    id: `step-${String(i).padStart(2, '0')}`,
    action,
    title: `Step ${i}`,
    inputs: { text: '' },
  }));
  const spec: FlowSpecInput = { title: 'Largest', steps };
  const spare = MAX_FLOW_SPEC_BYTES - jsonByteLength(spec) - 1;
  const perStep = Math.floor(spare / MAX_FLOW_STEPS);
  for (const step of steps) step.inputs.text = 'x'.repeat(perStep);
  return spec;
}

describe('authoring size caps', () => {
  it('accepts the largest flow, and its single write stays well under the event limit', () => {
    const spec = largestFlow();
    expect(flowSpecSchema.safeParse(spec).success).toBe(true);
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(spec, { flowId: 'largest', ownerDid: 'did:ixo:o' }),
    );
    expect(base64Length(Y.encodeStateAsUpdate(doc))).toBeLessThan(
      EVENT_BUDGET_BYTES,
    );
  });

  it('keeps the largest single-step inputs edit well under the event limit', () => {
    const doc = hydrateFlowDoc(
      flowSpecToBaseUcan(
        { title: 'One', steps: [{ id: 'a', action: someActionType() }] },
        { flowId: 'one' },
      ),
    );
    const before = Y.encodeStateVector(doc);
    const inputs = { text: 'x'.repeat(MAX_STEP_INPUTS_BYTES - 20) };
    setStepInputs(doc, 'a', inputs);
    expect(base64Length(Y.encodeStateAsUpdate(doc, before))).toBeLessThan(
      EVENT_BUDGET_BYTES,
    );
  });

  it('rejects one step too many with validation_failed naming the limit', () => {
    const action = someActionType();
    const result = flowSpecSchema.safeParse({
      title: 'Too many',
      steps: Array.from({ length: MAX_FLOW_STEPS + 1 }, (_, i) => ({
        id: `s${i}`,
        action,
      })),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(toToolError(result.error)).toMatchObject({
      ok: false,
      error: {
        code: 'validation_failed',
        message: expect.stringContaining(`at most ${MAX_FLOW_STEPS} steps`),
      },
    });
  });

  it('rejects an oversized flow with validation_failed naming the limit', () => {
    const spec = largestFlow();
    const first = spec.steps[0];
    if (first?.inputs)
      first.inputs.text = `${String(first.inputs.text)}${'y'.repeat(100)}`;
    const result = flowSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(toToolError(result.error).error.message).toContain(
      `at most ${MAX_FLOW_SPEC_BYTES} bytes`,
    );
  });

  it('rejects oversized step inputs naming the limit', () => {
    const result = flowStepSchema.safeParse({
      id: 'a',
      action: someActionType(),
      inputs: { text: 'x'.repeat(MAX_STEP_INPUTS_BYTES) },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(toToolError(result.error).error.message).toContain(
      `at most ${MAX_STEP_INPUTS_BYTES} bytes`,
    );
  });

  it('requires a DID for the assignee and a source for every condition', () => {
    const action = someActionType();
    expect(
      flowStepSchema.safeParse({ id: 'a', action, assignTo: 'alice' }).success,
    ).toBe(false);
    expect(
      flowStepSchema.safeParse({ id: 'a', action, assignTo: 'did:ixo:ixo1a' })
        .success,
    ).toBe(true);
    expect(
      flowStepSchema.safeParse({
        id: 'a',
        action,
        runWhen: { fromStep: 'b', field: 'x', is: 'isEmpty' },
      }).success,
    ).toBe(false);
  });

  it('refuses a step id that would break a {{step.output}} reference', () => {
    const action = someActionType();
    for (const id of ['has space', 'a{b', 'x'.repeat(65)])
      expect(flowStepSchema.safeParse({ id, action }).success).toBe(false);
  });
});

describe('authoring size caps count UTF-8 bytes', () => {
  // 3 bytes each in UTF-8, 1 UTF-16 unit each.
  const cjk = (n: number) => '漢'.repeat(n);
  // 4 bytes each in UTF-8, 2 UTF-16 units each.
  const emoji = (n: number) => '😀'.repeat(n);

  it.each([
    ['CJK', cjk(Math.floor(MAX_STEP_INPUTS_BYTES / 2))],
    ['emoji', emoji(Math.floor(MAX_STEP_INPUTS_BYTES / 3))],
  ])(
    'rejects %s inputs that fit the cap in characters but not in bytes',
    (_label, text) => {
      expect(text.length).toBeLessThan(MAX_STEP_INPUTS_BYTES);
      const result = flowStepSchema.safeParse({
        id: 'a',
        action: someActionType(),
        inputs: { text },
      });
      expect(result.success).toBe(false);
      const doc = hydrateFlowDoc(
        flowSpecToBaseUcan(
          { title: 'One', steps: [{ id: 'a', action: someActionType() }] },
          { flowId: 'one' },
        ),
      );
      expect(() => setStepInputs(doc, 'a', { text })).toThrowError(/at most/);
    },
  );

  it.each([
    ['CJK', '漢'],
    ['emoji', '😀'],
  ])(
    'keeps the largest accepted %s inputs edit well under the event limit',
    (_label, char) => {
      const doc = hydrateFlowDoc(
        flowSpecToBaseUcan(
          { title: 'One', steps: [{ id: 'a', action: someActionType() }] },
          { flowId: 'one' },
        ),
      );
      // Grow the value until the edit layer refuses it, keeping the last accepted size.
      let accepted = '';
      for (let n = 1; ; n += 64) {
        const candidate = char.repeat(n);
        try {
          flowStepSchema.parse({
            id: 'a',
            action: someActionType(),
            inputs: { text: candidate },
          });
        } catch {
          break;
        }
        accepted = candidate;
      }
      const before = Y.encodeStateVector(doc);
      setStepInputs(doc, 'a', { text: accepted });
      expect(base64Length(Y.encodeStateAsUpdate(doc, before))).toBeLessThan(
        EVENT_BUDGET_BYTES,
      );
    },
  );

  it.each([
    ['CJK', '漢'],
    ['emoji', '😀'],
  ])(
    'keeps the largest accepted %s flow well under the event limit',
    (_label, char) => {
      const action = someActionType();
      const build = (n: number): FlowSpecInput => ({
        title: 'Largest',
        steps: Array.from({ length: MAX_FLOW_STEPS }, (_, i) => ({
          id: `step-${i}`,
          action,
          inputs: { text: char.repeat(n) },
        })),
      });
      let accepted = build(0);
      for (let n = 1; ; n += 8) {
        const candidate = build(n);
        if (!flowSpecSchema.safeParse(candidate).success) break;
        accepted = candidate;
      }
      const doc = hydrateFlowDoc(
        flowSpecToBaseUcan(accepted, {
          flowId: 'largest',
          ownerDid: 'did:ixo:o',
        }),
      );
      expect(base64Length(Y.encodeStateAsUpdate(doc))).toBeLessThan(
        EVENT_BUDGET_BYTES,
      );
    },
  );
});
