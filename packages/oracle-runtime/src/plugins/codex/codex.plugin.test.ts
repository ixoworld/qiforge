import { describe, expect, it } from 'vitest';
import { createTestRuntime } from '../../testing/create-test-runtime.js';
import { CodexPlugin } from './codex.plugin.js';

const config = {
  CODEX_AUTH_MODE: 'api_key',
  ORACLE_ENTITY_DID: 'did:ixo:oracle1',
};

const runtimeWith = (overrides: Record<string, unknown> = {}) =>
  createTestRuntime({
    plugins: [new CodexPlugin()],
    config: { ...config, ...overrides },
  });

describe('CodexPlugin', () => {
  it('registers a valid manifest and no colliding names', async () => {
    const runtime = await runtimeWith();

    runtime.assertManifestValid();
    runtime.assertNoCollisions();
    expect(runtime.getManifest('codex').title).toBe('Codex');
  });

  it('is discoverable on demand rather than costing prompt budget every turn', async () => {
    const runtime = await runtimeWith();
    expect(runtime.getManifest('codex').visibility).toBe('on-demand');
  });

  it('exposes the run and approval tools', async () => {
    const runtime = await runtimeWith();

    expect(
      runtime
        .listTools('codex')
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['codex_resolve_approval', 'codex_run_task']);
  });

  it('stays off until an operator picks an auth mode', () => {
    const plugin = new CodexPlugin();

    expect(plugin.autoDetect({})).toBe(false);
    expect(plugin.autoDetect({ CODEX_AUTH_MODE: 'api_key' })).toBe(true);
    // Credentials alone must not switch it on — that would pick a billing
    // model on the operator's behalf.
    expect(plugin.autoDetect({ OPENAI_API_KEY: 'sk-x' })).toBe(false);
  });

  it('fails the build when the tool policy leaves no guardrail', async () => {
    await expect(
      runtimeWith({
        CODEX_SANDBOX_MODE: 'dangerFullAccess',
        CODEX_APPROVAL_POLICY: 'never',
      }),
    ).rejects.toThrow(/removes every guardrail/u);
  });

  it('fails the build on an unknown auth mode instead of defaulting', async () => {
    await expect(runtimeWith({ CODEX_AUTH_MODE: 'chatgpt' })).rejects.toThrow(
      /invalid configuration/u,
    );
  });

  it('keeps every route behind UCAN auth', () => {
    expect(new CodexPlugin().getAuthExcludedRoutes()).toEqual([]);
  });
});
