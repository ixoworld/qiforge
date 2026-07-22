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

/** What `zod-to-json-schema`'s default `$refStrategy: 'root'` emits for a
 * subschema used twice — a JSON pointer `z.fromJSONSchema` cannot resolve. */
const POINTER_REF_TOOL: BrowserToolCall = {
  name: 'apply_survey_ops',
  description: 'Apply a batch of operations to an open survey.',
  schema: {
    type: 'object',
    properties: {
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: { questionId: { type: 'string' } },
        },
      },
      focus: { $ref: '#/properties/ops/items/properties/questionId' },
    },
    required: ['ops'],
  },
};

const UNCONVERTIBLE_TOOL: BrowserToolCall = {
  name: 'broken_tool',
  description: 'Declares a schema the runtime cannot convert.',
  schema: {
    type: 'object',
    properties: { x: { $ref: 'https://example.com/remote.json' } },
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

  it('uses only the request-time tool builder (no boot-time getTools / getSubAgents)', () => {
    const plugin = new PortalPlugin();
    expect(plugin.getTools).toBeUndefined();
    expect(plugin.getSubAgents).toBeUndefined();
    expect(plugin.getRequestSubAgents).toBeUndefined();
    expect(typeof plugin.getRequestTools).toBe('function');
  });

  it('returns no tools when state.browserTools is empty or absent', async () => {
    const plugin = new PortalPlugin();

    const emptyArrayCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], browserTools: [] },
      },
    });
    await expect(plugin.getRequestTools(emptyArrayCtx)).resolves.toEqual([]);

    const missingCtx = makeRuntimeContext();
    await expect(plugin.getRequestTools(missingCtx)).resolves.toEqual([]);
  });

  it('builds one PluginTool per browserTool, JSON-schema converted to Zod', async () => {
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

    const tools = await plugin.getRequestTools(rtCtx);
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
  });

  it('builds a tool from a schema carrying JSON-pointer $refs', async () => {
    const plugin = new PortalPlugin();
    const rtCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], browserTools: [POINTER_REF_TOOL] },
      },
    });

    const tools = await plugin.getRequestTools(rtCtx);
    expect(tools.map((t) => t.name)).toEqual([POINTER_REF_TOOL.name]);
    expect(
      tools[0]?.schema.safeParse({ ops: [{ questionId: 'q1' }], focus: 'q1' })
        .success,
    ).toBe(true);
  });

  it('drops a tool whose schema cannot be converted, keeping the others', async () => {
    const plugin = new PortalPlugin();
    const rtCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: {
          messages: [],
          browserTools: [UNCONVERTIBLE_TOOL, OPEN_URL_TOOL],
        },
      },
    });

    const tools = await plugin.getRequestTools(rtCtx);
    expect(tools.map((t) => t.name)).toEqual([OPEN_URL_TOOL.name]);
  });

  it('tool handler dispatches via callBrowserTool with session id, requestId-derived toolCallId, and matrix logging when roomId is set', async () => {
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

    const tools = await plugin.getRequestTools(rtCtx);
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

    const tools = await plugin.getRequestTools(rtCtx);
    const [browserTool] = tools;
    if (!browserTool) throw new Error('expected one tool');

    await browserTool.handler({ url: 'https://ixo.world' }, rtCtx);

    expect(callBrowserToolMock).toHaveBeenCalledTimes(1);
    expect(logActionToMatrixMock).not.toHaveBeenCalled();
  });
});
