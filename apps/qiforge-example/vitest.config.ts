import { defineConfig, mergeConfig } from 'vitest/config';
import nestConfig from '@ixo/vitest-config/nest';

/**
 * Two modes — mirrors `packages/oracle-runtime/vitest.config.ts`:
 *  - default (`vitest run`)         — unit tests (none in this app today).
 *  - `int`   (`vitest run --mode int`) — integration tests, real Nest boot.
 *
 * `mergeConfig` concats arrays (`include`, `setupFiles`), so the integration
 * block overwrites those fields explicitly rather than extending the unit-test
 * defaults — keeps `pnpm test` from picking up `.int.test.ts` files.
 */
export default defineConfig(({ mode }) => {
  if (mode === 'int') {
    const merged = mergeConfig(nestConfig, {});
    merged.test = {
      ...merged.test,
      include: ['test/**/*.int.test.ts'],
      exclude: ['node_modules', 'dist'],
      // Real boot + upstream calls run 5-30s each; pushing past 60s argues
      // for cutting scope, not raising this further.
      testTimeout: 120_000,
      hookTimeout: 120_000,
      setupFiles: ['./test/integration/setup.ts'],
      // Sequential file execution — every test file boots a real oracle with
      // the same Matrix admin user; concurrent boots collide on one-time key
      // uploads at the homeserver.
      fileParallelism: false,
    };
    return merged;
  }

  const merged = mergeConfig(nestConfig, {});
  merged.test = {
    ...merged.test,
    // The constitution test lives in `test/` rather than beside a module: it
    // exercises the shipped `domain.md`, which belongs to the app rather than
    // to any one file in it.
    include: ['test/**/*.test.ts'],
    // `*.int.test.ts` also ends in `.test.ts`, so the integration suite has to
    // be excluded explicitly or `pnpm test` would try to boot a real oracle.
    exclude: ['node_modules', 'dist', 'test/**/*.int.test.ts'],
  };
  return merged;
});
