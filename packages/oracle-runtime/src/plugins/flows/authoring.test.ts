import { describe, expect, it } from 'vitest';
import { getAllActions, typeToCan } from '@ixo/editor/core';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { isEventCapable } from './actions.js';
import { buildAuthoringTools } from './tools/authoring.js';
import { someActionType } from './test-support.js';
import type { PluginTool } from '../../plugin-api/types.js';

const ctx = makeRuntimeContext();

function validateFlowTool(): PluginTool {
  const tool = buildAuthoringTools(undefined).find(
    (t) => t.name === 'validate_flow',
  );
  if (!tool) throw new Error('validate_flow tool missing');
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
    const nonEvent = getAllActions().find(
      (a) => typeof typeToCan(a.type) === 'string' && !isEventCapable(a),
    );
    if (!nonEvent) {
      // Every action is event-capable in this registry — nothing to assert.
      return;
    }
    const result = await validate({
      title: 'Bad trigger',
      steps: [
        { id: 'src', action: nonEvent.type },
        {
          id: 'listener',
          action: nonEvent.type,
          onEvent: { fromStep: 'src', event: 'whatever' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cannot emit events/);
  });
});
