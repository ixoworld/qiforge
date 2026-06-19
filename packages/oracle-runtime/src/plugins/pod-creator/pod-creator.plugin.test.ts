import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../manifest/validator.js';
import { makeRuntimeContext } from '../../registries/test-fixtures.js';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { PodCreatorPlugin } from './pod-creator.plugin.js';

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

describe('PodCreatorPlugin loads via createTestRuntime', () => {
  it('registers cleanly, lists as an on-demand capability, and exposes the orchestration tools', async () => {
    const rt = await createTestRuntime({
      plugins: [new PodCreatorPlugin()],
      config: {},
    });
    rt.assertNoCollisions();
    rt.assertManifestValid();
    expect(
      rt
        .listTools('pod-creator')
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'approve_pod_transaction',
      'assemble_blueprint',
      'compute_readiness',
      'confirm_pod_creation',
      'get_blueprint',
      'prepare_pod_transaction',
      'record_blueprint_section',
      'request_pod_signature',
      'start_pod_design',
    ]);
    const cap = rt.listCapabilities().find((c) => c.name === 'pod-creator');
    if (!cap) {
      throw new Error('pod-creator capability not listed');
    }
    expect(cap.visibility).toBe('on-demand');
    await rt.close();
  });
});

describe('PodCreatorPlugin getRequestSubAgents', () => {
  it('exposes the current stage specialist with a registry-loaded prompt', async () => {
    const plugin = new PodCreatorPlugin({
      capsuleContentFetcher: async () => '# Intent\n\nScore the request.',
    });
    const subs = await plugin.getRequestSubAgents(makeRuntimeContext());
    expect(subs.map((s) => s.name)).toEqual(['service_intent_scorer']);
    const prompt = subs[0]?.systemPrompt;
    if (typeof prompt !== 'string') {
      throw new Error('expected a string systemPrompt');
    }
    expect(prompt).toContain('Score the request.');
  });
});
