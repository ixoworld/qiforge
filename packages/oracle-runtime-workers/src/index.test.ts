/**
 * The public entry point: what a host passes to `createOracleWorker` must
 * reach the runtime core unchanged. Runs under workerd because the entry
 * point pulls in the Durable Object classes.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeEnv, makeManifest, makePlugin } from './core/test-fixtures';
import type { OracleWorkerEnv } from './do/contracts';
import { createOracleWorker } from './index';

describe('createOracleWorker', () => {
  it('forwards manifestOverrides to the core, so a host can make a plugin always visible', () => {
    const plugin = makePlugin({
      name: 'portal-like',
      manifest: makeManifest({
        visibility: 'on-demand',
        summary: 'Drives the host app.',
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const worker = createOracleWorker({
        config: { name: 'TestOracle', org: 'Acme', description: 'a test' },
        plugins: [plugin],
        manifestOverrides: {
          'portal-like': {
            visibility: 'always',
            summary: 'Drives the Portal.',
          },
          ghost: { visibility: 'always' },
        },
      });
      const env = makeEnv() as unknown as OracleWorkerEnv;
      const core = worker.core(env);
      const registered = core.registries.manifests
        .collect()
        .find((m) => m.pluginName === 'portal-like');
      // Shallow merge: the overridden keys win, the rest of the authored
      // manifest stands.
      expect(registered?.manifest).toMatchObject({
        visibility: 'always',
        summary: 'Drives the Portal.',
        title: 'Test Plugin',
        whenToUse: ['always for testing'],
      });
      // A key that names no loaded plugin is reported, not applied.
      expect(
        warn.mock.calls.some(([line]) =>
          String(line).includes("manifestOverrides references 'ghost'"),
        ),
      ).toBe(true);
      // Same env object → the same memoised core, overrides included.
      expect(worker.core(env)).toBe(core);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves manifests untouched when no overrides are given', () => {
    const plugin = makePlugin({
      name: 'plain',
      manifest: makeManifest({ visibility: 'on-demand' }),
    });
    const worker = createOracleWorker({
      config: { name: 'TestOracle' },
      plugins: [plugin],
    });
    const core = worker.core(makeEnv() as unknown as OracleWorkerEnv);
    expect(
      core.registries.manifests.collect().find((m) => m.pluginName === 'plain')
        ?.manifest.visibility,
    ).toBe('on-demand');
  });
});
