import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import { describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '../plugin-api/types';
import {
  createCapabilityGateMiddleware,
  createToolRepetitionGuardMiddleware,
  createToolValidationMiddleware,
} from './middlewares';

type Visibility = NonNullable<PluginManifest['visibility']>;

describe('createCapabilityGateMiddleware', () => {
  function setup(loadedPlugins: string[]) {
    const mw = createCapabilityGateMiddleware({
      pluginByToolName: new Map([
        ['always_tool', 'always_plugin'],
        ['silent_tool', 'silent_plugin'],
        ['on_demand_tool', 'on_demand_plugin'],
        ['call_weather_planner_agent', 'weather'],
      ]),
      visibilityByToolName: new Map<string, Visibility>([
        ['always_tool', 'always'],
        ['silent_tool', 'silent'],
        ['on_demand_tool', 'on-demand'],
        ['call_weather_planner_agent', 'on-demand'],
      ]),
    });
    const wrap = mw.wrapModelCall;
    if (!wrap) throw new Error('wrapModelCall missing');
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const tools = [
      { name: 'list_capabilities' },
      { name: 'load_capability' },
      { name: 'always_tool' },
      { name: 'silent_tool' },
      { name: 'on_demand_tool' },
      { name: 'call_weather_planner_agent' },
    ];
    const invoke = () =>
      wrap({ state: { loadedPlugins }, tools } as never, handler as never);
    const passed = () =>
      (
        handler.mock.calls[0]?.[0] as { tools: Array<{ name: string }> }
      ).tools.map((t) => t.name);
    return { invoke, passed };
  }

  it('hides on-demand tools and sub-agents until their plugin is loaded', async () => {
    const { invoke, passed } = setup([]);
    await invoke();
    expect(passed()).toEqual([
      'list_capabilities',
      'load_capability',
      'always_tool',
      'silent_tool',
    ]);
  });

  it('exposes them once state.loadedPlugins names the plugin', async () => {
    const { invoke, passed } = setup(['on_demand_plugin', 'weather']);
    await invoke();
    expect(passed()).toContain('on_demand_tool');
    expect(passed()).toContain('call_weather_planner_agent');
  });
});

type FakeToolRequest = {
  toolCall: ToolCall;
  tool?: { name?: string };
  state: { messages: BaseMessage[] };
  runtime: Record<string, unknown>;
};

function makeRequest(
  overrides: Partial<FakeToolRequest> = {},
): FakeToolRequest {
  return {
    toolCall: { name: 'demo', args: { foo: 'bar' }, id: 'tc-1' },
    tool: { name: 'demo' },
    state: { messages: [] },
    runtime: {},
    ...overrides,
  };
}

describe('createToolValidationMiddleware', () => {
  it('turns a schema error into a corrective ToolMessage and rethrows others', async () => {
    const warn = vi.fn();
    const mw = createToolValidationMiddleware({
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');

    const schemaFailure = vi
      .fn()
      .mockRejectedValue(
        new Error('Received tool input did not match expected schema'),
      );
    const result = (await wrap(
      makeRequest() as never,
      schemaFailure as never,
    )) as ToolMessage;
    expect(result).toBeInstanceOf(ToolMessage);
    expect(result.tool_call_id).toBe('tc-1');
    expect(String(result.content)).toContain('"demo"');
    expect(String(result.content)).toContain('invalid parameters');
    expect(warn).toHaveBeenCalledOnce();

    const other = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(wrap(makeRequest() as never, other as never)).rejects.toThrow(
      'network down',
    );
  });

  it('strips ToolMessages of skip-listed tools before the next model call', () => {
    const mw = createToolValidationMiddleware({ skipToolNames: ['noisy'] });
    const before = mw.beforeModel as unknown as
      | ((state: unknown, runtime: unknown) => unknown)
      | undefined;
    if (!before) throw new Error('beforeModel missing');
    const state = {
      messages: [
        new HumanMessage('hi'),
        new ToolMessage({ content: 'x', tool_call_id: 't', name: 'noisy' }),
      ],
    };
    const out = before(state, {}) as { messages: BaseMessage[] };
    expect(out.messages.map((m) => m.type)).toEqual(['human']);
  });
});

describe('createToolRepetitionGuardMiddleware', () => {
  const priorFailure = (args: Record<string, unknown>): BaseMessage[] => [
    new AIMessage({
      content: '',
      tool_calls: [
        { name: 'write_file', args, id: 'tc-prior', type: 'tool_call' },
      ],
    }),
    new ToolMessage({
      content: 'Path must be under /workspace/data/.',
      tool_call_id: 'tc-prior',
      name: 'write_file',
      status: 'error',
    }),
  ];

  it('short-circuits an identical call that already failed, quoting the error', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');
    const handler = vi.fn();

    const result = (await wrap(
      makeRequest({
        toolCall: {
          name: 'write_file',
          // Same args, different key order — canonicalised before comparing.
          args: { content: 'x', path: '/workspace/tmp/x.js' },
          id: 'tc-now',
        },
        tool: { name: 'write_file' },
        state: {
          messages: [
            new HumanMessage('write it'),
            ...priorFailure({ path: '/workspace/tmp/x.js', content: 'x' }),
          ],
        },
      }) as never,
      handler as never,
    )) as ToolMessage;

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    expect(result.tool_call_id).toBe('tc-now');
    expect(String(result.content)).toContain(
      'Path must be under /workspace/data/.',
    );
  });

  it('lets a call with different args through', async () => {
    const mw = createToolRepetitionGuardMiddleware();
    const wrap = mw.wrapToolCall;
    if (!wrap) throw new Error('wrapToolCall missing');
    const handler = vi
      .fn()
      .mockResolvedValue(
        new ToolMessage({ content: 'ok', tool_call_id: 'tc-now' }),
      );

    await wrap(
      makeRequest({
        toolCall: {
          name: 'write_file',
          args: { path: '/workspace/data/x.js', content: 'x' },
          id: 'tc-now',
        },
        tool: { name: 'write_file' },
        state: {
          messages: priorFailure({ path: '/workspace/tmp/x.js', content: 'x' }),
        },
      }) as never,
      handler as never,
    );
    expect(handler).toHaveBeenCalledOnce();
  });
});
