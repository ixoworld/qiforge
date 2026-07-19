import { describe, expect, it } from 'vitest';
import { SubAgentRegistry } from './subagent-registry.js';
import {
  makeBuildCtx,
  makePlugin,
  makeRuntimeContext,
  makeSubAgent,
} from './test-fixtures.js';

describe('SubAgentRegistry', () => {
  it('collects sub-agents from a single plugin', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );

    const collected = await reg.collect(makeBuildCtx());

    expect(collected).toHaveLength(1);
    expect(collected[0]?.subAgent.name).toBe('call_memory_agent');
    expect(collected[0]?.pluginName).toBe('memory');
  });

  it('tags each entry with its contributing plugin name', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );
    reg.register(
      makePlugin({
        name: 'portal',
        getSubAgents: () => [makeSubAgent('call_portal_agent')],
      }),
    );

    const collected = await reg.collect(makeBuildCtx());

    expect(collected.map((c) => `${c.pluginName}:${c.subAgent.name}`)).toEqual([
      'memory:call_memory_agent',
      'portal:call_portal_agent',
    ]);
    reg.assertNoCollisions();
  });

  it('forwards the supplied PluginContext to plugin getSubAgents', async () => {
    const reg = new SubAgentRegistry();
    let received: string | null = null;
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: (ctx) => {
          received = ctx.identity.name;
          return [makeSubAgent('call_memory_agent')];
        },
      }),
    );

    await reg.collect(
      makeBuildCtx({
        identity: {
          name: 'OracleX',
          org: 'Acme',
          description: 'd',
          entityDid: 'did:ixo:x',
        },
      }),
    );
    expect(received).toBe('OracleX');
  });

  it('throws on sub-agent name collision, naming both plugins', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'memory',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );
    reg.register(
      makePlugin({
        name: 'memory-experimental',
        getSubAgents: () => [makeSubAgent('call_memory_agent')],
      }),
    );

    await reg.collect(makeBuildCtx());

    expect(() => reg.assertNoCollisions()).toThrow(/call_memory_agent/);
    expect(() => reg.assertNoCollisions()).toThrow(/memory/);
    expect(() => reg.assertNoCollisions()).toThrow(/memory-experimental/);
  });

  it('throws when assertNoCollisions is called before collect', () => {
    const reg = new SubAgentRegistry();
    expect(() => reg.assertNoCollisions()).toThrow(/before collect/);
  });

  it('merges boot-time getSubAgents with request-time getRequestSubAgents when rtCtx is supplied', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'agui',
        getSubAgents: () => [makeSubAgent('call_agui_static_agent')],
        getRequestSubAgents: (rtCtx) => {
          const actions =
            (rtCtx.history.state as { agActions?: string[] }).agActions ?? [];
          return actions.map((a) => makeSubAgent(`call_agui_${a}_agent`));
        },
      }),
    );

    const rtCtx = makeRuntimeContext({
      history: {
        messages: [],
        recent: () => [],
        userContext: {},
        state: { messages: [], agActions: ['plan'] },
      },
    });
    const collected = await reg.collect(makeBuildCtx(), rtCtx);
    expect(collected.map((c) => c.subAgent.name)).toEqual([
      'call_agui_static_agent',
      'call_agui_plan_agent',
    ]);
  });

  it('runs request-time hooks concurrently while preserving registration order', async () => {
    const reg = new SubAgentRegistry();
    const started: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    reg.register(
      makePlugin({
        name: 'slow',
        getRequestSubAgents: async () => {
          started.push('slow');
          await slowGate;
          return [makeSubAgent('slow_agent')];
        },
      }),
    );
    reg.register(
      makePlugin({
        name: 'fast',
        getRequestSubAgents: () => {
          started.push('fast');
          return [makeSubAgent('fast_agent')];
        },
      }),
    );

    const pending = reg.collectRequest(makeRuntimeContext());
    await Promise.resolve();
    expect(started).toEqual(['slow', 'fast']);

    releaseSlow?.();
    const collected = await pending;
    expect(collected.map((c) => c.subAgent.name)).toEqual([
      'slow_agent',
      'fast_agent',
    ]);
  });

  it("rejects onRefusal 'retry-once' without readOnly at boot collection", () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'editor',
        getSubAgents: () => [
          makeSubAgent('call_editor_agent', { onRefusal: 'retry-once' }),
        ],
      }),
    );

    expect(() => reg.collectBoot(makeBuildCtx())).toThrow(
      /retry-once.*readOnly/,
    );
  });

  it("rejects onRefusal 'retry-once' without readOnly at request collection", async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'agui',
        getRequestSubAgents: () => [
          makeSubAgent('call_agui_agent', { onRefusal: 'retry-once' }),
        ],
      }),
    );

    await expect(reg.collectRequest(makeRuntimeContext())).rejects.toThrow(
      /retry-once.*readOnly/,
    );
  });

  it("accepts onRefusal 'retry-once' when readOnly is declared", () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'search',
        getSubAgents: () => [
          makeSubAgent('call_search_agent', {
            onRefusal: 'retry-once',
            readOnly: true,
          }),
        ],
      }),
    );

    expect(reg.collectBoot(makeBuildCtx())).toHaveLength(1);
  });

  it('keeps request-time sub-agents out of shared boot-scoped introspection', async () => {
    const reg = new SubAgentRegistry();
    reg.register(
      makePlugin({
        name: 'agui',
        getSubAgents: () => [makeSubAgent('Baseline')],
        getRequestSubAgents: () => [makeSubAgent('Request Scoped')],
      }),
    );

    const withRequest = await reg.collect(makeBuildCtx(), makeRuntimeContext());
    expect(withRequest.map((c) => c.subAgent.name)).toEqual([
      'Baseline',
      'Request Scoped',
    ]);

    // The singleton helper reflects boot-time contributions only — one
    // request's dynamic sub-agents never leak into another's view.
    expect(reg.subAgentNamesForPlugin('agui')).toEqual(['call_baseline_agent']);
  });
});
