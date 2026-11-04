import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PluginTool } from '../plugin-api/types';
import { ActionProposalsPlugin } from './action-proposals/action-proposals.plugin';
import { HubActionsPlugin } from './hub-actions/hub-actions.plugin';
import { createOracleDocumentTools } from './memory/oracle-document-tools';
import { createTaskTools } from './tasks/tasks-tools';
import { createSetUserPreferencesTool } from './user-preferences/user-preferences-tool';

/**
 * A bound tool's definition is paid on every model call of the session.
 * These ceilings hold the trimmed definitions in the characters the model
 * reads: raise one only for text a model needs to choose or call the tool.
 * The Flow Builder's are in `flows/flows.plugin.test.ts` (workerd), the
 * chain tools' in `ixo-chain/ixo-chain.plugin.test.ts`.
 */
const CEILINGS: Record<string, number> = {
  add_oracle_document: 3_400,
  list_oracle_documents: 850,
  delete_oracle_document: 900,
  set_user_preferences: 1_800,
  request_hub_action: 4_800,
  prepare_action: 3_050,
  create_task: 1_000,
  preview_task: 2_000,
  update_task: 850,
};

function sizeOf(tool: PluginTool): number {
  return (
    JSON.stringify(z.toJSONSchema(tool.schema, { io: 'input' })).length +
    tool.description.length
  );
}

describe('tool definition budgets', () => {
  const tools = [
    ...createOracleDocumentTools(),
    createSetUserPreferencesTool(),
    ...new HubActionsPlugin().getTools(),
    ...new ActionProposalsPlugin().getTools(),
    ...createTaskTools(),
  ];

  it.each(Object.entries(CEILINGS))('%s stays small', (name, ceiling) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} missing`);
    expect(sizeOf(tool)).toBeLessThanOrEqual(ceiling);
  });
});
