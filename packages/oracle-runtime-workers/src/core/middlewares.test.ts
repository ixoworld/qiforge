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
import { SUMMARY_PREFIX } from './middlewares/summarization';

type Visibility = NonNullable<PluginManifest['visibility']>;

describe('createCapabilityGateMiddleware', () => {
  function setup(loadedPlugins: string[], preloadedPlugins?: Set<string>) {
    const mw = createCapabilityGateMiddleware({
      preloadedPlugins,
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

  it('admits a preloaded plugin with an empty state.loadedPlugins, and keeps hiding the rest', async () => {
    const { invoke, passed } = setup([], new Set(['on_demand_plugin']));
    await invoke();
    expect(passed()).toEqual([
      'list_capabilities',
      'load_capability',
      'always_tool',
      'silent_tool',
      'on_demand_tool',
    ]);
    expect(passed()).not.toContain('call_weather_planner_agent');
  });

  describe('tool calls', () => {
    function gate(preloadedPlugins?: Set<string>) {
      const warn = vi.fn();
      const mw = createCapabilityGateMiddleware({
        preloadedPlugins,
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
        logger: { log: vi.fn(), warn, error: vi.fn() },
      });
      const wrap = mw.wrapToolCall;
      if (!wrap) throw new Error('wrapToolCall missing');
      const ran = new ToolMessage({
        content: 'ran',
        tool_call_id: 'tc-1',
        name: 'x',
      });
      const call = async (name: string, loadedPlugins: string[] = []) => {
        const handler = vi.fn().mockResolvedValue(ran);
        const result = await wrap(
          {
            toolCall: { name, args: {}, id: 'tc-1' },
            tool: { name },
            state: { messages: [], loadedPlugins },
            runtime: {},
          } as never,
          handler as never,
        );
        return { result, ran: handler.mock.calls.length > 0 };
      };
      return { call, warn };
    }

    it('refuses a call to an on-demand tool or sub-agent whose plugin is not loaded, without running it', async () => {
      const { call, warn } = gate();
      for (const name of ['on_demand_tool', 'call_weather_planner_agent']) {
        const { result, ran } = await call(name);
        expect(ran).toBe(false);
        expect(result).toBeInstanceOf(ToolMessage);
        const refusal = result as ToolMessage;
        expect(refusal.status).toBe('error');
        expect(refusal.tool_call_id).toBe('tc-1');
        expect(refusal.name).toBe(name);
        expect(String(refusal.content)).toContain('was not run');
        expect(String(refusal.content)).toContain('load_capability');
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "refused a call to on_demand_tool: capability 'on_demand_plugin' is not loaded",
      );
    });

    it('runs the call once the plugin is loaded in state or preloaded for the turn', async () => {
      expect(
        (await gate().call('on_demand_tool', ['on_demand_plugin'])).ran,
      ).toBe(true);
      const preloaded = gate(new Set(['weather']));
      expect((await preloaded.call('call_weather_planner_agent')).ran).toBe(
        true,
      );
      expect((await preloaded.call('on_demand_tool')).ran).toBe(false);
    });

    it('never stands in the way of always, silent, meta or unknown tools', async () => {
      const { call, warn } = gate();
      for (const name of [
        'always_tool',
        'silent_tool',
        'load_capability',
        'not_a_bound_tool',
      ]) {
        expect((await call(name)).ran).toBe(true);
      }
      expect(warn).not.toHaveBeenCalled();
    });
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

  it('lets through the same call after a capability-gate refusal (the tool never ran)', async () => {
    const gate = createCapabilityGateMiddleware({
      pluginByToolName: new Map([['probe_run', 'probe']]),
      visibilityByToolName: new Map<string, Visibility>([
        ['probe_run', 'on-demand'],
      ]),
    });
    const gateWrap = gate.wrapToolCall;
    const guardWrap = createToolRepetitionGuardMiddleware().wrapToolCall;
    if (!gateWrap || !guardWrap) throw new Error('wrapToolCall missing');
    const refusal = (await gateWrap(
      makeRequest({
        toolCall: { name: 'probe_run', args: {}, id: 'tc-prior' },
        tool: { name: 'probe_run' },
      }) as never,
      vi.fn() as never,
    )) as ToolMessage;
    expect(refusal.status).toBe('error');

    const handler = vi.fn().mockResolvedValue('ran');
    await guardWrap(
      makeRequest({
        toolCall: { name: 'probe_run', args: {}, id: 'tc-now' },
        tool: { name: 'probe_run' },
        state: {
          messages: [
            new AIMessage({
              content: '',
              tool_calls: [
                {
                  name: 'probe_run',
                  args: {},
                  id: 'tc-prior',
                  type: 'tool_call',
                },
              ],
            }),
            refusal,
          ],
        },
      }) as never,
      handler as never,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

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

  describe('turn scope', () => {
    const retry = (messages: BaseMessage[], lookback?: number) => {
      const wrap = createToolRepetitionGuardMiddleware(
        lookback === undefined ? {} : { lookback },
      ).wrapToolCall;
      if (!wrap) throw new Error('wrapToolCall missing');
      const handler = vi
        .fn()
        .mockResolvedValue(
          new ToolMessage({ content: 'ok', tool_call_id: 'tc-now' }),
        );
      return {
        handler,
        run: () =>
          wrap(
            makeRequest({
              toolCall: {
                name: 'write_file',
                args: { path: '/workspace/tmp/x.js', content: 'x' },
                id: 'tc-now',
              },
              tool: { name: 'write_file' },
              state: { messages },
            }) as never,
            handler as never,
          ),
      };
    };
    const failed = () =>
      priorFailure({ path: '/workspace/tmp/x.js', content: 'x' });

    it('lets the call through when it failed in an earlier turn (the user may have fixed the cause)', async () => {
      const { run, handler } = retry([
        new HumanMessage('write it'),
        ...failed(),
        new AIMessage('That path is not allowed.'),
        new HumanMessage('I changed the policy, try again'),
      ]);
      await run();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('still blocks inside the turn however far back the failure is', async () => {
      const filler = Array.from({ length: 30 }, (_, i) => [
        new AIMessage({
          content: '',
          tool_calls: [
            { name: 'get_x', args: { i }, id: `r${i}`, type: 'tool_call' },
          ],
        }),
        new ToolMessage({
          content: 'ok',
          tool_call_id: `r${i}`,
          name: 'get_x',
        }),
      ]).flat();
      const { run, handler } = retry([
        new HumanMessage('write it'),
        ...failed(),
        ...filler,
      ]);
      const result = (await run()) as ToolMessage;
      expect(handler).not.toHaveBeenCalled();
      expect(result.status).toBe('error');
    });

    it('does not start a turn at the summary the summarizer writes mid-turn', async () => {
      const { run, handler } = retry([
        new HumanMessage({
          content: `${SUMMARY_PREFIX} The user asked to write a file.`,
          additional_kwargs: { lc_source: 'summarization' },
        }),
        ...failed(),
      ]);
      await run();
      expect(handler).not.toHaveBeenCalled();
      // The same history with the summary replaced by a real user message
      // after the failure is a new turn.
      const fresh = retry([...failed(), new HumanMessage('try again')]);
      await fresh.run();
      expect(fresh.handler).toHaveBeenCalledOnce();
    });

    it('honours an explicit lookback inside the turn', async () => {
      const { run, handler } = retry(
        [
          new HumanMessage('write it'),
          ...failed(),
          new AIMessage('thinking'),
          new AIMessage('still thinking'),
        ],
        2,
      );
      await run();
      expect(handler).toHaveBeenCalledOnce();
    });
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
