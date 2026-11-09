import { describe, expect, it, vi } from 'vitest';
import { createRuntimeCore } from '../../core';
import { validateManifest } from '../../core/manifest';
import { SkillsPlugin } from '../../core/plugins/skills';
import { makeEnv, makeRuntimeContext } from '../../core/test-fixtures';
import { createMemoryUserKv } from '../../core/user-kv';
import type { RuntimeContext, UserKvSurface } from '../../plugin-api/types';
import { KvBlueprintStore } from './blueprint-store';
import type { CapsuleFetchContext } from './capsule-content-client';
import { PodCreatorPlugin } from './pod-creator.plugin';
import { computeSubAgentToolName } from '../../core/subagent-as-tool';
import { ALL_ROLE_IDS, byName, THREAD } from './test-fixtures';

/** A request context whose host provides `ctx.kv`. */
const ctxWithKv = (
  kv: UserKvSurface,
  over: Partial<RuntimeContext> = {},
): RuntimeContext => makeRuntimeContext(over, { ambient: { kv } });

/** A user store whose default thread has an open design. */
async function openDesign(): Promise<UserKvSurface> {
  const kv = createMemoryUserKv();
  await new KvBlueprintStore(kv).init(THREAD, 'Solar POD');
  return kv;
}

describe('PodCreatorPlugin identity', () => {
  it('has the expected identity, manifest, and config schema', () => {
    const plugin = new PodCreatorPlugin();
    expect(plugin.name).toBe('pod-creator');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.manifest.visibility).toBe('on-demand');
    expect(plugin.manifest.category).toBe('automation');
    expect(plugin.softDependsOn).toContain('agui');
    expect(validateManifest(plugin.manifest, plugin.name).valid).toBe(true);

    // configSchema accepts an empty object — every key is optional/defaulted —
    // so adding pod-creator to a bundled set never breaks an existing oracle.
    const parsed = plugin.configSchema.safeParse({});
    if (!parsed.success) {
      throw new Error(
        `expected configSchema to accept {}, got: ${parsed.error.message}`,
      );
    }
    expect(parsed.data.POD_CREATOR_ALLOW_MAINNET).toBe(false);

    // The mainnet gate coerces the string env form to a boolean.
    const enabled = plugin.configSchema.safeParse({
      POD_CREATOR_ALLOW_MAINNET: 'true',
    });
    if (!enabled.success) {
      throw new Error(
        `expected 'true' to parse, got: ${enabled.error.message}`,
      );
    }
    expect(enabled.data.POD_CREATOR_ALLOW_MAINNET).toBe(true);
  });
});

describe('PodCreatorPlugin loads via createRuntimeCore', () => {
  it('registers cleanly beside the skills plugin, lists as an on-demand capability, and exposes the conductor + create tools', async () => {
    const core = createRuntimeCore({
      config: { name: 'PodOracle' },
      plugins: [new SkillsPlugin(), new PodCreatorPlugin()],
      env: makeEnv({ POD_CREATOR_ALLOW_MAINNET: 'true' }),
    });
    // warm() runs the collision checks (tools, sub-agents, shared state,
    // decisions) and the manifest example cross-check; it rejects on a clash.
    await expect(core.warm()).resolves.toBeUndefined();
    expect([...core.availablePlugins]).toContain('pod-creator');
    expect(
      core.registries.tools.toolNamesForPlugin('pod-creator').sort(),
    ).toEqual([
      'add_pod_domain_card',
      'approve_pod_transaction',
      'assemble_blueprint',
      'compute_readiness',
      'confirm_pod_creation',
      'get_blueprint',
      'prepare_pod_transaction',
      'request_pod_signature',
      'start_pod_design',
    ]);
    const manifest = core.registries.manifests
      .collect()
      .find((m) => m.pluginName === 'pod-creator');
    expect(manifest?.manifest.visibility).toBe('on-demand');
    // The plugin's key folds into the validated env (string → boolean).
    expect(core.validatedEnv.POD_CREATOR_ALLOW_MAINNET).toBe(true);
  });
});

