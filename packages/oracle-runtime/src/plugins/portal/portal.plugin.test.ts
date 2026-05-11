import { callBrowserTool, logActionToMatrix } from '@ixo/common';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserToolCall } from '../../graph/state.js';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { PortalPlugin } from './portal.plugin.js';

const OPEN_URL_TOOL: BrowserToolCall = {
  name: 'open_url',
  description: 'Open a URL in the user’s active browser tab.',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      newTab: { type: 'boolean' },
    },
    required: ['url'],
  },
};

const CLICK_TOOL: BrowserToolCall = {
  name: 'click_element',
  description: 'Click a DOM element by selector.',
  schema: {
    type: 'object',
    properties: { selector: { type: 'string' } },
    required: ['selector'],
  },
};

vi.mock('@ixo/common', () => ({
  callBrowserTool: vi.fn(async () => ({ ok: true })),
  logActionToMatrix: vi.fn(),
}));

describe('PortalPlugin', () => {
  it('has the expected name, version, and manifest, and the manifest passes validation', () => {
    const plugin = new PortalPlugin();
    expect(plugin.name).toBe('portal');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.manifest.title).toBe('Portal');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.category).toBe('ui');
    expect(plugin.manifest.stability).toBe('stable');
    expect(plugin.manifest.whenToUse.length).toBeGreaterThan(0);

    const result = validateManifest(plugin.manifest, plugin.name);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('uses only the request-time sub-agent builder (no boot-time getSubAgents / getTools)', () => {
    const plugin = new PortalPlugin();
    expect(plugin.getSubAgents).toBeUndefined();
    expect(plugin.getTools).toBeUndefined();
    expect(typeof plugin.getRequestSubAgents).toBe('function');
  });

  it('returns no sub-agents when state.browserTools is empty or absent', async () => {
    const plugin = new PortalPlugin();

    const emptyArrayCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], browserTools: [] },
      },
    });
    await expect(plugin.getRequestSubAgents(emptyArrayCtx)).resolves.toEqual(
      [],
    );

    const missingCtx = makeRuntimeContext();
    await expect(plugin.getRequestSubAgents(missingCtx)).resolves.toEqual([]);
  });

  it('builds one sub-agent with one PluginTool per browserTool, model=subagent, JSON-schema converted to Zod, and tool docs in the prompt', async () => {
    const plugin = new PortalPlugin();
    const rtCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: {
          messages: [],
          browserTools: [OPEN_URL_TOOL, CLICK_TOOL],
        },
      },
    });

    const subAgents = await plugin.getRequestSubAgents(rtCtx);
    expect(subAgents).toHaveLength(1);

    const [sub] = subAgents;
    if (!sub) throw new Error('expected one sub-agent');
    expect(sub.name).toBe('Portal Agent');
    expect(sub.model).toBe('subagent');

    const tools = Array.isArray(sub.tools) ? sub.tools : [];
    expect(tools.map((t) => t.name)).toEqual([
      OPEN_URL_TOOL.name,
      CLICK_TOOL.name,
    ]);
    expect(tools[0]?.description).toBe(OPEN_URL_TOOL.description);

    // Schemas must be real Zod objects (from `z.fromJSONSchema`), not `z.any()`.
    const openUrlSchema = tools[0]?.schema;
    expect(openUrlSchema).toBeDefined();
    expect(openUrlSchema?.safeParse({ url: 'https://ixo.world' }).success).toBe(
      true,
    );
    expect(openUrlSchema?.safeParse({ url: 123 }).success).toBe(false);
    expect(openUrlSchema?.safeParse({}).success).toBe(false);

    const prompt =
      typeof sub.systemPrompt === 'string' ? sub.systemPrompt : '';
    expect(prompt).toContain('Portal Agent');
    expect(prompt).toContain(OPEN_URL_TOOL.name);
    expect(prompt).toContain(CLICK_TOOL.name);
  });

  it('browser-tool handler dispatches via callBrowserTool with session id, requestId-derived toolCallId, and matrix logging when roomId is set', async () => {
    const callBrowserToolMock = vi.mocked(callBrowserTool);
    const logActionToMatrixMock = vi.mocked(logActionToMatrix);
    callBrowserToolMock.mockClear();
    logActionToMatrixMock.mockClear();
    callBrowserToolMock.mockResolvedValueOnce({ navigated: true });

    const plugin = new PortalPlugin();
    const rtCtx = makeRuntimeContext({
      session: {
        id: 'sess-portal',
        client: 'portal',
        requestId: 'req-42',
        roomId: '!room:ixo.world',
      },
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], browserTools: [OPEN_URL_TOOL] },
      },
    });

    const [sub] = await plugin.getRequestSubAgents(rtCtx);
    if (!sub) throw new Error('expected one sub-agent');
    const tools = Array.isArray(sub.tools) ? sub.tools : [];
    const [browserTool] = tools;
    if (!browserTool) throw new Error('expected one tool');

    const args = { url: 'https://ixo.world', newTab: true };
    const result = await browserTool.handler(args, rtCtx);

    expect(result).toEqual({ navigated: true });
    expect(callBrowserToolMock).toHaveBeenCalledTimes(1);
    const callArgs = callBrowserToolMock.mock.calls[0]?.[0];
    expect(callArgs?.sessionId).toBe('sess-portal');
    expect(callArgs?.toolName).toBe(OPEN_URL_TOOL.name);
    expect(callArgs?.args).toEqual(args);
    expect(callArgs?.timeout).toBe(15_000);
    expect(callArgs?.toolCallId).toBe('tc-req-42');

    expect(logActionToMatrixMock).toHaveBeenCalledTimes(1);
    expect(logActionToMatrixMock.mock.calls[0]?.[1]).toEqual({
      roomId: '!room:ixo.world',
      threadId: 'sess-portal',
    });
  });

  it('handler skips matrix logging when no roomId is on the session', async () => {
    const callBrowserToolMock = vi.mocked(callBrowserTool);
    const logActionToMatrixMock = vi.mocked(logActionToMatrix);
    callBrowserToolMock.mockClear();
    logActionToMatrixMock.mockClear();
    callBrowserToolMock.mockResolvedValueOnce({ navigated: true });

    const plugin = new PortalPlugin();
    const rtCtx = makeRuntimeContext({
      session: {
        id: 'sess-no-room',
        client: 'portal',
        requestId: 'req-1',
      },
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], browserTools: [OPEN_URL_TOOL] },
      },
    });

    const [sub] = await plugin.getRequestSubAgents(rtCtx);
    if (!sub) throw new Error('expected one sub-agent');
    const tools = Array.isArray(sub.tools) ? sub.tools : [];
    const [browserTool] = tools;
    if (!browserTool) throw new Error('expected one tool');

    await browserTool.handler({ url: 'https://ixo.world' }, rtCtx);

    expect(callBrowserToolMock).toHaveBeenCalledTimes(1);
    expect(logActionToMatrixMock).not.toHaveBeenCalled();
  });
});
