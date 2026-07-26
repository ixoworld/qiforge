import { describe, expect, it } from 'vitest';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { readStep } from './read.js';
import { flowSpecToBaseUcan } from './translator.js';
import { applyStepPatch, buildAuthoringTools } from './tools/authoring.js';
import {
  hydrateFlowDoc,
  someActionType,
  someEventCapableActionType,
  someNonEventActionType,
} from './test-support.js';
import type { PluginTool } from '../../plugin-api/types.js';

const ctx = makeRuntimeContext();

function validateFlowTool(): PluginTool {
  const tool = buildAuthoringTools(undefined).find(
    (t) => t.name === 'validate_flow',
  );
  if (!tool) throw new Error('validate_flow tool missing');
  return tool;
}

function updateStepTool(): PluginTool {
  const tool = buildAuthoringTools(undefined).find(
    (t) => t.name === 'update_step',
  );
  if (!tool) throw new Error('update_step tool missing');
  return tool;
}

async function validate(
  flow: unknown,
): Promise<{ ok: boolean; errors: string[] }> {
  const result = await validateFlowTool().handler({ flow }, ctx);
  return result as { ok: boolean; errors: string[] };
}

describe('validate_flow', () => {
  it('accepts a valid flow', async () => {
    const action = someActionType();
    const result = await validate({
      title: 'Valid',
      steps: [
        { id: 'one', action },
        { id: 'two', action, after: ['one'] },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an unknown action with a clear message', async () => {
    const result = await validate({
      title: 'Bad',
      steps: [{ id: 'one', action: 'definitely/not-real' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/[Uu]nknown action/);
  });

  it('rejects a duplicate step id with the compiler message', async () => {
    const action = someActionType();
    const result = await validate({
      title: 'Dup',
      steps: [
        { id: 'same', action },
        { id: 'same', action },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/[Dd]uplicate/);
  });

  it('rejects onEvent on a non-event-capable upstream action', async () => {
    const nonEvent = someNonEventActionType();
    if (!nonEvent) {
      // Every action is event-capable in this registry — nothing to assert.
      return;
    }
    const result = await validate({
      title: 'Bad trigger',
      steps: [
        { id: 'src', action: nonEvent },
        {
          id: 'listener',
          action: nonEvent,
          onEvent: { fromStep: 'src', event: 'whatever' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cannot emit events/);
  });
});

describe('update_step patch routing', () => {
  function twoStepDoc() {
    const action = someEventCapableActionType();
    return hydrateFlowDoc(
      flowSpecToBaseUcan(
        {
          title: 'Patch flow',
          steps: [
            { id: 'support-form', action },
            { id: 'notify', action },
          ],
        },
        { flowId: 'patch-flow' },
      ),
    );
  }

  it('routes onEvent to the event-trigger write; reads back with short ids', () => {
    const doc = twoStepDoc();
    applyStepPatch(doc, 'notify', {
      onEvent: { fromStep: 'support-form', event: 'form.submitted' },
    });
    expect(readStep(doc, 'r', 'notify')?.onEvent).toEqual({
      fromStep: 'support-form',
      event: 'form.submitted',
    });
  });

  it('routes trigger, and onEvent wins when both are set', () => {
    const doc = twoStepDoc();
    applyStepPatch(doc, 'notify', { trigger: 'flow-start' });
    expect(readStep(doc, 'r', 'notify')?.trigger).toBe('flow-start');

    applyStepPatch(doc, 'notify', {
      trigger: 'flow-start',
      onEvent: { fromStep: 'support-form', event: 'form.submitted' },
    });
    const patched = readStep(doc, 'r', 'notify');
    expect(patched?.onEvent).toEqual({
      fromStep: 'support-form',
      event: 'form.submitted',
    });
    expect(patched?.trigger).toBeUndefined();

    // trigger: "manual" clears the event trigger back to the default.
    applyStepPatch(doc, 'notify', { trigger: 'manual' });
    const cleared = readStep(doc, 'r', 'notify');
    expect(cleared?.onEvent).toBeUndefined();
    expect(cleared?.trigger).toBeUndefined();
  });

  it('routes phase updates and explicit clearing through the friendly FlowSpec patch', () => {
    const doc = twoStepDoc();
    applyStepPatch(doc, 'notify', { phase: 'deployment' });
    expect(readStep(doc, 'r', 'notify')?.phase).toBe('deployment');

    expect(() =>
      updateStepTool().schema.parse({
        stepId: 'notify',
        patch: { phase: null },
      }),
    ).not.toThrow();
    applyStepPatch(doc, 'notify', { phase: null });
    expect(readStep(doc, 'r', 'notify')?.phase).toBeUndefined();
  });

  it('routes execution boundaries and governed skill requirements', () => {
    const doc = twoStepDoc();
    applyStepPatch(doc, 'notify', {
      execution: 'agent-capable',
      skills: ['send-provider-update'],
    });
    expect(readStep(doc, 'r', 'notify')).toMatchObject({
      execution: 'agent-capable',
      skills: ['send-provider-update'],
    });
  });
});