describe('PodCreatorPlugin getRequestSubAgents', () => {
  it('contributes nothing on a turn of a thread without a design, even with a registry fetcher', async () => {
    const fetcher = vi.fn(async () => '# Role');
    const plugin = new PodCreatorPlugin({ capsuleContentFetcher: fetcher });
    expect(
      await plugin.getRequestSubAgents(ctxWithKv(createMemoryUserKv())),
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('binds every specialist once a design is open, each with its registry-loaded prompt', async () => {
    const plugin = new PodCreatorPlugin({
      capsuleContentFetcher: async () => '# Intent\n\nScore the request.',
    });
    const subs = await plugin.getRequestSubAgents(
      ctxWithKv(await openDesign()),
    );
    expect(subs.map((s) => s.name)).toEqual(ALL_ROLE_IDS);
    const prompt = subs[0]?.systemPrompt;
    if (typeof prompt !== 'string') {
      throw new Error('expected a string systemPrompt');
    }
    expect(prompt).toContain('Score the request.');
  });

  it('degrades to the built-in prompts when no capsule fetcher is configured (the bundled default)', async () => {
    const plugin = new PodCreatorPlugin();
    const subs = await plugin.getRequestSubAgents(
      ctxWithKv(await openDesign()),
    );
    expect(subs.map((s) => s.name)).toEqual(ALL_ROLE_IDS);
    const prompt = subs[0]?.systemPrompt;
    if (typeof prompt !== 'string') {
      throw new Error('expected a string systemPrompt');
    }
    expect(prompt).toContain('built-in summary');
  });

  it('reads the registry URL and network from the sibling config keys', async () => {
    const seen: CapsuleFetchContext[] = [];
    const plugin = new PodCreatorPlugin({
      capsuleContentFetcher: async (_name, ctx) => {
        seen.push(ctx);
        return '# Intent';
      },
    });
    await plugin.getRequestSubAgents(
      ctxWithKv(await openDesign(), {
        config: {
          SKILLS_CAPSULES_BASE_URL: 'https://capsules.example',
          NETWORK: 'devnet',
        },
      }),
    );
    expect(seen[0]?.baseUrl).toBe('https://capsules.example');
    expect(seen[0]?.network).toBe('devnet');
    expect(seen[0]?.headers['X-IXO-Network']).toBe('devnet');
  });

  it('advances the specialists shown to the model within the turn, through the plugin tools and the host store', async () => {
    const kv = createMemoryUserKv();
    const plugin = new PodCreatorPlugin({
      capsuleContentFetcher: async () => '# Role',
    });
    const tools = plugin.getTools();
    await byName(tools, 'start_pod_design').handler(
      { brief: 'Solar POD' },
      ctxWithKv(kv),
    );
    const subs = await plugin.getRequestSubAgents(ctxWithKv(kv));
    const [stageMiddleware] = await plugin.getRequestMiddlewares(ctxWithKv(kv));
    const wrapModelCall = stageMiddleware?.wrapModelCall;
    const wrapToolCall = stageMiddleware?.wrapToolCall;
    if (!wrapModelCall || !wrapToolCall)
      throw new Error('expected the stage middleware');
    /** The specialist tools the model is shown on its next model call. */
    const shown = async (): Promise<string[]> => {
      const handler = vi.fn(async () => ({ ok: true }));
      await wrapModelCall(
        {
          tools: subs.map((sub) => ({
            name: computeSubAgentToolName(sub.name),
          })),
          messages: [],
          state: {},
        } as never,
        handler as never,
      );
      const sent = handler.mock.calls[0] as unknown as [
        { tools: Array<{ name: string }> },
      ];
      return sent[0].tools.map((t) => t.name).sort();
    };
    expect(await shown()).toEqual(['call_service_intent_scorer_agent']);

    // The conductor calls the scorer; inside, the scorer records its section.
    const scorer = subs.find((sub) => sub.name === 'service_intent_scorer');
    const scorerTools = Array.isArray(scorer?.tools) ? scorer.tools : [];
    await wrapToolCall(
      {
        toolCall: {
          id: 's1',
          name: 'call_service_intent_scorer_agent',
          args: { task: 'score' },
        },
        state: { messages: [] },
      } as never,
      (async () => {
        await byName(scorerTools, 'submit_section').handler(
          { content: { score: 0.9 } },
          ctxWithKv(kv),
        );
        return { content: 'recorded' };
      }) as never,
    );

    expect(await shown()).toEqual([
      'call_claims_architect_agent',
      'call_service_architect_agent',
      'call_ucan_rights_architect_agent',
    ]);
    expect(await kv.get('pod-creator/blueprints', THREAD)).toMatchObject({
      brief: 'Solar POD',
    });
  });
});

describe('PodCreatorPlugin on a host without ctx.kv', () => {
  it('the tools refuse loudly instead of keeping the design in memory; the per-turn hook contributes nothing', async () => {
    const plugin = new PodCreatorPlugin();
    await expect(
      byName(plugin.getTools(), 'start_pod_design').handler(
        { brief: 'x' },
        makeRuntimeContext(),
      ),
    ).rejects.toThrow(/ctx\.kv/);
    // The per-turn hook stays silent: nothing to build, nothing to log.
    expect(await plugin.getRequestSubAgents(makeRuntimeContext())).toEqual([]);
    expect(plugin.getRequestMiddlewares(makeRuntimeContext())).toEqual([]);
  });
});
