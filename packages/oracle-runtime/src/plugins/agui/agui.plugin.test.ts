import { describe, expect, it, vi } from 'vitest';
import { callAgAction, logActionToMatrix } from '@ixo/common';
import { validateManifest } from '../../manifest/validator.js';
import type { AgAction } from '../../graph/state.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { AGUIPlugin } from './agui.plugin.js';

const TABLE_ACTION: AgAction = {
  name: 'create_data_table',
  description: 'Render an interactive data table in the user’s browser.',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      data: { type: 'array' },
    },
    required: ['id', 'title', 'data'],
  },
};

const CHART_ACTION: AgAction = {
  name: 'create_revenue_chart',
  description: 'Render an interactive revenue chart.',
  schema: { type: 'object', properties: {}, required: [] },
};

vi.mock('@ixo/common', () => ({
  callAgAction: vi.fn(async () => ({ ok: true })),
  logActionToMatrix: vi.fn(),
}));

describe('AGUIPlugin', () => {
  it('has the expected name, version, and manifest, and the manifest passes validation', () => {
    const plugin = new AGUIPlugin();
    expect(plugin.name).toBe('agui');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('AG-UI');
    expect(plugin.manifest.visibility).toBe('always');
    expect(plugin.manifest.category).toBe('ui');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('uses only the request-time builder (no boot-time getSubAgents / getTools)', () => {
    const plugin = new AGUIPlugin();
    expect(plugin.getSubAgents).toBeUndefined();
    expect(plugin.getTools).toBeUndefined();
    expect(typeof plugin.getRequestSubAgents).toBe('function');
  });

  it('returns no sub-agents when state.agActions is empty or absent', async () => {
    const plugin = new AGUIPlugin();

    const emptyArrayCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], agActions: [] },
      },
    });
    await expect(plugin.getRequestSubAgents(emptyArrayCtx)).resolves.toEqual(
      [],
    );

    const missingCtx = makeRuntimeContext();
    await expect(plugin.getRequestSubAgents(missingCtx)).resolves.toEqual([]);
  });

  it('builds one sub-agent with one PluginTool per agAction, model=subagent, and the tool docs in the prompt', async () => {
    const plugin = new AGUIPlugin();
    const rtCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], agActions: [TABLE_ACTION, CHART_ACTION] },
      },
    });

    const subAgents = await plugin.getRequestSubAgents(rtCtx);
    expect(subAgents).toHaveLength(1);

    const [sub] = subAgents;
    if (!sub) throw new Error('expected one sub-agent');
    expect(sub.name).toBe('AG-UI Agent');
    expect(sub.model).toBe('subagent');

    const tools = Array.isArray(sub.tools) ? sub.tools : [];
    expect(tools.map((t) => t.name)).toEqual([
      TABLE_ACTION.name,
      CHART_ACTION.name,
    ]);
    expect(tools[0]?.description).toBe(TABLE_ACTION.description);

    const prompt =
      typeof sub.systemPrompt === 'string' ? sub.systemPrompt : '';
    expect(prompt).toContain('AG-UI Agent');
    expect(prompt).toContain(TABLE_ACTION.name);
    expect(prompt).toContain(CHART_ACTION.name);
  });

  it('action tool handler dispatches via callAgAction with the session id and tags args + roomId logging', async () => {
    const callAgActionMock = vi.mocked(callAgAction);
    const logActionToMatrixMock = vi.mocked(logActionToMatrix);
    callAgActionMock.mockClear();
    logActionToMatrixMock.mockClear();
    callAgActionMock.mockResolvedValueOnce({ rendered: true });

    const plugin = new AGUIPlugin();
    const rtCtx = makeRuntimeContext({
      session: {
        id: 'sess-xyz',
        client: 'portal',
        requestId: 'req-7',
        roomId: '!room:ixo.world',
      },
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], agActions: [TABLE_ACTION] },
      },
    });

    const [sub] = await plugin.getRequestSubAgents(rtCtx);
    if (!sub) throw new Error('expected one sub-agent');
    const tools = Array.isArray(sub.tools) ? sub.tools : [];
    const [actionTool] = tools;
    if (!actionTool) throw new Error('expected one tool');

    const args = { id: 'fruits', title: 'Fruits', data: [] };
    const result = await actionTool.handler(args, rtCtx);

    expect(result).toBe(JSON.stringify({ rendered: true }));
    expect(callAgActionMock).toHaveBeenCalledTimes(1);
    const callArgs = callAgActionMock.mock.calls[0]?.[0];
    expect(callArgs?.sessionId).toBe('sess-xyz');
    expect(callArgs?.toolName).toBe(TABLE_ACTION.name);
    expect(callArgs?.args).toEqual(args);
    expect(callArgs?.timeout).toBe(15_000);
    expect(callArgs?.toolCallId).toMatch(/^ag_req-7_[a-f0-9]{8}$/);

    expect(logActionToMatrixMock).toHaveBeenCalledTimes(1);
    expect(logActionToMatrixMock.mock.calls[0]?.[1]).toEqual({
      roomId: '!room:ixo.world',
      threadId: 'sess-xyz',
    });
  });
});
