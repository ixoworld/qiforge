import { getAllActions } from '@ixo/editor/core';
import { describe, expect, it } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { ACTION_METADATA } from './action-metadata';
import { actionCategory, listActions } from './actions';
import { FLOWS_OPERATING_GUIDE } from './prompts';
import { requirements } from './linkage';
import { someEventCapableActionType, someActionType } from './test-support';
import { buildAuthoringTools } from './tools/authoring';

describe('action catalogue', () => {
  it('has a metadata entry for every registry action', () => {
    const missing = getAllActions()
      .map((a) => a.type)
      .filter((type) => !ACTION_METADATA[type]?.summary);
    expect(missing).toEqual([]);
  });

  it("marks an input required only when the registry's schema does", () => {
    const mismatches: string[] = [];
    for (const def of getAllActions()) {
      const schema = def.inputSchema;
      const properties: unknown =
        schema && 'properties' in schema ? schema.properties : undefined;
      const required: unknown =
        schema && 'required' in schema ? schema.required : undefined;
      if (!properties || typeof properties !== 'object') continue;
      const requiredSet = new Set(Array.isArray(required) ? required : []);
      for (const port of ACTION_METADATA[def.type]?.inputPorts ?? []) {
        if (!(port.path in properties)) continue;
        if (Boolean(port.required) !== requiredSet.has(port.path))
          mismatches.push(`${def.type}.${port.path}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('filters list_actions by category', () => {
    const claims = listActions({ category: 'claim' });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((a) => a.action.startsWith('qi/claim.'))).toBe(true);
    expect(claims.every((a) => a.category === 'claim')).toBe(true);
    expect(listActions({ category: 'no-such-category' })).toEqual([]);
    expect(listActions().length).toBe(getAllActions().length);
  });

  it('derives the category from the action name', () => {
    expect(actionCategory('qi/governance.transaction.send-funds')).toBe(
      'governance',
    );
    expect(actionCategory('oracle')).toBe('oracle');
  });

  it('never tells the agent to ask the user for a PIN', () => {
    for (const def of getAllActions()) {
      for (const req of requirements(def.type)) {
        if (req.kind !== 'pin') continue;
        expect(req.description).not.toMatch(/ask the user/i);
        expect(req.description).toMatch(/portal/);
      }
    }
    expect(FLOWS_OPERATING_GUIDE).not.toMatch(/endpoints, PINs/);
    expect(FLOWS_OPERATING_GUIDE).toMatch(/never ask for a PIN/);
  });
});

describe('validate_flow', () => {
  const validate = buildAuthoringTools(undefined).find(
    (t) => t.name === 'validate_flow',
  )!;

  it('reports a condition on a step the flow does not have', async () => {
    const result = await validate.handler(
      {
        flow: {
          title: 'T',
          steps: [
            {
              id: 'a',
              action: someActionType(),
              runWhen: {
                source: 'runtime_output',
                fromStep: 'ghost',
                field: 'x',
                is: 'isEmpty',
              },
            },
          ],
        },
      },
      makeRuntimeContext(),
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('unknown step "ghost"')],
    });
  });

  it('reports an auto-trigger cycle', async () => {
    const action = someEventCapableActionType();
    const result = await validate.handler(
      {
        flow: {
          title: 'T',
          steps: [
            {
              id: 'a',
              action,
              onEvent: { fromStep: 'b', event: 'step.completed' },
            },
            {
              id: 'b',
              action,
              onEvent: { fromStep: 'a', event: 'step.completed' },
            },
          ],
        },
      },
      makeRuntimeContext(),
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { errors: string[] }).errors.join(' ')).toMatch(/cycle/i);
  });

  it('rejects a condition without a source as validation_failed', async () => {
    const result = await validate.handler(
      {
        flow: {
          title: 'T',
          steps: [
            {
              id: 'a',
              action: someActionType(),
              runWhen: { fromStep: 'a', field: 'x', is: 'isEmpty' },
            },
          ],
        },
      },
      makeRuntimeContext(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
  });
});
