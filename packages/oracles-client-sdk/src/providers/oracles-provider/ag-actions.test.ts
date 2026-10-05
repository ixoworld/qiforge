import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgAction } from '../../hooks/use-ag-action.js';
import { agentVisibleAgActions, upsertAgAction } from './ag-actions.js';

function action(name: string, exposeToAgent?: boolean): AgAction {
  return {
    name,
    description: `${name} action`,
    parameters: z.object({}),
    hasRender: false,
    ...(exposeToAgent === undefined ? {} : { exposeToAgent }),
  };
}

describe('agentVisibleAgActions', () => {
  it('leaves out an action registered with exposeToAgent: false, keeps the rest in order', () => {
    const registered = [
      action('create_data_table', true),
      action('sign_transaction', false),
      action('render_chart'),
    ];

    expect(agentVisibleAgActions(registered).map((a) => a.name)).toEqual([
      'create_data_table',
      'render_chart',
    ]);
  });

  it('treats an action without the flag as exposed (actions built before the flag existed)', () => {
    expect(agentVisibleAgActions([action('legacy')])).toHaveLength(1);
  });
});

describe('upsertAgAction', () => {
  it('appends a new action', () => {
    const next = upsertAgAction([action('a')], action('b'));
    expect(next.map((a) => a.name)).toEqual(['a', 'b']);
  });

  it('replaces an action of the same name in place, so re-registering can hide it', () => {
    const next = upsertAgAction(
      [action('a'), action('sign_transaction', true), action('c')],
      action('sign_transaction', false),
    );

    expect(next.map((a) => a.name)).toEqual(['a', 'sign_transaction', 'c']);
    expect(agentVisibleAgActions(next).map((a) => a.name)).toEqual(['a', 'c']);
  });
});
