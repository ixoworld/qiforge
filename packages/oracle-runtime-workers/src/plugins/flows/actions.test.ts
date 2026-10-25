import { generateActionManifest, getAllActions } from '@ixo/editor/core';
import { describe, expect, it } from 'vitest';
import { makeRuntimeContext } from '../../core/test-fixtures';
import { ACTION_METADATA } from './action-metadata';
import { actionCategory, describeAction, listActions } from './actions';
import { FLOWS_OPERATING_GUIDE } from './prompts';
import { requirements } from './linkage';
import { someEventCapableActionType, someActionType } from './test-support';
import { buildAuthoringTools } from './tools/authoring';
import { buildListActionsTool } from './tools/discovery';

describe('action catalogue', () => {
  it('identifies the exact installed catalog contract in tool responses', async () => {
    const manifest = generateActionManifest();
    expect(
      await buildListActionsTool().handler(
        { tag: 'wallet' },
        makeRuntimeContext(),
      ),
    ).toMatchObject({
      registryVersion: manifest.registryVersion,
      manifestDigest: manifest.manifestDigest,
    });
  });
  it('discovers every authorable registry action by its category tag with a useful description', () => {
    for (const action of getAllActions().filter(
      (action) => !action.hiddenFromAuthoring,
    )) {
      expect(
        listActions({ tag: actionCategory(action.type) }).some(
          (entry) => entry.action === action.type,
        ),
      ).toBe(true);
      expect(describeAction(action.type)?.summary).toBeTruthy();
      expect(describeAction(action.type)?.inputsDeclared).toBe(true);
    }
  });

  it('exposes wallet balance output and the complete transfer inputs', () => {
    expect(describeAction('qi/wallet.balance')).toMatchObject({
      requiredServices: ['wallet'],
      sideEffect: false,
    });
    expect(
      describeAction('qi/wallet.balance')?.outputs.map((field) => field.name),
    ).toContain('amount');
    const transfer = describeAction('qi/wallet.fund');
    expect(transfer?.inputs.map((field) => field.name)).toEqual(
      expect.arrayContaining(['address', 'amount', 'denom', 'fromAddress']),
    );
    expect(
      transfer?.inputs.find((field) => field.name === 'amount')?.type,
    ).toBe('number | string');
    expect(transfer?.requiresConfirmation).toBe(true);
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
    expect(listActions().length).toBe(
      getAllActions().filter((action) => !action.hiddenFromAuthoring).length,
    );
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
