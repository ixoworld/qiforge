/**
 * `IxoTransactionPlugin` is in the bundle every oracle spreads (the
 * Companion passes only `BUNDLED_WORKERS_PLUGINS`), and a plugin listed
 * twice is loaded once: its last instance.
 */
import { describe, expect, it } from 'vitest';
import { createRuntimeCore, resolvePlugins } from '../../core';
import { makeEnv } from '../../core/test-fixtures';
import { BUNDLED_WORKERS_PLUGINS } from '..';
import { IxoTransactionPlugin } from './ixo-transaction.plugin';

describe('IxoTransactionPlugin in BUNDLED_WORKERS_PLUGINS', () => {
  it('is bundled once, before the POD creator that hands DAO steps to it', () => {
    const names = BUNDLED_WORKERS_PLUGINS.map((plugin) => plugin.name);
    expect(names.filter((name) => name === 'ixo-transaction')).toHaveLength(1);
    const bundled = BUNDLED_WORKERS_PLUGINS.find(
      (plugin) => plugin.name === 'ixo-transaction',
    );
    expect(bundled).toBeInstanceOf(IxoTransactionPlugin);
    expect(names.indexOf('ixo-transaction')).toBeLessThan(
      names.indexOf('pod-creator'),
    );
  });

  it('boots in the bundle with mainnet signing off', async () => {
    const core = createRuntimeCore({
      config: { name: 'TestOracle' },
      plugins: [...BUNDLED_WORKERS_PLUGINS],
      env: makeEnv(),
    });
    await expect(core.warm()).resolves.toBeUndefined();
    expect([...core.availablePlugins]).toContain('ixo-transaction');
    expect(core.validatedEnv.IXO_TRANSACTION_ALLOW_MAINNET).toBe('false');
  });

  it('loads one instance of a plugin listed twice: the last one', () => {
    const own = new IxoTransactionPlugin();
    // After the spread, a host's own instance is the one loaded.
    const after = resolvePlugins({
      bundled: [...BUNDLED_WORKERS_PLUGINS, own],
      env: makeEnv(),
    }).loaded.filter((plugin) => plugin.name === 'ixo-transaction');
    expect(after).toEqual([own]);
    // Before the spread (as the example Worker used to list it), the
    // bundled instance is the one loaded.
    const before = resolvePlugins({
      bundled: [own, ...BUNDLED_WORKERS_PLUGINS],
      env: makeEnv(),
    }).loaded.filter((plugin) => plugin.name === 'ixo-transaction');
    expect(before).toHaveLength(1);
    expect(before[0]).not.toBe(own);
  });
});
